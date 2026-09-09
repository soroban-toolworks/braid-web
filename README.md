# braid-web

[Braid](https://github.com/soroban-toolworks/braid) running in the browser. Paste a
Soroban contract and see which entry points cannot run in parallel under CAP-0063, and the
storage key that is stopping them.

No backend, no build step, no account. The contract you paste is parsed and analysed in
your tab and never leaves it.

## It runs the real analysis

This is not a viewer for reports produced elsewhere. `analyzer.js` is a port of
`braid-core`, walking a genuine Rust syntax tree from
[tree-sitter](https://tree-sitter.github.io/) compiled to WebAssembly — not regexes over
source text.

Two implementations of the same rules drift unless something stops them, so
`conformance.mjs` runs this port over the same fixture corpus as the Rust test suite and
asserts the reports are **identical, field for field**. A change to either implementation
that is not made in both fails the build.

```console
$ node conformance.mjs
PASS  hot_counter — 3 findings, 0 edges, identical
PASS  instance_trap — 2 findings, 1 edges, identical
PASS  global_supply — 6 findings, 2 edges, identical
PASS  clean_token — 1 findings, 0 edges, identical
PASS  good_registry — 0 findings, 0 edges, identical

JS port matches the Rust implementation on every fixture.
```

The Rust CLI stays the authoritative implementation for CI, where you want a pinned binary
and an exit code. This is for the other moments: reading a finding, showing a colleague,
trying a fix without a toolchain installed.

## What it shows

- **A verdict in one sentence**, not counts to interpret.
- **An arc diagram** of entry points, one arc per conflicting pair. Node order is stable
  between runs, so you can change a line and see what moved.
- **Self-conflict**, which has no arc to draw: an entry point writing a shared entry
  serialises against *itself*, because two concurrent calls land in the same cluster.
- **Findings** with source context and remediation, filterable by severity.
- **Download report JSON** — the same schema v1 the CLI emits.

## Develop

```sh
npm install
npm run dev          # http://localhost:8080
npm test             # 19 unit tests: analysis, edge cases, graph layout
npm run conformance  # asserts agreement with the Rust CLI
npm run verify       # headless browser: loads WASM, analyses, edits, downloads
```

`npm run conformance` needs a `braid` binary — build it from the
[analyser repo](https://github.com/soroban-toolworks/braid) with `cargo build --release`,
then pass the path as an argument if it is not at the default location.

`npm run verify` needs a Chromium; set `CHROME_PATH` if Playwright's own download is
unavailable.

## Deploy

Static, zero-config. `vercel.json` disables the build step, serves from the repo root, and
sets a content-security policy allowing only this origin plus Google Fonts —
`'wasm-unsafe-eval'` is required for the parser and is the only relaxation.

`vendor/` holds the prebuilt tree-sitter runtime and Rust grammar, committed so a deploy
needs no toolchain. See `vendor/README.md` for the version pinning, which matters: the
runtime and grammar ABIs have to match.

## Limits

The analysis is syntactic. It does not resolve types or expand macros, so a key derivation
routed through code it cannot follow is reported as `unresolvable` rather than as clean —
a false sense of safety is the failure mode worth engineering against.

Unaudited, and not yet run against a large corpus of real contracts.

## Licence

Apache-2.0. Vendored WebAssembly is MIT; see `vendor/README.md`.
