---
'@manyfold/api': minor
---

Accept daemon WebSocket credentials in the Authorization header, with the
header authoritative when both authentication forms are present. Deploy this
API before updating daemons to the header-only client. Older query-authenticated
clients remain supported during migration and their use is reported so operators
can verify the fleet before retiring that reader.

Scrub credentials before runner diagnostics reach console, OpenTelemetry or
Sentry. This includes old runner log tails, encoded and repeated query tokens,
headers, exception stacks and nested log values. HTTP spans omit standalone
query attributes. Existing exposed daemon credentials still need rotation after
the affected daemons have upgraded.
