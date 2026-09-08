// Codex prints every failed `thread/resume` the same way — `thread/resume
// failed: <reason> (code N)` — whether the reason is a rollout it cannot find
// or a thread somebody else is still writing. The two call for opposite
// responses (drop the ref / keep the ref and wait), so the adapter's self-heal
// and the failure-cause classifier both key on the REASON and never on that
// shared wrapper, and both read it from here so the two cannot drift.
//
// Case-insensitive: the adapter tests raw stderr, the classifier tests the
// lowercased message.

// The thread is intact and held: codex admits one writer per thread and refuses
// the second. Seen on production [2026-09-07]: `thread/resume failed during TUI
// bootstrap: thread/resume failed: thread <id> already has an active writer
// (code -32600)`.
export const CODEX_THREAD_BUSY_SIGNATURE = /already has an active writer/i

// The rollout is gone or unreadable, so no later turn can ever resume it.
// Positive evidence only. A resume can fail on things that prove nothing about
// the rollout — a writer-lock file the runtime could not create or lock, the
// busy refusal above — and they arrive in the same wrapper; clearing the ref
// over one of those forks a live conversation onto a fresh thread.
export const CODEX_RESUME_LOAD_FAILURE_SIGNATURE =
    /no rollout found for thread|failed to read thread/i
