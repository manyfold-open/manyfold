---
'@manyfold/cli': minor
---

`mf a2a` failures now exit according to their kind and say what failed.

- An A2A endpoint that does not resolve, or refuses the connection, exits `2`, and the error names the endpoint (`A2A endpoint host … could not be resolved`).
- A peer this agent holds no grant for exits `4`, with a hint to run `mf a2a status`.
- Adding a caller that already has an active grant suggests `--replace-existing`.
- An `--input-file` that cannot be read is a usage error (exit `5`).
- In the standalone `mf`, any network failure now exits `2` like it does in the source build. Bun reports a host that does not resolve, and a closed port, as `ConnectionRefused`, which used to exit `1`.
