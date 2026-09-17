---
"@manyfold/api": patch
---

Retain the latest daemon hello across runtime preparation and failed open-turn lookups, retrying once per connection until the database recovers without requiring another reconnect. Release historical inventory after a successful lookup and discard retired connection evidence without disrupting newer connections.
