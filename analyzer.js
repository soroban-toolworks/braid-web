/**
 * Braid's analysis, in the browser.
 *
 * This is a port of `braid-core`, walking a real Rust syntax tree from
 * tree-sitter rather than doing anything approximate with regexes. It exists so
 * the page can analyse a contract you paste into it, with no toolchain and no
 * server — the Rust CLI remains the authoritative implementation for CI.
 *
 * Two implementations of the same rules will drift unless something stops them.
 * `conformance.mjs` runs this port over the same fixture corpus as the Rust
 * tests and asserts the reports are byte-identical, so drift fails the build.
 *
 * Anything changed here must be changed in crates/braid-core, and vice versa.
 */

export const SCHEMA_VERSION = 1;

/** Everything under instance() lives in one ledger entry — the contract instance. */
export const INSTANCE_DOMAIN = '<contract instance>';

const READ_METHODS = new Set(['get', 'try_get', 'has', 'extend_ttl', 'bump']);
const WRITE_METHODS = new Set(['set', 'remove', 'update']);
const DURABILITIES = new Set(['instance', 'persistent', 'temporary']);

/** Seeing through these leaves the binding a key argument actually came from. */
const TRANSPARENT = new Set(['clone', 'into', 'to_owned', 'as_ref', 'copied', 'cloned']);

const ADMIN_PREFIXES = [
  'set_', 'init', '__constructor', 'initialize', 'upgrade', 'migrate',
  'configure', 'config', 'pause', 'unpause', 'transfer_admin',
  'set_config', 'rotate', 'register_asset',
];

/** A function that can only run once cannot race anything. */
const RUNS_ONCE = new Set(['__constructor', 'initialize', 'init']);

function accessOf(method) {
  if (READ_METHODS.has(method)) return 'read';
  if (WRITE_METHODS.has(method)) return 'write';
  return null;
}

function isAdminPath(name) {
  return ADMIN_PREFIXES.some(p => name.startsWith(p) || name === p);
}

// ------------------------------------------------------------------- walking

function children(node) {
  const out = [];
  for (let i = 0; i < node.childCount; i++) out.push(node.child(i));
  return out;
}

function descend(node, visit) {
  visit(node);
  for (const c of children(node)) descend(c, visit);
}

/** `&x`, `(x)` and grouping all wrap the expression we actually care about. */
function strip(node) {
  if (!node) return node;
  if (node.type === 'reference_expression' || node.type === 'parenthesized_expression') {
    return strip(node.childForFieldName('value') ?? node.namedChild(0));
  }
  return node;
}

/** Collapse whitespace so an expression reads the same as the Rust renderer prints it. */
function text(node) {
  return node ? node.text.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Recognise `env.storage().persistent().set(...)`.
 *
 * Matching the whole receiver chain rather than the method name alone is what
 * keeps `map.get(k)` and `vec.set(i, v)` out of the results.
 */
function storageTarget(call) {
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'field_expression') return null;

  const method = text(fn.childForFieldName('field'));
  const access = accessOf(method);
  if (!access) return null;

  const durCall = fn.childForFieldName('value');
  if (!durCall || durCall.type !== 'call_expression') return null;
  const durFn = durCall.childForFieldName('function');
  if (!durFn || durFn.type !== 'field_expression') return null;
  const durability = text(durFn.childForFieldName('field'));
  if (!DURABILITIES.has(durability)) return null;

  const storageCall = durFn.childForFieldName('value');
  if (!storageCall || storageCall.type !== 'call_expression') return null;
  const storageFn = storageCall.childForFieldName('function');
  if (!storageFn || storageFn.type !== 'field_expression') return null;
  if (text(storageFn.childForFieldName('field')) !== 'storage') return null;

  return { durability, access, method, methodNode: fn.childForFieldName('field') };
}

/** Split `DataKey::Balance(addr)` into its root and the origin of each argument. */
function decomposeKey(node) {
  const n = strip(node);
  if (!n) return { root: '', args: [] };

  switch (n.type) {
    case 'identifier':
    case 'scoped_identifier':
      return { root: text(n), args: [] };

    case 'call_expression': {
      const fn = n.childForFieldName('function');
      const args = n.childForFieldName('arguments');
      const list = [];
      for (let i = 0; i < (args?.namedChildCount ?? 0); i++) {
        list.push(argOrigin(args.namedChild(i)));
      }
      return { root: text(fn), args: list };
    }

    case 'struct_expression': {
      const body = n.childForFieldName('body');
      const list = [];
      for (let i = 0; i < (body?.namedChildCount ?? 0); i++) {
        const f = body.namedChild(i);
        list.push(argOrigin(f.childForFieldName('value') ?? f));
      }
      return { root: text(n.childForFieldName('name')), args: list };
    }

    // symbol_short!("balance") and friends are constant keys.
    case 'macro_invocation':
    case 'string_literal':
    case 'integer_literal':
      return { root: text(n), args: [] };

    case 'tuple_expression': {
      const list = [];
      for (let i = 0; i < n.namedChildCount; i++) list.push(argOrigin(n.namedChild(i)));
      return { root: '<tuple>', args: list };
    }

    default:
      return { root: text(n), args: [{ kind: 'opaque', text: text(n) }] };
  }
}

