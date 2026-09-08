# vendor/

Prebuilt WebAssembly, committed so the site deploys with no build step and no
package install.

| File | Source | Licence |
| --- | --- | --- |
| `tree-sitter.js`, `tree-sitter.wasm` | web-tree-sitter 0.25.0 | MIT |
| `tree-sitter-rust.wasm` | tree-sitter-wasms 0.1.13 | MIT |

The runtime and grammar ABIs must match. 0.25.0 is the newest web-tree-sitter
that loads the grammar build shipped by tree-sitter-wasms 0.1.13 -- 0.27
rejects it with a dylink metadata error. If you bump either, re-run
`node conformance.mjs`; a grammar change that alters node names shows up
there as a divergence from the Rust implementation rather than as silent
mis-analysis.
