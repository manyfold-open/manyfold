# agy 1.2.11 captures

Real `agy` output, captured 2026-09-26 in a `node:22-slim` container
(linux/arm64, `--network none`, a throwaway HOME) with the release binary
`agy_cli_linux_arm64.tar.gz` of `google-antigravity/antigravity-cli` 1.2.11.
agy ran in API-key mode (`{"modelProvider":"gemini"}` in its settings,
`GEMINI_API_KEY=stub-key-<scenario>`) against a local Gemini API stub on
`GOOGLE_GEMINI_BASE_URL`, which picked the scenario from the key, so no real
key or account reached agy and every model reply is the stub's.

Every run used:

```
agy --output-format stream-json --input-format stream-json \
    --dangerously-skip-permissions --disable-slash-commands [--conversation <id>]
```

with one `{"event":"user","message":{"content":"…"}}` line on stdin, then EOF.

| File | Scenario | Exit |
|---|---|---|
| `resume-turn-1.*` | plain text turn, new conversation | 0 |
| `resume-turn-2.*` | the same conversation resumed in a new process (`result.usage` is the whole conversation's) | 0 |
| `resume-unknown-conversation.*` | `--conversation` naming an id agy does not know: warning on stderr, new id in `init` | 0 |
| `turn-tool.*` | one `run_command` | 0 |
| `turn-multitool.*` | `run_command`, `write_to_file`, a failing `run_command` | 0 |
| `turn-provider-401.*` | stub answers 401 | 3 |
| `turn-pool-empty-503.*` | stub answers 503 `Service temporarily unavailable`, `AGY_CLI_MODEL_API_MAX_RETRIES=0` | 3 |
| `turn-unknown-model.*` | `--model not-a-model` | 1 |
| `turn-sigterm.*` | SIGTERM while the model streams | 1 |
| `turn-sigkill.*` | SIGKILL while the model streams | 137 |
| `turn-signed-out.*` | no key and no sign-in on the host | 1 |

`transcripts/` holds the conversation logs agy wrote for some of those runs,
copied from `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/`:

| File | Conversation |
|---|---|
| `multitool.transcript_full.jsonl` | `turn-multitool`, the full log (tool arguments as values) |
| `multitool.transcript.jsonl` | the same, the compact log (tool arguments JSON-encoded) |
| `resumed.transcript_full.jsonl` | four turns, each resumed in a new process; agy notes each restart as a system message |
| `killed-then-resumed.transcript_full.jsonl` | a turn killed with SIGKILL before the model answered, then the next turn |