/** Reduce a key argument to the name it came from, or record that we cannot. */
function argOrigin(node) {
  const n = strip(node);
  if (!n) return { kind: 'opaque', text: '' };

  if (n.type === 'identifier') return { kind: 'ident', name: text(n) };
  if (n.type === 'scoped_identifier') return { kind: 'opaque', text: text(n) };

  if (n.type === 'call_expression') {
    const fn = n.childForFieldName('function');
    if (fn?.type === 'field_expression') {
      const method = text(fn.childForFieldName('field'));
      // `addr.clone()` is still `addr`; `env.ledger().sequence()` is not a binding.
      if (TRANSPARENT.has(method)) return argOrigin(fn.childForFieldName('value'));
    }
    return { kind: 'opaque', text: text(n) };
  }

  if (n.type === 'type_cast_expression') return argOrigin(n.childForFieldName('value'));
  return { kind: 'opaque', text: text(n) };
}

/** Does this expression read a storage key? Used to spot counters. */
function storageGetKey(node) {
  let found = null;
  descend(node, n => {
    if (found || n.type !== 'call_expression') return;
    const t = storageTarget(n);
    if (t && t.access === 'read') {
      const args = n.childForFieldName('arguments');
      if (args?.namedChildCount) found = decomposeKey(args.namedChild(0)).root;
    }
  });
  return found;
}

/** The name of any function called in this expression. */
function calledFnName(node) {
  let found = null;
  descend(node, n => {
    if (found || n.type !== 'call_expression') return;
    const fn = n.childForFieldName('function');
    if (fn?.type === 'identifier') found = text(fn);
    else if (fn?.type === 'scoped_identifier') {
      found = text(fn).split('::').pop();
    }
  });
  return found;
}

function patternIdents(node, out = []) {
  if (!node) return out;
  if (node.type === 'identifier') { out.push(text(node)); return out; }
  for (const c of children(node)) patternIdents(c, out);
  return out;
}

// -------------------------------------------------------------------- scanning

function scanFunction(fnNode, file, inContractImpl) {
  const nameNode = fnNode.childForFieldName('name');
  const name = text(nameNode);
  const isPub = children(fnNode).some(c => c.type === 'visibility_modifier');

  const params = new Set();
  const paramsNode = fnNode.childForFieldName('parameters');
  if (paramsNode) {
    for (let i = 0; i < paramsNode.namedChildCount; i++) {
      const p = paramsNode.namedChild(i);
      if (p.type === 'parameter') patternIdents(p.childForFieldName('pattern'), []).forEach(n => params.add(n));
    }
  }

  const lets = [];
  const accesses = [];
  const body = fnNode.childForFieldName('body');
  if (body) {
    descend(body, n => {
      if (n.type === 'let_declaration') {
        const value = n.childForFieldName('value');
        if (value) {
          const fromStorageKey = storageGetKey(value);
          const fromCall = calledFnName(value);
          const line = n.startPosition.row + 1;
          for (const nm of patternIdents(n.childForFieldName('pattern'), [])) {
            lets.push({ name: nm, line, fromStorageKey, fromCall });
          }
        }
        return;
      }
      if (n.type !== 'call_expression') return;
      const t = storageTarget(n);
      if (!t) return;

      const args = n.childForFieldName('arguments');
      const pos = t.methodNode.startPosition;
      if (args?.namedChildCount) {
        const { root, args: keyArgs } = decomposeKey(args.namedChild(0));
        accesses.push({
          line: pos.row + 1, column: pos.column + 1,
          durability: t.durability, access: t.access,
          keyExpr: text(strip(args.namedChild(0))), keyRoot: root, keyArgs,
        });
      } else if (t.method === 'extend_ttl') {
        // instance().extend_ttl(a, b) names no key: the entry is the instance.
        accesses.push({
          line: pos.row + 1, column: pos.column + 1,
          durability: t.durability, access: t.access,
          keyExpr: '<contract instance>', keyRoot: '<instance>', keyArgs: [],
        });
      }
    });
  }

  return { name, file, line: nameNode ? nameNode.startPosition.row + 1 : 0,
           entryPoint: isPub && inContractImpl, params, lets, accesses };
}

