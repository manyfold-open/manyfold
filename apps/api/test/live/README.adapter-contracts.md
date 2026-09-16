# CLI Adapter Acceptance

Run the local acceptance entry from the repository root after building API dependencies:

```sh
pnpm exec turbo build --filter='@manyfold/api^...'
RUN_CLI_ADAPTER_E2E=1 pnpm --filter @manyfold/api exec \
  node ../../scripts/test-sealed-env.mjs -- node --import tsx \
  test/live/cli-adapter-contracts.e2e.ts /tmp/adapter-contracts-report
```

The default image `mf-acceptance-gemini:0.54.4` is a retained local QA artifact,
not a publicly downloadable image. Its exact ID is checked for historical reruns.
Other maintainers can build an equivalent fixture from the pinned public Node
base and published Gemini package, then select it explicitly:

```sh
docker build -t mf-cli-adapter-fixture:0.54.4 \
  -f apps/api/test/live/fixtures/gemini-tool-wire.Dockerfile \
  apps/api/test/live/fixtures
GEMINI_CLI_FIXTURE_IMAGE=mf-cli-adapter-fixture:0.54.4 \
  RUN_CLI_ADAPTER_E2E=1 pnpm --filter @manyfold/api exec \
  node ../../scripts/test-sealed-env.mjs -- node --import tsx \
  test/live/cli-adapter-contracts.e2e.ts /tmp/adapter-contracts-report
```

This rebuild is behavior-equivalent, not a claim of the historical image's byte
identity. Every report records the actual image ID and checked CLI version.
`GEMINI_CLI_FIXTURE_IMAGE_ID` optionally pins any explicitly selected image.
The Google-compatible provider and actual Gemini CLI run together inside an
exclusive `--network none` container. Both CLI turns, including `--resume latest`,
execute only a fixed `printf` command. No user credential is read or recorded.
The API adapter then consumes and replays those actual stdout bytes. The Codex
leg consumes a controlled exit-1 child and reads normalized JSON terminal files.
That is adapter/serialization evidence, **not a Chat database or staging test**.
The runner removes its own container; the requested report directory remains.

## Release-Owner Staging Checks

Use an independently registered Docker QA daemon/profile and fixture-only agents
against the deployed API revision. Do not override a host's installed Codex or
reuse a user's daemon/profile. Mount `fixtures/codex-failure-shim.mjs` as the
executable `codex` inside that owned runtime (with a Node shebang wrapper if the
read-only mount is not executable). Set these fixture-container variables:

```sh
RUN_CODEX_FAILURE_FIXTURE=1
CODEX_FIXTURE_FAILURE=overload  # repeat with throttle and ordinary
CODEX_FIXTURE_CALL_LOG=/tmp/codex-fixture-calls.ndjson
CODEX_FIXTURE_DELAY_MS=0
```

This shim has no model/network client and cannot create provider charges. Use
runtime-local credentials/configuration, then send a fixed QA prompt through a
new Manyfold Chat session. The shim emits a thread ID, an unrelated startup
warning and a structured `turn.failed`. A second explicit send in that same
session exercises the framework `exec resume` command. Inspect the invocation
log: one exec per explicit send, the same thread ID, no automatic retry.

For adapter transport resume, set a delay (at most 60 seconds), interrupt only
the fixture daemon's transport while its exec is retained, then reconnect it.
Require a recorded suspended/adopted execution and resume cursor before counting
this case; a browser SSE reconnect alone is not adapter resume. Also cancel one
delayed fixture turn through the ordinary Chat cancel action and verify no
post-cancel replay or session-ref clearing. Restore the fixture transport and
remove the fixture agents, registration and container after readback.

Read the actual durable terminal in the staging database, scoped to the QA
session and assistant message (psql variables supplied by the release owner):

```sql
SELECT message_id, seq,
       payload_json->'error'->>'code' AS code,
       payload_json->'error'->>'cause' AS cause,
       payload_json->'error'->>'retryable' AS retryable
FROM chat_stream_events
WHERE session_id = :'qa_session' AND message_id = :'qa_message'
  AND event_type = 'error'
ORDER BY seq;

SELECT framework_session_ref
FROM chat_sessions WHERE id = :'qa_session';
```

Expected overload: `codex_provider_overloaded`, `provider_overloaded`, `true`.
Expected throttle: `codex_rate_limited`, `rate_limited`, `true`. Ordinary exit 1
remains `codex_exec_failed` and `false`. Verify distinct cause-only Sentry
fingerprints, no opaque IDs/detail in indexed tags, and unchanged account-pool
breaker state. Record the exact API revision, fixture invocation count, retained
framework ref, terminal SQL rows and cleanup result. These remain deployment
acceptance gates until performed against the released staging revision.
