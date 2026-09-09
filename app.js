/**
 * Braid, in the browser.
 *
 * Loads tree-sitter and the Rust grammar as WebAssembly, then runs the real
 * analysis (analyzer.js — a checked port of braid-core) over whatever is in the
 * editor. Nothing is uploaded and there is no backend: the contract you paste
 * is parsed and analysed in this tab.
 *
 * Rendering helpers below the analysis section are pure and covered by test.mjs.
 */

import { analyzeSource } from './analyzer.js';

export const SEVERITIES = ['critical', 'warning', 'info'];

export const EXAMPLES = [
  { id: 'hot_counter',   title: 'Sequence counter', blurb: 'Ids look parameterised, but minting one bumps a shared counter.' },
  { id: 'instance_trap', title: 'Instance storage', blurb: 'Per-address keys that all live in one ledger entry.' },
  { id: 'global_supply', title: 'Global aggregate', blurb: 'A total-supply entry written on the hottest path.' },
  { id: 'clean_token',   title: 'Clean token',      blurb: 'Keyed by caller, in persistent storage. Nothing to fix.' },
  { id: 'good_registry', title: 'Remediated',       blurb: 'The counter contract, fixed.' },
];

// ---------------------------------------------------------------- pure logic

/** One sentence a reader can act on, rather than counts they must interpret. */
export function verdict(report) {
  const s = report.summary || {};
  const self = (report.self_conflicting_entry_points || []).length;
  const edges = (report.conflict_edges || []).length;

  if (s.entry_points === 0) {
    return { tone: 'none', text: 'No contract entry points found. Braid looks for public functions inside an `#[contractimpl]` block.' };
  }
  if (s.critical > 0) {
    return { tone: 'bad', text: `${s.critical} critical ${plural(s.critical, 'conflict')} — these entry points serialise on a shared ledger entry every time they run.` };
  }
  if (s.warning > 0) {
    return { tone: 'warn', text: `No critical conflicts. ${s.warning} ${plural(s.warning, 'warning')} on paths that run rarely, or on keys Braid could not fully resolve.` };
  }
  if (edges === 0 && self === 0) {
    return { tone: 'good', text: 'No conflicts. Every mutable entry is keyed by caller input and none live in instance storage, so these entry points cluster independently.' };
  }
  return { tone: 'good', text: 'No actionable findings.' };
}

export function plural(n, word) { return n === 1 ? word : word + 's'; }

/**
 * Lay the conflict graph out as an arc diagram: entry points on a baseline, an
 * arc per conflicting pair.
 *
 * An arc diagram rather than a force layout so node order is stable between
 * runs — you can retype a line and see what moved, instead of the whole picture
 * rearranging itself.
 */
export function buildGraph(report, width = 900) {
  const edges = report.conflict_edges || [];
  const selfs = report.self_conflicting_entry_points || [];
  const safe = report.parallel_safe_entry_points || [];

  const names = [...new Set([...edges.flatMap(e => [e.a, e.b]), ...selfs, ...safe])].sort();
  if (names.length === 0) return null;

  const pad = 90;
  const usable = Math.max(width - pad * 2, 1);
  const step = names.length > 1 ? usable / (names.length - 1) : 0;
  const nodes = names.map((name, i) => ({
    name,
    x: names.length > 1 ? pad + i * step : width / 2,
    conflicted: edges.some(e => e.a === name || e.b === name),
    selfConflicted: selfs.includes(name),
    safe: safe.includes(name),
  }));

  const index = new Map(nodes.map(n => [n.name, n]));
  const arcs = edges.map(e => {
    const a = index.get(e.a), b = index.get(e.b);
    const span = Math.abs(b.x - a.x);
    return { a, b, key: e.key_root, reason: e.reason, height: Math.min(20 + span * 0.32, 132) };
  });

  // A quadratic curve peaks halfway to its control point, so a control offset
  // of 2h draws an apex exactly h above the baseline.
  const maxArc = arcs.reduce((m, a) => Math.max(m, a.height), 0);
  const baseline = maxArc + 34;

  // Labels are rotated below the baseline; the longest name sets the room.
  const longest = names.reduce((m, n) => Math.max(m, n.length), 0);
  const labelRoom = 30 + Math.min(longest * 6.1 * Math.sin(28 * Math.PI / 180), 96);

  return { nodes, arcs, width, height: baseline + labelRoom, baseline };
}

