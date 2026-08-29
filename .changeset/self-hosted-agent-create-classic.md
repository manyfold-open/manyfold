---
'@manyfold/web': minor
---

Self-hosted builds open the classic create-agent form.

`/agents/new` picks one of three forms from the `agent_create_ux` experiment
assignment. Assignment is cloud-side operations tooling — a self-hosted API
answers `/auth/me` with an empty map — so on this edition the code fallback is
the whole decision, and that fallback was v3, the newest challenger.

The fallback is now an editions slot. A self-hosted deployment opens the
classic form; the cloud composition shadows the slot with its own fallback, so
the cloud build is unchanged. Previewing another form with
`?variant.agent_create_ux=<id>` still works for admins on either edition.