export function scan(tree, file) {
  const functions = [];
  const root = tree.rootNode;

  // Attributes are siblings preceding the item they decorate, so carry the
  // pending ones forward as we walk a block of items.
  const walkItems = (parent) => {
    let pendingAttrs = [];
    for (const item of children(parent)) {
      if (item.type === 'attribute_item') { pendingAttrs.push(text(item)); continue; }

      if (item.type === 'impl_item') {
        const isContract = pendingAttrs.some(a => a.includes('contractimpl'));
        const body = item.childForFieldName('body');
        if (body) {
          for (const inner of children(body)) {
            if (inner.type === 'function_item') functions.push(scanFunction(inner, file, isContract));
          }
        }
      } else if (item.type === 'function_item') {
        functions.push(scanFunction(item, file, false));
      } else if (item.type === 'mod_item') {
        const body = item.childForFieldName('body');
        if (body) walkItems(body);
      }

      if (item.type !== 'attribute_item') pendingAttrs = [];
    }
  };
  walkItems(root);

  return { functions, filesScanned: 1 };
}

// ------------------------------------------------------------------ analysis

function findCounterFunctions(functions) {
  const out = new Map();
  for (const f of functions) {
    const reads = new Set(), writes = new Set();
    for (const a of f.accesses) {
      if (a.keyArgs.length) continue;   // only a parameterless key is a counter
      (a.access === 'read' ? reads : writes).add(a.keyRoot);
    }
    const shared = [...reads].filter(k => writes.has(k)).sort();
    if (shared.length) out.set(f.name, shared[0]);
  }
  return out;
}

function classifyKey(f, raw, counters) {
  if (raw.keyArgs.length === 0) return { kind: 'static' };

  const subjects = [];
  let unresolved = null;

  for (const arg of raw.keyArgs) {
    if (arg.kind === 'ident') {
      if (f.params.has(arg.name)) { subjects.push(arg.name); continue; }

      const binding = f.lets
        .filter(l => l.name === arg.name && l.line <= raw.line)
        .sort((a, b) => a.line - b.line)
        .pop();

      if (binding) {
        if (binding.fromStorageKey) {
          return { kind: 'sequence_derived', counter: binding.fromStorageKey };
        }
        if (binding.fromCall && counters.has(binding.fromCall)) {
          return {
            kind: 'sequence_derived',
            counter: `${counters.get(binding.fromCall)} (via ${binding.fromCall}())`,
          };
        }
        unresolved ??= `\`${arg.name}\` is a local bound at line ${binding.line}; Braid cannot tell whether it came from caller input`;
      } else {
        unresolved ??= `\`${arg.name}\` is not a parameter of \`${f.name}\` and has no visible binding`;
      }
    } else {
      unresolved ??= `\`${arg.text}\` does not reduce to a named binding`;
    }
  }

  if (unresolved) return { kind: 'unresolvable', reason: unresolved };
  return { kind: 'subject_derived', param: subjects.join(', ') };
}

function classLabel(cls) {
  return { static: 'static', subject_derived: 'subject-derived',
           sequence_derived: 'sequence-derived', unresolvable: 'unresolvable' }[cls.kind];
}

function conflictDomain(durability, keyRoot) {
  return durability === 'instance' ? INSTANCE_DOMAIN : keyRoot;
}

function isSharedDomain(durability, cls) {
  if (durability === 'instance') return true;
  return cls.kind !== 'subject_derived';
}

function severityOf(a) {
  const hot = a.entry_point && !a.admin_path;

  // A constructor runs once; seeding a counter there is not a conflict.
  if (RUNS_ONCE.has(a.function) && a.access === 'write') return null;

  if (a.durability === 'instance' && a.access === 'write') {
    if (a.class.kind === 'static') return hot ? 'warning' : null;
    return hot ? 'critical' : 'warning';
  }

  if (a.class.kind === 'static' && a.access === 'write') return hot ? 'critical' : 'warning';
  if (a.class.kind === 'sequence_derived') return a.access === 'write' ? 'warning' : 'info';
  if (a.class.kind === 'unresolvable' && a.access === 'write') return 'warning';
  if (a.class.kind === 'static' && a.access === 'read' && a.entry_point) return 'info';
  return null;
}

