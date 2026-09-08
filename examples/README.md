# examples

Five Soroban contracts, each demonstrating one way a storage design does or does
not parallelise under CAP-0063. They are the same fixtures the Rust test suite
and `conformance.mjs` run against, so what you see in the browser is what the
CLI asserts.

| File | Shows |
| --- | --- |
| `hot_counter.rs` | A sequence counter: ids look parameterised, but minting one bumps a shared entry. |
| `instance_trap.rs` | Per-address keys in instance storage, which is a single ledger entry. |
| `global_supply.rs` | One aggregate written on the hottest path. |
| `clean_token.rs` | Keyed by caller, in persistent storage. Nothing to fix. |
| `good_registry.rs` | `hot_counter` remediated. A completely clean report. |
