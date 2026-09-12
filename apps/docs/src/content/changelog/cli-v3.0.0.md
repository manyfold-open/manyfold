---
version: '3.0.0'
date: '2026-09-12'
---

The CLI now requires the current Manyfold API contract. Upgrade the API before
upgrading the CLI when running a self-hosted installation.

`mf whoami` uses `/api/auth/whoami` exclusively. A missing endpoint fails with
HTTP 404 instead of retrying `/api/auth/me` and constructing a legacy identity.
Login and setup continue to use their existing account endpoint.

Structured API errors must contain a nested `error` object. Legacy top-level
`code`, `message`, and `details` fields are no longer interpreted as error
metadata. When an error response does not follow this contract, the CLI uses
the HTTP status and does not print the unparsed response body.

Existing profiles, runtime credentials, and current identity kinds remain
valid. See the self-hosting upgrade instructions before crossing older API
migration boundaries.