function summaryOf(a) {
  if (a.durability === 'instance' && a.access === 'write') {
    if (a.class.kind === 'subject_derived') {
      return `\`${a.key_expr}\` is keyed by \`${a.class.param}\`, but it lives in instance storage — one ledger entry for every key, so the parameter separates nothing`;
    }
    return `writes \`${a.key_expr}\` in instance storage, which is a single ledger entry shared by every instance key in this contract`;
  }
  switch (a.class.kind) {
    case 'static':
      return a.access === 'write'
        ? `writes the fixed key \`${a.key_expr}\` — every caller reaching \`${a.function}\` touches this same ledger entry`
        : `reads the fixed key \`${a.key_expr}\` — shared, but reads alone never conflict`;
    case 'sequence_derived':
      return `\`${a.key_expr}\` looks parameterised, but its identifier was minted from \`${a.class.counter}\` — every caller serialises on that counter`;
    case 'unresolvable':
      return `could not classify \`${a.key_expr}\`: ${a.class.reason}`;
    default:
      return `\`${a.key_expr}\` is keyed by \`${a.class.param}\``;
  }
}

const REMEDIATION = {
  instance_subject: `Move per-subject data out of instance storage into persistent storage:

    // before — one ledger entry for the whole contract
    env.storage().instance().set(&DataKey::Balance(addr), &amount);

    // after — one ledger entry per address
    env.storage().persistent().set(&DataKey::Balance(addr), &amount);

Keep instance storage for what genuinely is global and rarely written: the
admin address, immutable configuration, the contract's own TTL. Anything
written on a normal user path does not belong there.`,

  instance_static: `This is a fixed key in instance storage, which is the right place for it — but it
is written on a path users reach, so every such call serialises on the contract
instance entry. Either move the write off the hot path (set it once at
construction, or in an admin function), or move the value to its own persistent
entry if it genuinely changes during normal operation.`,

  sequence: `Derive the identifier from data the caller already supplies, so no shared
counter is read or bumped:

    // before — every caller reads and writes DataKey::Seq
    let id: u64 = env.storage().persistent().get(&DataKey::Seq).unwrap_or(0);
    env.storage().persistent().set(&DataKey::Seq, &(id + 1));
    env.storage().persistent().set(&DataKey::Job(id), &job);

    // after — the id is a function of the caller's own input
    let id = env.crypto().sha256(&(owner, target, salt).to_xdr(&env));
    env.storage().persistent().set(&DataKey::Job(id), &job);

You lose dense sequential ids and gain the ability to run in parallel. If
callers need to enumerate their own entries, keep a per-caller index
(\`DataKey::OwnerJobs(owner)\`) rather than a global one.`,

  static_write: `Shard the entry by whoever writes it, so two callers no longer collide:

    // before — one entry, every caller writes it
    let total: i128 = env.storage().persistent().get(&DataKey::Total).unwrap_or(0);
    env.storage().persistent().set(&DataKey::Total, &(total + amount));

    // after — one entry per writer, summed on read
    let key = DataKey::TotalShard(caller.clone());
    let shard: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    env.storage().persistent().set(&key, &(shard + amount));

If the aggregate must be readable in one call, keep the shards authoritative
and recompute lazily, or accept that the reader pays to fold them. Reads do
not conflict, so a read-heavy aggregate is much cheaper to shard than it looks.`,

  static_read: `No action needed. Reads never place an entry in the read-write footprint, so a
shared read-only entry — configuration, the admin address, an immutable
parameter — does not serialise anything. It is listed only so the report is a
complete account of what this contract touches.`,

  unresolvable: `Braid could not follow this key expression, so it makes no claim either way.
Check by hand whether the value in the key comes from caller input (safe) or
from shared contract state (not safe). If it is caller input, binding it
directly from the parameter rather than through intermediate locals will let
Braid classify it next time.`,

  none: 'No action needed.',
};

function remediationFor(a) {
  if (a.durability === 'instance' && a.access === 'write') {
    return a.class.kind === 'static' ? REMEDIATION.instance_static : REMEDIATION.instance_subject;
  }
  switch (a.class.kind) {
    case 'sequence_derived': return REMEDIATION.sequence;
    case 'static': return a.access === 'write' ? REMEDIATION.static_write : REMEDIATION.static_read;
    case 'unresolvable': return REMEDIATION.unresolvable;
    default: return REMEDIATION.none;
  }
}

const RANK = { critical: 2, warning: 1, info: 0 };

