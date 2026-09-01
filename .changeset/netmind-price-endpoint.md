---
'@manyfold/api': patch
---

The NetMind price table now reads from that platform's new gateway. NetMind moved its client API off the old Java gateway, and the price endpoint did not survive the move as-is: `POST platform-api.netmind.ai/inference/modelPrice` has no route on the new host — a request there falls through to the catch-all middleware and answers `403 {"message":"Invalid API key"}`, which is a missing path rather than an auth failure (an invented path answers identically). The replacement is `GET inference.api.netmind.ai/v1/price/model`, still unauthenticated, and it publishes the category groups at the top level instead of wrapping them in `data`.

The rows inside are unchanged, so the parser now accepts either envelope and everything downstream of it is untouched: the `1M Tokens` billing_type filter, the four named keys of `price_details[0]`, the per-million division, and the deliberate refusal to walk `member_price` or the competitor blocks (all of which are still present, in identical counts, on the new host). Verified against both live origins with the shipped parser: 84 models each, same key set, identical rates.

The snapshot parse version is bumped with it. That field normally tracks a change in what the parser stores, and here the stored output is byte-identical — but a snapshot row written from the old origin also carries a fresh `fetchedAt`, and `loadSource` returns early inside the 24h TTL, so without the bump a deploy could keep serving the dead endpoint's table for a day. The bump forces one refetch at boot. A refresh that somehow parses to nothing still keeps the current table and logs a warning rather than zeroing prices, so the fleet-visible signal for this change is the `netmind` source's `entryCount` staying put with a fresh `fetchedAt`.

The NetMind key-management API moved hosts too, but that base URL is an operator setting rather than a constant, so it needs no code change.