export function graphNote(report) {
  const edges = (report.conflict_edges || []).length;
  const selfs = (report.self_conflicting_entry_points || []).length;
  if (edges === 0 && selfs === 0) {
    return 'Nothing conflicts. Every entry point below can run alongside every other one.';
  }
  const parts = [];
  if (edges) parts.push(`${edges} conflicting ${plural(edges, 'pair')}`);
  if (selfs) {
    parts.push(`${selfs} ${plural(selfs, 'entry point')} that ${selfs === 1 ? 'conflicts' : 'conflict'} with ${selfs === 1 ? 'itself' : 'themselves'} — two concurrent calls to the same function serialise`);
  }
  return parts.join(', ') + '.';
}

// ------------------------------------------------------------------ dom glue

if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== undefined) n.textContent = txt;
    return n;
  };

  const active = new Set(SEVERITIES);
  let parser = null;
  let current = null;
  let filename = 'contract.rs';

  const setStatus = (text, tone = '') => {
    const s = $('status');
    s.textContent = text;
    s.className = 'status ' + tone;
  };

  const fail = msg => { const b = $('err'); b.textContent = msg; b.hidden = false; };
  const clearError = () => { $('err').hidden = true; };

  // ---- examples
  for (const ex of EXAMPLES) {
    const b = el('button', 'example');
    b.type = 'button';
    b.append(el('strong', null, ex.title), el('span', 'muted', ex.blurb));
    b.addEventListener('click', () => loadExample(ex.id));
    $('examples').append(b);
  }

  async function loadExample(id) {
    try {
      const res = await fetch(`./examples/${id}.rs`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      filename = `${id}.rs`;
      $('source').value = await res.text();
      history.replaceState(null, '', `?example=${encodeURIComponent(id)}`);
      run();
    } catch (e) {
      fail(`Could not load that example: ${e.message}`);
    }
  }

  // ---- parser boot
  //
  // The parser is loaded from ./vendor/ when it is committed alongside the site,
  // and from jsDelivr otherwise. Either way the WebAssembly is verified against
  // a pinned SHA-256 before it is allowed to run, so a compromised or swapped
  // CDN artifact fails closed rather than silently analysing your contract with
  // someone else's code.
  const CDN = 'https://cdn.jsdelivr.net/npm';
  const RUNTIME = 'web-tree-sitter@0.25.0';
  const GRAMMAR = 'tree-sitter-wasms@0.1.13';

  const SOURCES = [
    {
      name: 'vendor',
      js: './vendor/tree-sitter.js',
      runtimeWasm: './vendor/tree-sitter.wasm',
      grammarWasm: './vendor/tree-sitter-rust.wasm',
    },
    {
      name: 'jsDelivr',
      js: `${CDN}/${RUNTIME}/tree-sitter.js`,
      runtimeWasm: `${CDN}/${RUNTIME}/tree-sitter.wasm`,
      grammarWasm: `${CDN}/${GRAMMAR}/out/tree-sitter-rust.wasm`,
    },
  ];

  // Base64 SHA-256 of the exact artifacts this build was tested against.
  const DIGESTS = {
    runtimeWasm: 'NPzMZOErwgH9j0eA/cahCz/4gyz7hOLXQZWDSAzmuX4=',
    grammarWasm: 'RAmSGnDQqlvsfR186AmlV6juHPas6QHjrGp25iz+qQM=',
  };

  async function sha256Base64(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return btoa(String.fromCharCode(...new Uint8Array(digest)));
  }

  async function fetchVerified(url, expected, label) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${label}: ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    const got = await sha256Base64(buf);
    if (got !== expected) {
      throw new Error(`${label}: integrity check failed (expected ${expected}, got ${got})`);
    }
    return buf;
  }

  async function bootFrom(src) {
    const [runtimeWasm, grammarWasm] = await Promise.all([
      fetchVerified(src.runtimeWasm, DIGESTS.runtimeWasm, 'tree-sitter runtime'),
      fetchVerified(src.grammarWasm, DIGESTS.grammarWasm, 'Rust grammar'),
    ]);
    const { Parser, Language } = await import(src.js);
    // wasmBinary hands the verified bytes straight to emscripten, so nothing is
    // re-fetched behind our back; locateFile is the fallback if it ignores it.
    await Parser.init({ wasmBinary: runtimeWasm, locateFile: () => src.runtimeWasm });
    const Rust = await Language.load(new Uint8Array(grammarWasm));
    const p = new Parser();
    p.setLanguage(Rust);
    return p;
  }

  async function boot() {
    const failures = [];
    for (const src of SOURCES) {
      try {
        setStatus(`Loading the Rust parser (${src.name})\u2026`);
        parser = await bootFrom(src);
        setStatus('Parser ready', 'ok');
        run();
        return;
      } catch (e) {
        failures.push(`${src.name}: ${e.message}`);
      }
    }
    setStatus('Parser failed to load', 'bad');
    fail(`The Rust parser could not start. ${failures.join('; ')}`);
  }

  // ---- analysis
  function run() {
    if (!parser) return;
    const src = $('source').value;
    if (!src.trim()) {
      $('report').hidden = true;
      $('placeholder').hidden = false;
      $('placeholder').textContent = 'Analysis appears here as you type.';
      clearError();
      return;
    }
    try {
      const t0 = performance.now();
      current = analyzeSource(parser, filename, src);
      const ms = Math.max(1, Math.round(performance.now() - t0));
      clearError();
      setStatus(`Analysed in ${ms} ms`, 'ok');
      render();
    } catch (e) {
      fail(`Analysis failed: ${e.message}`);
      setStatus('Analysis failed', 'bad');
    }
  }

  let timer;
  $('source').addEventListener('input', () => {
    clearTimeout(timer);
    setStatus('Analysing…');
    timer = setTimeout(run, 220);
  });

  $('file').addEventListener('change', e => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) return fail('That file is larger than 4 MB — Braid expects a contract source file.');
    const reader = new FileReader();
    reader.onerror = () => fail('Could not read that file.');
    reader.onload = () => { filename = f.name; $('source').value = String(reader.result); run(); };
    reader.readAsText(f);
  });

  $('download').addEventListener('click', () => {
    if (!current) return fail('Nothing to download yet.');
    const blob = new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename.replace(/\.rs$/, '') + '.braid.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // ---- render
  function render() {
    $('placeholder').hidden = true;
    $('report').hidden = false;

    const v = verdict(current);
    const vEl = $('verdict');
    vEl.textContent = v.text;
    vEl.className = 'verdict ' + v.tone;

    const s = current.summary;
    const stats = $('stats');
    stats.replaceChildren();
    for (const [label, value] of [
      ['Functions', s.functions_scanned], ['Entry points', s.entry_points],
      ['Accesses', s.accesses_found], ['Critical', s.critical],
      ['Warning', s.warning], ['Info', s.info],
    ]) {
      const d = el('div', 'stat');
      d.append(el('dt', null, label), el('dd', 'mono', String(value ?? 0)));
      stats.append(d);
    }

    renderChips();
    renderGraph();
    renderFindings();
  }

  function renderChips() {
    const chips = $('chips');
    chips.replaceChildren();
    for (const sev of SEVERITIES) {
      const n = current.summary[sev] ?? 0;
      const b = el('button', `chip ${sev}`, `${n} ${sev}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(active.has(sev)));
      b.disabled = n === 0;
      b.addEventListener('click', () => {
        active.has(sev) ? active.delete(sev) : active.add(sev);
        b.setAttribute('aria-pressed', String(active.has(sev)));
        renderFindings();
      });
      chips.append(b);
    }
  }

  function renderGraph() {
    const svg = $('graph');
    const panel = $('graph-panel');
    const width = Math.max(panel.clientWidth - 40, 520);
    const g = buildGraph(current, width);

    $('graph-note').textContent = graphNote(current);
    // The heading follows the finding: on a clean contract this panel shows
    // independence, not conflict, and saying otherwise misreads it.
    const conflicts = (current.conflict_edges || []).length
      + (current.self_conflicting_entry_points || []).length;
    $('graph-title').textContent = conflicts
      ? 'Entry points that cannot run in parallel'
      : 'Entry points, all independent';

    svg.replaceChildren();
    if (!g) { panel.hidden = true; return; }
    panel.hidden = false;
    svg.setAttribute('viewBox', `0 0 ${g.width} ${g.height}`);
    svg.setAttribute('width', String(g.width));
    svg.setAttribute('height', String(g.height));

    const NS = 'http://www.w3.org/2000/svg';
    const node = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      return n;
    };
    const titled = (n, text) => {
      const t = document.createElementNS(NS, 'title');
      t.textContent = text;
      n.append(t);
      return n;
    };

    svg.append(node('line', { x1: 40, y1: g.baseline, x2: g.width - 40, y2: g.baseline, class: 'axis' }));

    for (const arc of g.arcs) {
      const mid = (arc.a.x + arc.b.x) / 2;
      svg.append(titled(node('path', {
        d: `M ${arc.a.x} ${g.baseline} Q ${mid} ${g.baseline - arc.height * 2} ${arc.b.x} ${g.baseline}`,
        class: 'arc',
      }), `${arc.a.name} ↔ ${arc.b.name} — ${arc.reason}`));
    }

    for (const n of g.nodes) {
      // State is its own token so `.node` selects circles only.
      const state = n.selfConflicted ? 'self' : n.conflicted ? 'conflicted' : n.safe ? 'safe' : '';
      svg.append(titled(node('circle', {
        cx: n.x, cy: g.baseline, r: n.selfConflicted ? 7 : 5, class: `node ${state}`,
      }), n.selfConflicted ? `${n.name} — conflicts with itself; concurrent calls serialise`
        : n.conflicted ? `${n.name} — conflicts with another entry point`
        : `${n.name} — parallel-safe`));

      const label = node('text', {
        x: n.x, y: g.baseline + 22, class: `label ${state}`,
        transform: `rotate(28 ${n.x} ${g.baseline + 22})`,
      });
      label.textContent = n.name;
      svg.append(label);
    }
  }

  function renderFindings() {
    const box = $('findings');
    box.replaceChildren();
    const shown = (current.findings || []).filter(f => active.has(f.severity));
    $('none-shown').hidden = shown.length !== 0 || (current.findings || []).length === 0;

    for (const f of shown) {
      const a = f.access;
      const card = el('article', `finding ${f.severity}`);

      const head = el('div', 'fhead');
      head.append(
        el('span', 'sev', f.severity),
        el('span', 'loc mono', `line ${a.line}:${a.column}`),
        el('span', 'fn mono', `in ${a.function}()`),
      );
      card.append(head, el('p', 'summary', f.summary));

      const tags = el('div', 'tags');
      tags.append(el('span', 'tag', `${a.durability} ${a.access}`));
      tags.append(el('span', 'tag', a.class.kind.replace(/_/g, '-')));
      if (a.class.counter) tags.append(el('span', 'tag', `counter: ${a.class.counter}`));
      if (a.class.param) tags.append(el('span', 'tag', `key: ${a.class.param}`));
      tags.append(el('span', 'tag', a.entry_point ? 'entry point' : 'internal'));
      card.append(tags);

      if (f.context?.length) {
        const pre = el('pre', 'code');
        for (const line of f.context) {
          const row = el('span', 'ln' + (line.hit ? ' hit' : ''));
          row.append(el('span', 'no', String(line.number)));
          row.append(document.createTextNode(line.text));
          pre.append(row);
        }
        card.append(pre);
      }

      if (f.also_touched_by?.length) {
        card.append(el('p', 'muted small', `Same ledger entry is also touched by: ${f.also_touched_by.join(', ')}`));
      }

      if (f.severity !== 'info' && f.remediation) {
        const d = el('details');
        d.append(el('summary', null, 'How to fix this'), el('pre', 'code fix', f.remediation));
        card.append(d);
      }

      box.append(card);
    }
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    if (!current) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderGraph, 150);
  });

  // Open on a real contract with a real finding, so the page shows what it does
  // rather than an empty box.
  const wanted = new URLSearchParams(location.search).get('example');
  const start = EXAMPLES.some(e => e.id === wanted) ? wanted : 'hot_counter';
  fetch(`./examples/${start}.rs`)
    .then(r => r.text())
    .then(src => { filename = `${start}.rs`; $('source').value = src; })
    .catch(() => {})
    .finally(boot);
}
