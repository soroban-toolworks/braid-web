/**
 * The port must not drift from the Rust implementation.
 *
 * Runs analyzer.js over the same fixtures the Rust tests use and compares the
 * result to what the `braid` CLI produces for the same file. Any divergence —
 * a severity, a classification, a remediation string, an edge — fails here.
 *
 *   node conformance.mjs [path/to/braid]
 */
import { Parser, Language } from 'web-tree-sitter';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { analyzeSource } from './analyzer.js';

const BRAID = process.argv[2] ?? '/home/claude/braid/target/release/braid';
const FIXTURES = ['hot_counter', 'instance_trap', 'global_supply', 'clean_token', 'good_registry'];
const ROOT = '/home/claude/braid/fixtures';

if (!existsSync(BRAID)) {
  console.error(`braid CLI not found at ${BRAID} — build it with: cargo build --release`);
  process.exit(2);
}

await Parser.init();
const Rust = await Language.load(
  new Uint8Array(readFileSync('./node_modules/tree-sitter-wasms/out/tree-sitter-rust.wasm')));
const parser = new Parser();
parser.setLanguage(Rust);

/** Report the first structural difference rather than dumping two blobs. */
function diff(a, b, path = '') {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${path}: type ${typeof a} vs ${typeof b}`;
  if (a === null || b === null || typeof a !== 'object') {
    return `${path}:\n    rust: ${JSON.stringify(a)}\n    js:   ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    const d = diff(a[k], b[k], path ? `${path}.${k}` : k);
    if (d) return d;
  }
  return null;
}

let failures = 0;
for (const name of FIXTURES) {
  const file = `${ROOT}/${name}/src/lib.rs`;
  const rust = JSON.parse(execFileSync(BRAID,
    ['analyze', file, '--format', 'json', '--include-source'], { encoding: 'utf8', maxBuffer: 32 << 20 }));
  const js = analyzeSource(parser, file, readFileSync(file, 'utf8'));

  const d = diff(rust, js);
  if (d) { failures++; console.log(`FAIL  ${name}\n  first difference at ${d}`); }
  else console.log(`PASS  ${name} — ${rust.findings.length} findings, ${rust.conflict_edges.length} edges, identical`);
}

console.log(failures ? `\n${failures} fixture(s) diverge.` : '\nJS port matches the Rust implementation on every fixture.');
process.exit(failures ? 1 : 0);
