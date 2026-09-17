# Live Sprites Probe

`pnpm --filter @manyfold/sprites test:live` is outside the default deterministic
test glob. It skips unless `RUN_SPRITES_E2E=1`, and explicit opt-in without
`SPRITES_TOKEN` fails before creating a client or resource. Package `check`
continues compiling the live entry and its imported probe body.

This command creates a billable Sprite. Run it only with explicit authorization
for the controlled provider account. Local lifecycle regressions use simulated
clients and loopback HTTP/WebSocket servers; they do not validate the provider's
actual deletion behavior.

The probe prints its unique `nca-probe-detach-*` name before create. Every
confirmed create has one cleanup result: `cleanup deleted` or `cleanup failed`.
Delete is attempted at most three times, with 500ms and 1500ms backoffs. Each
SDK request has a 15-second timeout, so deletion takes at most about 47 seconds
plus scheduling overhead. Final deletion failure fails the run; when the body
also fails, both errors are retained in an `AggregateError` with the resource
name. A rejected create does not authorize deletion of an unconfirmed resource.

Node's 180-second test timeout and cancellation abort the probe's delays,
WebSocket waits and active SDK exec. A separate 75-second after-hook budget waits
for the same create/body/cleanup lifecycle, including create finishing after
cancellation. Cleanup ignores the cancelled body signal and has its own bounded
SDK requests. Forced process termination, SIGKILL, host loss and ambiguous create
responses cannot guarantee remote cleanup; use the printed resource name for an
explicit recovery check. Do not infer successful deletion from a green body or
automatically delete an unconfirmed name.
