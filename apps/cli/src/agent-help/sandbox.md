# Sandbox storage

`mf sandbox storage-usage --json` reports the current agent's sandbox. It uses
`--agent-id`, `MF_AGENT_ID`, or the authenticated runtime identity. A human token
without an agent context must choose `--agent-id` or `--account` explicitly.

```sh
mf sandbox storage-usage --json
mf sandbox storage-usage --account --json
```

The account command requires `agents:read` consent for runtime identities. A
denial returns the existing owner-consent URL and no partial account report.
Human account sessions and full API tokens keep their account access.

The response states `scope` and `unit`. `storageBytesTotal` is the sum of its
host rows from one database snapshot. Hosts are ranked by storage descending;
empty sandboxes are included. `storageFreshness`, `storageMeasuredAt`, and
`asleep` describe cached readings. This command never executes a measurement
or wakes a sandbox.

`workspaceBytes` is the raw measured workspace size. `attributedBytes` removes
known overlapping paths from the breakdown; unknown attribution remains null.
Attribution is based on apparent file sizes, not provider invoices, hardlink
accounting or copy-on-write allocation. A current-sandbox response includes
only the current agent's identity and attribution, while its host total still
describes the whole sandbox.

`mf agent storage-usage <agentId> --json` is a different diagnostic: its scope
is `agent-paths`. It inspects workspace/config paths when the sandbox is awake.
When asleep, path values stay unknown and `cachedSandbox` carries the separate
cached whole-sandbox reading.
