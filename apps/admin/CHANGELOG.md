# @manyfold/admin

## 0.29.0

### Minor Changes

- [#176](https://github.com/manyfold-open/manyfold/pull/176) [`5e61a09`](https://github.com/manyfold-open/manyfold/commit/5e61a092ffbdab0508c917b8323786b2246affa3) Thanks [@yingca1](https://github.com/yingca1)! - Show each turn's prompt and result on the admin chat-session page.

    The page had three cards — Session, Turns, Events — and none of them showed a
    line of message body. The Turns table identified a turn by a bare UUID, so the
    first question anyone opens the page with ("what did the user ask, and what did
    the agent answer?") could only be answered by reading `token` event payloads
    back one row at a time, and only for as long as those rows exist.

    A Transcript card now sits between Turns and Events, pairing each assistant
    turn with what was sent to produce it, newest first, 20 turns to a page. Each
    entry carries the same figures as the table row above it — state, model,
    tokens, cost, TTFT, duration — plus a `Trace events` button that drives the
    Events card's existing per-turn filter, so one click gets you the prompt, the
    answer and the event trace for the same turn.

    It reads `chat_messages.content_blocks_json`, which outlives the event log:
    stream-log compaction deletes a turn's token and thinking rows, so for a
    compacted turn these blocks are the only surviving copy of what it produced.
    The card says so.

    The result renders as the answer text the user saw, with `thinking`,
    `tool_call` and `tool_result` blocks folded behind a toggle that names what it
    holds (`1 thinking block · 2 tool calls · 2 tool results`) — a coding turn with
    forty tool calls would otherwise bury the answer it is supposed to show. An
    unrecognised block kind keeps its raw type and renders as JSON rather than
    being dropped: the column is jsonb, and a row recovered from a runtime session
    file is not this build's to assume.

    Three states that used to be indistinguishable now say which they are. A turn
    whose prompt row retention has already deleted reports that, instead of
    borrowing the previous turn's prompt or rendering blank — retention deletes
    `chat_messages` in batches, so a turn really can outlive its own prompt. A
    still-streaming turn says it is streaming rather than claiming it produced
    nothing, because the blocks are written at the terminal event. A turn that
    genuinely produced no answer text says that.

    `GET /admin/chat-sessions/:id/turns?limit=&before=` is the new endpoint behind
    it, keyset-paged on `(created_at, id)` like the share transcript it mirrors.
    Content stays off `GET /admin/chat-sessions/:id`, whose response already
    carries up to 100 turns and would grow by tens of kilobytes each. A turn's
    input is the messages between the previous assistant message and this one —
    normally one user message, but a recovered transcript can carry a system
    preamble and more than one prompt, and they arrive in the order the agent
    received them.

## 0.28.2

### Patch Changes

- [#155](https://github.com/manyfold-open/manyfold/pull/155) [`f052ae2`](https://github.com/manyfold-open/manyfold/commit/f052ae2fad5ff5146b0217d001b5b4e4abf410c5) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Retire the ALL-CAPS micro-label.

    Kickers, stat labels, table heads, landing eyebrows and badges all ran
    uppercase at `tracking-[0.18em]`. At workbench density that reads as
    shouting, and it made the same label look like a different kind of thing
    depending on which surface it landed on. They are now sentence case at
    normal tracking — the rule the tag family (DESIGN.md §8.3) has always
    followed, now binding on every label in the product and on landing.

    Caps and wide tracking come out together: the tracking only ever existed to
    give capital letterforms air, so it has nothing to do once the caps are
    gone. Source strings were already authored in sentence case (`Cost`, `Input
tokens`, `Manyfold · agent hosting & delivery`), so nothing needed
    retranslating and the label now reads the same in the DOM, on screen and to
    a screen reader.

    DESIGN.md §5 and DESIGN.landing.md §5.3 carry the rule; the two registers
    agree on it.

## 0.28.1

### Patch Changes

- [#107](https://github.com/manyfold-open/manyfold/pull/107) [`5e05489`](https://github.com/manyfold-open/manyfold/commit/5e05489ad70cea56be02bc35da178248768f6041) Thanks [@yingca1](https://github.com/yingca1)! - Signing in returns you to the link you opened.

    Opening a page that needs an account while signed out sent you to the sign-in
    form and then dropped you on the workspace, so a shared link like
    `/agents/new?framework=narranexus` was only useful to someone already signed
    in — the path and everything after the `?` were discarded before the page ever
    loaded. The attempted address now travels with you and is restored once you are
    in, whichever way you sign in: password, a new account plus its verification
    code, Google, SSO or NetMind. That covers every page behind sign-in, so a link
    to a specific chat, a filtered list, or the connection you just authorised
    survives the detour, and a session that expires mid-visit resumes where it
    left off instead of at the top.

    The admin console does the same. Its sign-in page previously ignored a return
    address entirely, and its Google/SSO round trip only remembered which app you
    came from, not which page.

    Only in-app paths are honoured, unchanged from before: an absolute URL in the
    return address is refused rather than followed.

## 0.28.0

### Minor Changes

- [#82](https://github.com/manyfold-open/manyfold/pull/82) [`95c70a4`](https://github.com/manyfold-open/manyfold/commit/95c70a46389e4725272ee3e484196defcaa565f1) Thanks [@yingca1](https://github.com/yingca1)! - The hermes dashboard Enable/Disable and Open controls are shown only for sprite runtimes; k8s runtime rows keep showing the (always disabled) dashboard fact, since k8s dashboard hosting was removed.

## 0.27.6

### Patch Changes

- [#75](https://github.com/manyfold-open/manyfold/pull/75) [`7ae7ca6`](https://github.com/manyfold-open/manyfold/commit/7ae7ca63358595e0f2507f22fad9c95d60a9dea2) Thanks [@yingca1](https://github.com/yingca1)! - Retire the legacy `A2A_TURN_TIMEOUT_MS` env fallback: a startup migration moves a still-set value into the `a2a_turn_timeouts` admin setting exactly once (never overwriting an admin's save), clamping it to the setting bounds (30s floor; 1h blocking / 24h async caps — out-of-range values change behavior and are logged), and the resolver now falls back to code defaults instead of the env var when the setting is absent. The API also warns at startup for every legacy `NCA_*`/`WEB_BASE_URL` env alias still set (key names only) and emits a telemetry event when a Lark channel delivers a pre-2.0 legacy-schema message, so both compatibility windows finally have usage signals. The daemon now advertises the `turn.budgets` capability (it has parsed split turn budgets since [#513](https://github.com/manyfold-open/manyfold/issues/513)/[#556](https://github.com/manyfold-open/manyfold/issues/556) — this makes that queryable), and `MF_CHAT_STREAM_FLUSH_MS` / `MF_TURN_ADOPT_REPOLL_MS` are documented in `.env.example`.

## 0.27.5

### Patch Changes

- [#55](https://github.com/manyfold-open/manyfold/pull/55) [`d01d06b`](https://github.com/manyfold-open/manyfold/commit/d01d06b3454d99a0a5d156535fc50b0c1c0df400) Thanks [@yingca1](https://github.com/yingca1)! - Self-hosted accounts created before the deployment set `MF_DEFAULT_PLAN_ID`
  no longer keep cloud `free` limits forever. That variable only ever applied to
  the `users` INSERT, so an account created by an older self-host stack landed
  on `free` and nothing — not upgrades, not migrations, not logging back in —
  ever moved it. The symptom was a quota error naming a plan the operator never
  chose, such as `External API limit reached (3 for Free plan)` when adding a
  fourth Dify / Langflow / A2A agent. On the first start after upgrading, a
  deployment with no billing module and `MF_DEFAULT_PLAN_ID` set to something
  other than `free` moves every remaining `free` account to that plan. It runs
  once, claims its marker in the same transaction as the update, and records the
  move in the audit log — so a later deliberate assignment is never overwritten,
  and a cloud deployment is never touched.

    The admin console gains a **Plan** card on user detail, backed by
    `GET /admin/plans` and `PATCH /admin/users/:id/plan`. Until now the
    open-source composition root had no way to change a user's plan at all, since
    plan changes lived only in the cloud billing module; recovery meant editing
    the database by hand. The route refuses on deployments where billing owns the
    assignment, so a subscription can't be silently desynced from what a user pays
    for.

    `MF_SELFHOST_DEFAULT_PLAN_ID` now overrides the compose stack's default tier
    for new accounts, and self-hosting docs cover how to read and change a user's
    plan.
