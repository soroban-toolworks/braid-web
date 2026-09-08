/**
 * Unit tests for the analyser and the pure rendering helpers.
 *
 *   node --test test.mjs
 *
 * Agreement with the Rust implementation is checked separately, by
 * conformance.mjs — this file covers behaviour the browser build owns.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Parser, Language } from 'web-tree-sitter';
import { analyzeSource, splitLines, INSTANCE_DOMAIN } from './analyzer.js';
import { verdict, buildGraph, graphNote, plural, EXAMPLES, SEVERITIES } from './app.js';

let parser;
before(async () => {
  await Parser.init();
  const Rust = await Language.load(
    new Uint8Array(readFileSync('./vendor/tree-sitter-rust.wasm')));
  parser = new Parser();
  parser.setLanguage(Rust);
});

const run = id => analyzeSource(parser, `${id}.rs`,
  readFileSync(new URL(`./examples/${id}.rs`, import.meta.url), 'utf8'));

test('every example listed in the UI has a source file that analyses', () => {
  for (const ex of EXAMPLES) {
    const r = run(ex.id);
    assert.equal(r.schema_version, 1);
    assert.ok(r.summary.entry_points > 0, `${ex.id} should have entry points`);
  }
});

test('the shared counter is critical and attributed to its key', () => {
  const r = run('hot_counter');
  const crit = r.findings.filter(f => f.severity === 'critical');
  assert.equal(crit.length, 1);
  assert.equal(crit[0].access.key_root, 'DataKey::Seq');
  assert.equal(crit[0].access.class.kind, 'static');
});

test('an id minted from a counter is traced back to it', () => {
  const r = run('hot_counter');
  const job = r.findings.find(f => f.access.key_root === 'DataKey::Job' && f.access.access === 'write');
  assert.equal(job.access.class.kind, 'sequence_derived');
  assert.match(job.access.class.counter, /DataKey::Seq/);
  assert.equal(job.severity, 'warning');
});

test('instance storage defeats a per-subject key', () => {
  const r = run('instance_trap');
  const dep = r.findings.find(f => f.access.function === 'deposit');
  assert.equal(dep.severity, 'critical');
  assert.equal(dep.access.class.kind, 'subject_derived');   // the key IS per-subject
  assert.equal(dep.access.durability, 'instance');          // the problem is where it lives
  assert.match(dep.summary, /instance storage/);
  assert.equal(r.conflict_edges[0].key_root, INSTANCE_DOMAIN);
});

test('per-address balances never conflict with each other', () => {
  const r = run('clean_token');
  assert.equal(r.conflict_edges.length, 0);
  assert.ok(r.parallel_safe_entry_points.includes('transfer'));
  assert.equal(r.findings.filter(f => f.severity !== 'info').length, 0);
});

test('the remediated contract is completely clean', () => {
  const r = run('good_registry');
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.conflict_edges, []);
  assert.deepEqual(r.self_conflicting_entry_points, []);
});

test('a read-only shared key is never critical', () => {
  const r = run('global_supply');
  const quote = r.findings.filter(f => f.access.function === 'quote');
  assert.ok(quote.every(f => f.severity === 'info'));
  for (const f of r.findings.filter(f => f.severity === 'critical')) {
    assert.equal(f.access.key_root, 'DataKey::TotalSupply');
  }
});

test('constructors produce no findings', () => {
  for (const ex of EXAMPLES) {
    assert.ok(!run(ex.id).findings.some(f => f.access.function === '__constructor'),
      `${ex.id}: a constructor runs once and cannot race`);
  }
});

test('source that is not a contract is handled without throwing', () => {
  const r = analyzeSource(parser, 'x.rs', 'fn main() { println!("hi"); }');
  assert.equal(r.summary.entry_points, 0);
  assert.deepEqual(r.findings, []);
  assert.equal(verdict(r).tone, 'none');
});

test('syntactically broken source still returns a report', () => {
  // tree-sitter recovers from errors rather than refusing, so a half-typed
  // contract must degrade to fewer findings, never to an exception.
  const r = analyzeSource(parser, 'x.rs', '#[contractimpl]\nimpl A { pub fn f(env: Env) { env.storage().');
  assert.equal(r.schema_version, 1);
  assert.ok(Array.isArray(r.findings));
});

test('empty source is a valid empty report', () => {
  const r = analyzeSource(parser, 'x.rs', '');
  assert.equal(r.summary.accesses_found, 0);
  assert.equal(buildGraph(r), null);
});

test('splitLines matches Rust str::lines semantics', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('\n'), ['']);
});

test('source context stays inside the file', () => {
  for (const ex of EXAMPLES) {
    const src = readFileSync(new URL(`./examples/${ex.id}.rs`, import.meta.url), 'utf8');
    const total = splitLines(src).length;
    for (const f of run(ex.id).findings) {
      for (const line of f.context ?? []) {
        assert.ok(line.number >= 1 && line.number <= total,
          `${ex.id}: context line ${line.number} outside 1..${total}`);
      }
      assert.ok((f.context ?? []).some(l => l.hit), 'the reported line must be marked');
    }
  }
});

test('verdicts follow severity', () => {
  assert.equal(verdict(run('instance_trap')).tone, 'bad');
  assert.equal(verdict(run('good_registry')).tone, 'good');
  assert.equal(verdict({ summary: { entry_points: 2, critical: 0, warning: 3 },
                         conflict_edges: [], self_conflicting_entry_points: [] }).tone, 'warn');
});

test('plural agrees with its count', () => {
  assert.equal(plural(1, 'conflict'), 'conflict');
  assert.equal(plural(2, 'conflict'), 'conflicts');
  assert.equal(plural(0, 'pair'), 'pairs');
});

test('the graph places every entry point once and keeps arcs in frame', () => {
  for (const ex of EXAMPLES) {
    const r = run(ex.id);
    const g = buildGraph(r, 900);
    if (!g) continue;
    const names = g.nodes.map(n => n.name);
    assert.equal(new Set(names).size, names.length, `${ex.id}: duplicate node`);
    for (const arc of g.arcs) {
      // A quadratic Bezier peaks halfway to its control point.
      assert.ok(g.baseline - arc.height >= 0, `${ex.id}: arc escapes the viewBox`);
    }
    for (const n of g.nodes) assert.ok(n.x >= 0 && n.x <= g.width);
    const longest = names.reduce((m, n) => Math.max(m, n.length), 0);
    assert.ok(g.height >= g.baseline + 30 + Math.min(longest * 6.1 * Math.sin(28 * Math.PI / 180), 96) - 0.001,
      `${ex.id}: labels would be clipped`);
  }
});

test('a single entry point lays out without dividing by zero', () => {
  const g = buildGraph({ conflict_edges: [], self_conflicting_entry_points: ['only'],
                         parallel_safe_entry_points: [] }, 900);
  assert.equal(g.nodes.length, 1);
  assert.equal(g.nodes[0].x, 450);
});

test('self-conflict is explained rather than shown as an empty graph', () => {
  const r = run('hot_counter');
  assert.equal(r.conflict_edges.length, 0);
  assert.deepEqual(r.self_conflicting_entry_points, ['create_job']);
  assert.match(graphNote(r), /conflicts with itself/);
});

test('severity list matches what reports contain', () => {
  const seen = new Set();
  for (const ex of EXAMPLES) for (const f of run(ex.id).findings) seen.add(f.severity);
  for (const s of seen) assert.ok(SEVERITIES.includes(s), `unknown severity ${s}`);
});
