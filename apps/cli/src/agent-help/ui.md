# Web links

Resolve links using the same profile and account as the resource operation:

```sh
mf ui resolve automation --json
mf ui resolve automation <automation-id> --json
mf ui resolve automation <automation-id> --run-id <run-id> --json
```

The server supplies the correct Web origin for this deployment. The result
contains a clean `url`, `resource`, optional `resourceId`, and links for recent
runs that have a chat session. Open `url` in the host's browser pane, reusing
the same tab, or present the link when browser controls are unavailable.
Browser login is separate from CLI authentication. Never put an API token
in a URL.

Only `automation` is supported. Omit its id to open the list. Run links are
limited to the automation's recent run history; a run can exist before its
chat session is ready. Use `mf automations get <id> --json` to check status.
Resolving a link does not execute, retry, or resume a run.
