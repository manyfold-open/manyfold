---
'@manyfold/cli': minor
---

A `401` for a token of the wrong kind now says what it needs. Endpoints such as your computers and the version lists answer a scoped or agent token with "this endpoint requires api.full token"; the hint used to say "Run mf login to sign in again", which changes nothing for a valid token. It now says the call needs a login session (`mf login`) or a full-access token.