export function analyze(target, scanned, sourceLines = null, contextRadius = 3) {
  const counters = findCounterFunctions(scanned.functions);

  const classified = [];
  for (const f of scanned.functions) {
    const admin = isAdminPath(f.name);
    for (const raw of f.accesses) {
      classified.push({
        file: f.file, line: raw.line, column: raw.column,
        function: f.name, entry_point: f.entryPoint, admin_path: admin,
        durability: raw.durability, access: raw.access,
        key_expr: raw.keyExpr, key_root: raw.keyRoot,
        class: classifyKey(f, raw, counters),
      });
    }
  }

  const touchers = new Map(), writers = new Map(), domainClass = new Map();
  for (const a of classified) {
    if (!a.entry_point || !isSharedDomain(a.durability, a.class)) continue;
    const domain = conflictDomain(a.durability, a.key_root);
    if (!domainClass.has(domain)) domainClass.set(domain, a.class);
    if (RUNS_ONCE.has(a.function)) continue;
    if (!touchers.has(domain)) touchers.set(domain, new Set());
    touchers.get(domain).add(a.function);
    if (a.access === 'write') {
      if (!writers.has(domain)) writers.set(domain, new Set());
      writers.get(domain).add(a.function);
    }
  }

  const findings = [];
  for (const a of classified) {
    const severity = severityOf(a);
    if (!severity) continue;
    const domain = conflictDomain(a.durability, a.key_root);
    const also = [...(touchers.get(domain) ?? [])].filter(n => n !== a.function).sort();
    const finding = {
      severity, access: a, summary: summaryOf(a),
      remediation: remediationFor(a), also_touched_by: also,
    };
    if (sourceLines) {
      const start = Math.max(a.line - contextRadius, 1);
      const end = Math.min(a.line + contextRadius, sourceLines.length);
      finding.context = [];
      for (let n = start; n <= end; n++) {
        finding.context.push({ number: n, text: sourceLines[n - 1] ?? '', hit: n === a.line });
      }
    }
    findings.push(finding);
  }

  findings.sort((x, y) =>
    RANK[y.severity] - RANK[x.severity] ||
    x.access.file.localeCompare(y.access.file) ||
    x.access.line - y.access.line);

  const edges = [];
  for (const [domain, fns] of [...touchers].sort((a, b) => a[0].localeCompare(b[0]))) {
    const w = writers.get(domain);
    if (!w || w.size === 0) continue;
    const reason = domain === INSTANCE_DOMAIN
      ? 'all instance storage shares one ledger entry'
      : `${classLabel(domainClass.get(domain) ?? { kind: 'static' })} key \`${domain}\`, written by at least one of them`;
    const list = [...fns].sort();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!w.has(list[i]) && !w.has(list[j])) continue;
        edges.push({ a: list[i], b: list[j], key_root: domain, reason });
      }
    }
  }
  edges.sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b) || x.key_root.localeCompare(y.key_root));

  const entryPoints = [...new Set(classified.filter(a => a.entry_point).map(a => a.function))].sort();
  const conflicted = new Set(edges.flatMap(e => [e.a, e.b]));
  const selfConflicted = new Set([...writers.values()].flatMap(w => [...w]));
  const parallelSafe = entryPoints.filter(n => !conflicted.has(n) && !selfConflicted.has(n));

  const count = s => findings.filter(f => f.severity === s).length;

  return {
    schema_version: SCHEMA_VERSION,
    target,
    summary: {
      files_scanned: scanned.filesScanned,
      functions_scanned: scanned.functions.length,
      accesses_found: classified.length,
      entry_points: entryPoints.length,
      critical: count('critical'), warning: count('warning'), info: count('info'),
    },
    findings,
    conflict_edges: edges,
    parallel_safe_entry_points: parallelSafe,
    self_conflicting_entry_points: [...selfConflicted].sort(),
  };
}

/**
 * Split like Rust's `str::lines()`: strip a trailing carriage return, and do not
 * yield a final empty line when the source ends with a newline.
 *
 * `split('\n')` differs on that last point, which quietly makes the source
 * context one line longer at the end of a file than the Rust implementation
 * produces. Conformance caught it; keeping the two in step matters more than
 * the line itself.
 */
export function splitLines(source) {
  const lines = source.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Parse and analyse one Rust source string. */
export function analyzeSource(parser, filename, source, { includeSource = true } = {}) {
  const tree = parser.parse(source);
  try {
    const scanned = scan(tree, filename);
    return analyze(filename, scanned, includeSource ? splitLines(source) : null);
  } finally {
    tree.delete?.();
  }
}
