# @manyfold/web

## 0.49.0

### Minor Changes

- [#94](https://github.com/manyfold-open/manyfold/pull/94) [`69da61c`](https://github.com/manyfold-open/manyfold/commit/69da61c24ea6a02f0b002a7d38c79603752ebee2) Thanks [@yingca1](https://github.com/yingca1)! - The classic create-agent form takes the newer form's shape.

    **Framework** is a dropdown — logo and name per row — instead of a collapsible
    tile grid, so picking one costs a row rather than a panel that pushes the rest
    of the form off screen. The comparison table is unchanged.

    **Runtime** no longer hides behind a disclosure and a Sandbox / Computers tab
    pair. Every place an agent can land is one list — cards or a table, remembered
    per device the way the runtimes dashboard remembers it — with an always-on
    filter by kind, and pagination once there are more than eight targets. A row
    carries what picking it turns on: its kind, its status, and who already lives
    on that machine, one entry per framework with that framework's agent count.
    The picker opens with a target already selected when it has one to offer, so
    the form is submittable rather than silently blocked on a choice it never
    named.

    Provisioning a runtime happens where the list ends, not as a row inside it.
    A sandbox is created from a dialog that prefills the name the server would
    have generated and leaves it editable; a machine is connected through the same
    dialog the newer form uses. Both then reload the list, select what they made,
    and page to it. Renting a cloud computer still leads to its own page.

    **Model provider** is its own section instead of a dialog behind a "Configure
    provider" link inside a runtime card, and it no longer disappears when an
    existing runtime is picked. Adding an agent to a runtime inherits that
    runtime's provider, so that is what the section says — with the agent's own
    model editable beside it, and a Change control that sets a different provider
    for real. Changing it issues the same request the agent's credentials dialog
    does, which replaces the credentials stored for that runtime, so the section
    says that too. Narranexus and the external frameworks do not get the control,
    because the API refuses it for them.

    The workspace path moves out of the per-card property grid into a single row
    under the runtime list, since only the selected target's path was ever
    editable.

    Nothing about the created agent changes: same request body, same provider
    gating, same quota limits. Two pieces of chrome are gone — the Sandbox /
    Computers tabs, and the "select a self-owned computer" holding state — and an
    unattached sandbox mode no longer means "provision one on submit", so the form
    waits for a target instead of quietly creating a runtime nobody asked for. The
    36 catalog keys only the removed chrome used are deleted from all eleven
    locales.

- [#94](https://github.com/manyfold-open/manyfold/pull/94) [`69da61c`](https://github.com/manyfold-open/manyfold/commit/69da61c24ea6a02f0b002a7d38c79603752ebee2) Thanks [@yingca1](https://github.com/yingca1)! - Self-hosted builds open the classic create-agent form.

    `/agents/new` picks one of three forms from the `agent_create_ux` experiment
    assignment. Assignment is cloud-side operations tooling — a self-hosted API
    answers `/auth/me` with an empty map — so on this edition the code fallback is
    the whole decision, and that fallback was v3, the newest challenger.

    The fallback is now an editions slot. A self-hosted deployment opens the
    classic form; the cloud composition shadows the slot with its own fallback, so
    the cloud build is unchanged. Previewing another form with
    `?variant.agent_create_ux=<id>` still works for admins on either edition.

### Patch Changes

- [#94](https://github.com/manyfold-open/manyfold/pull/94) [`69da61c`](https://github.com/manyfold-open/manyfold/commit/69da61c24ea6a02f0b002a7d38c79603752ebee2) Thanks [@yingca1](https://github.com/yingca1)! - Connect-a-machine commands name the deployment they belong to.

    The install line handed out by Connect a new computer, and the token pair in
    Settings, were the hosted platform's commands verbatim. A fresh `mf` defaults
    to the hosted API, so on any other deployment the copied command installed the
    CLI and then registered the machine against manyfold.ai — a daemon that
    connects, reports healthy, and belongs to a different platform than the page
    that produced the command.

    Every command now carries `--api-url` with the API base the page itself is
    talking to, unless that base already is the CLI's default, which keeps the
    hosted commands byte-identical to what they were. The flag also outranks a
    profile's stored URL, so a machine that has signed in elsewhere still lands on
    the right deployment.

    The URL is resolved from the bundle's own API base: baked for a split-origin
    build, the page's origin plus `/api` for a same-origin one — the same URL the
    browser just used, and the only one it can vouch for.

## 0.48.0

### Minor Changes

- [#97](https://github.com/manyfold-open/manyfold/pull/97) [`6510fb7`](https://github.com/manyfold-open/manyfold/commit/6510fb7b1709402ca45062bb37db592d956c6d89) Thanks [@yingca1](https://github.com/yingca1)! - Hermes chats gain interactive permission approval. The composer's permission menu now works for hermes with three modes mirroring hermes's own edit-approval trio — "Ask for approval", "Accept edits", and "Don't ask" (the default, byte-identical to the previous always-YOLO behavior for every caller that sends no mode). In the ask modes the turn drops `HERMES_YOLO_MODE`, aligns the session via ACP `session/set_mode`, and surfaces `session/request_permission` as an interactive card in the transcript instead of auto-approving; the card's request and settlement persist as stream events AND content blocks, so it survives reconnects and history, and a turn that ends without a resolution renders the card inert. Answers are delivered with `POST …/messages/:messageId/permissions/:requestId` and routed like cancel: the in-process coordinator first, the carrying daemon via the new `turn.permission` RPC second, and a durable `chat_permission_answers` row plus pg NOTIFY for a peer-owned interactive turn (the composite PK makes the second answer a 409 — first click wins). An unanswered ask denies after `HERMES_PERMISSION_TIMEOUT_MS` (default 5 min) with the request's own reject option, and pending asks tick the turn's inactivity budget so a human deciding never reads as a hang. Ask modes on a daemon without the new `turn.hermes.permissions` capability are refused with `hermes_daemon_permissions_upgrade_required` — never silently downgraded to YOLO. The daemon publishes a synthetic `_manyfold/permission_resolution` line into the exec buffer before the child's reply, so a replayed stream reproduces the settlement in live order.

- [#98](https://github.com/manyfold-open/manyfold/pull/98) [`5701b2f`](https://github.com/manyfold-open/manyfold/commit/5701b2fa489aefb84350e2eb9ba7162849fc7218) Thanks [@yingca1](https://github.com/yingca1)! - Hermes chats can switch models per message. The composer's model menu now works for hermes agents (options come from the agent's provider-models cache, which the model-config view serves for hermes too, with a filter box once the list grows past a screenful), and the choice is applied via ACP `session/set_model` — hermes persists a session's model in its own state.db, so env vars cannot move a resumed session. Every transport reconciles by diffing against the models state hermes reports on session/new|resume: an untouched session costs no RPC, and picking "Default" re-sends the default's id because a hermes session would otherwise keep the previous pick under a UI that claims otherwise. Daemon-carried turns gate on the new `turn.hermes.options` capability: an explicit switch on an older daemon is refused with `hermes_daemon_options_upgrade_required` (never silently dropped), while the auto-defaulted value skips quietly; a hermes build that predates `session/set_model` fails an explicit switch as `hermes_set_model_unsupported`. The daemon reports the session's models/modes state on the turn final, captured best-effort into `agents.extras.hermesAcp` for diagnostics.

### Patch Changes

- [#95](https://github.com/manyfold-open/manyfold/pull/95) [`bec1b35`](https://github.com/manyfold-open/manyfold/commit/bec1b356edf0467c51632946050a1a8858245a6b) Thanks [@yingca1](https://github.com/yingca1)! - Hermes chat turns now show tool outputs and stop silently denying file edits. The ACP decoder maps terminal `tool_call_update` frames to `tool_result` events (in their own `hermes-acp-x-<n>` ordinal namespace, so a cross-deploy resume cannot re-key rows the old decoder already wrote), and both ACP clients answer `session/request_permission` with an option the request actually offers — the previous hardcoded `approve_for_session` matches no option id current hermes builds advertise, and an unknown id maps to deny on both of hermes's approval bridges, which rejected every file edit on up-to-date hermes images. Billing now also decodes the `cachedReadTokens`/`cachedWriteTokens` spellings the acp 0.9.0 prompt ack uses, so cache tokens stop falling out of usage records. Hermes's streamed `usage_update` ({used} of {size} context-window pressure — not billing) is no longer discarded: the turn's final reading lands on the assistant message and the message-details popover shows a context row.

## 0.47.0

### Minor Changes

- [#88](https://github.com/manyfold-open/manyfold/pull/88) [`5ba3eb6`](https://github.com/manyfold-open/manyfold/commit/5ba3eb6ca97cb7716e0e30f78a4f616e261b9a32) Thanks [@yingca1](https://github.com/yingca1)! - Settings -> API tokens gets a rail, a dashboard and a per-token page.

    It was a single page: a create form stacked on a flat list of rows, each row
    cramming the name, status, scopes, four timestamps and the token id onto two
    lines, with nowhere to click through to. It now uses the same two-pane shape as
    Runtimes, Channels and Model providers — a rail of tokens on the left, a
    dashboard when nothing is selected, and the selected token in the pane.

    **Rail.** A flat list by default, with Group by offering Status, Scopes and
    Expires — the same control the other three rails have, remembered per device,
    with expand/collapse all and the selected token's group revealed on a deep
    link. Grouping by Expires answers the question this list exists for: which
    tokens never die.

    **Dashboard.** Counts by status across the top, then every token as a card or a
    table row (grid/list toggle remembered per device): status, how many scopes, when
    it was last used, when it expires.

    **Token page.** Three things the old list never showed: which agent a token is
    bound to and whether that binding is enforced, where it was created from
    (`cli-poll`, `user-grant`, `cli-browser`, `api`), and what each scope actually
    permits — rendered with its summary and risk level instead of a bare machine
    string. The usage section says plainly what is known: only a token's last-used
    time is recorded, not individual requests, so there is no per-request log to
    show.

    **Create.** `/settings/api-tokens/new` moves the form into the pane. The
    one-time secret is shown there with its Copy button and stays until you leave
    the page — previously it rendered inline underneath the form and was never
    cleared, so it sat on screen for the rest of the visit.

    Revoking still asks for confirmation; afterwards the token's row and page show
    Revoked with the time, instead of a banner that scrolls away.

- [#88](https://github.com/manyfold-open/manyfold/pull/88) [`5ba3eb6`](https://github.com/manyfold-open/manyfold/commit/5ba3eb6ca97cb7716e0e30f78a4f616e261b9a32) Thanks [@yingca1](https://github.com/yingca1)! - Channels and model providers each get a dashboard, and their rails become
  plain lists.

    **The rails.** Settings -> Channels opened grouped by platform under a search
    field and All / Active / Issues chips; Settings -> Model providers opened
    under a search field and a single collapsible "Your providers" group that
    never had a second group to sit beside. Channels' Group by now offers None
    and defaults to it — one flat list, most recently updated first, each row
    carrying its platform and its agent — and both search boxes, the status chips
    and the providers group header are gone. Platform / Agent / Status grouping on
    channels are unchanged, and grouping by status still gathers the paused and
    errored channels together. Because the grouping is remembered per device, the
    channels store key moved to v2: browsers that had already chosen a grouping
    start again on None.

    **The dashboards.** Both areas now open on an overview instead of a
    "nothing selected" panel, the way Settings -> Runtimes already did, with a
    grid/list toggle remembered per device and a create button in the header.

    Model providers shows spend, tokens, requests and last use per configured
    provider over a 7-day, 30-day or all-time window. Spend that could not be
    attributed to a provider — turns whose agent had no provider bound, or whose
    provider was deleted — gets its own row rather than quietly vanishing from the
    total. Turns with no recorded cost are never counted as free: a provider whose
    cost is entirely unknown reads as a dash, and a partially-priced one carries an
    "N unpriced" tag saying the amount is a lower bound.

    Channels shows each channel's status, its message count, when it last carried
    a message, and its agent. The count covers a window because delivery history
    is pruned, and the label states the window the deployment actually keeps
    rather than assuming 30 days. The last-message time is not windowed, so a
    channel can honestly show no messages this month and still say when it last
    spoke.

### Patch Changes

- [#88](https://github.com/manyfold-open/manyfold/pull/88) [`5ba3eb6`](https://github.com/manyfold-open/manyfold/commit/5ba3eb6ca97cb7716e0e30f78a4f616e261b9a32) Thanks [@yingca1](https://github.com/yingca1)! - Self-hosted builds no longer offer billing controls that only redirect.

    Billing — plans, pricing, container purchase — is a cloud surface: the
    open-source API has no billing routes, and every page under
    `/settings/plan-and-billing` is a stub that navigates back to `/settings`. Six
    places linked into it anyway, so a self-hosted user could reach a control that
    bounced them straight back:

    - the **Plan & billing** entry in the settings sidebar
    - **View plans** on the quota-limit dialog
    - **Upgrade** in the active-hours warning on the concurrency popover
    - **Rent a persistent container** in all three agent-create surfaces

    All six now check one build-time capability. On a self-hosted build the sidebar
    shows seven entries, the quota dialog offers only Close, the active-hours
    warning still appears without a call to action, and agent create no longer
    advertises a purchase flow that does not exist there. The cloud build is
    unchanged.

    Two related corrections. The **Sandbox usage** page is reachable from the
    runtimes dashboard in both editions, but its breadcrumb always named Plan &
    billing as the parent; on a self-hosted build it now names Runtimes, which is
    where the page is actually reached from. And agent create's persistent-runtime
    option is no longer disabled behind a rent link on self-hosted installs, where
    containers are provisioned on the fly rather than purchased — it is selectable,
    as it always should have been.

## 0.46.0

### Minor Changes

- [#82](https://github.com/manyfold-open/manyfold/pull/82) [`95c70a4`](https://github.com/manyfold-open/manyfold/commit/95c70a46389e4725272ee3e484196defcaa565f1) Thanks [@yingca1](https://github.com/yingca1)! - Login no longer mints dashboard cookies or follows absolute redirect URLs — the `rd` parameter and the `*.manyfold.ai` absolute-URL allowance existed only for the removed k8s hermes dashboard bounce, and `redirect_url` now accepts internal paths only. The hermes dashboard toggle is shown only for sprite runtimes.

## 0.45.0

### Minor Changes

- [#54](https://github.com/manyfold-open/manyfold/pull/54) [`f5b6347`](https://github.com/manyfold-open/manyfold/commit/f5b634742aa4bf76ebea6df73c7f52a6fcd8c311) Thanks [@yingca1](https://github.com/yingca1)! - Local config is now checked before it is trusted, and you can pick a model from
  it.

    The "Local config" model source used to treat the presence of a config
    directory as proof of a working login. Claude Code needed only `~/.claude` to
    exist; Codex accepted an `auth.json` it could not even parse; Gemini read
    `oauth_creds.json` without ever looking at the `expiry_date` inside it. On top
    of that the source skipped model validation entirely, so a signed-out machine
    advertised itself as ready and the failure only surfaced when a message was
    already on its way.

    Both inspect paths now report what they actually found — whether a token is
    present, when it expires, whether a refresh token can renew it, which
    third-party gateways `~/.codex/config.toml` configures — and the verdict is
    computed from those facts. Because the facts carry timestamps rather than a
    yes/no, a snapshot taken an hour ago stops claiming a live token without
    needing to be re-inspected. A sign-in that has expired with no way to renew is
    now reported in the composer and refused at send time; the refusal re-inspects
    the runtime first, so signing in again on that machine is enough to clear it.

    Two situations deliberately stay permissive. A daemon older than this change
    reports no facts, and a macOS host keeps its Claude token in the keychain,
    which a background daemon must not prompt for — neither can be judged, so
    both keep working exactly as before.

    Picking a model under "Local config" works now. The models your CLI reported
    are listed in the composer, alongside Claude's effort and Codex's speed and
    reasoning level, each with a "CLI default" entry that hands the decision back
    to the local CLI. Nothing is filled in on your behalf: a knob you never set
    sends no flag at all. `/model` in a channel and `mf model-config update
--model` set the model too — until now they reported success and silently
    discarded it.

    The concrete model id you pick is passed through as-is. The hosted path maps a
    version onto its family alias (`claude-sonnet-4-5` became `--model sonnet`)
    because it repoints that alias through the environment; a local CLI has no
    such indirection, so an agent whose stored model was a full id now runs that
    exact version.

    Also fixes the sandbox copy of the inspector, where an over-escaped pattern
    made `requires_openai_auth = true` unmatchable, letting a hosted runtime treat
    `OPENAI_API_KEY` as usable even when the local config required a ChatGPT
    sign-in.

## 0.44.1

### Patch Changes

- [#52](https://github.com/manyfold-open/manyfold/pull/52) [`4ec11cb`](https://github.com/manyfold-open/manyfold/commit/4ec11cbf77a7fa0604bc9a784832e522882ad932) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - One footer across both sites, and "Cookie settings" stops being the one entry
  in the row that looks different.

    The landing's footer and the docs' had drifted apart in wording and in metrics
    alike. The docs side called the same destination "Documentation" where the
    landing calls it "Docs" — the one long label in a row of short nouns — carried
    an "Ask AI" entry with no counterpart on the landing, was missing Agent
    Challenge, and credited "Netmind" where the landing credits the brand, which is
    also the name the white-label substitution knows how to rewrite. Underneath the
    copy: 13px links with no tracking against the landing's 14px at -0.005em, a
    brand mark that skipped the step down the landing applies in the footer (28px
    against 24px), a copyright line and a social pair each set a tone paler than
    the links beside them, and the hairline before that pair sitting 10px closer to
    them. All of it now matches, and the row folds at the same two widths, which it
    had not been doing at all — it kept its desktop metrics down to 375px, leaving
    that hairline hanging at the start of a line once the links wrapped, with
    nothing before it to divide.

    "Cookie settings" is a button rather than a link, because it re-opens the
    consent banner instead of going anywhere, and the footer's type rule only ever
    named `a`. Preflight left the button at the body's size and full ink, so the
    one control in that row read a step larger and darker than the six links around
    it. It shares the rule now.

    Two differences are deliberate and stay. "Cookie settings" is not on the docs
    footer: that site loads no analytics and sets no cookies, so the entry would
    open nothing — the consent banner it belongs to lives on the app. The support
    chat is not there either, since every docs page already carries it as a bubble.

    The privacy policy told the reader to find that control "in the site footer",
    which was true of no footer that reader could be looking at: the policy is
    served only from the docs site, including from the landing's own Privacy link,
    so every reading of the sentence happened on the one footer without the
    control. It now names the web app and its host. The other half of the sentence,
    Settings -> Account, was and remains true.

- [#53](https://github.com/manyfold-open/manyfold/pull/53) [`5dc901b`](https://github.com/manyfold-open/manyfold/commit/5dc901b70cb3a3bcc8ac102b0f16ed445d0cc222) Thanks [@yingca1](https://github.com/yingca1)! - The runtimes page opens on a dashboard instead of silently picking a host.

    Landing on Settings -> Runtimes used to auto-select the first VM in the list
    and render its detail panel — which also fired a framework-detection round
    trip into that sandbox as a side effect of merely opening the page. There was
    no place to see all runtimes at once: connected machines, sandbox usage and
    external providers each lived on their own sub-page.

    The bare URL now shows a dashboard summarizing every runtime kind in one
    place, with a grid/list toggle (persisted per device). Sandboxes show their
    sprite status, storage, active time this period and agents; self-owned
    computers show online state, platform, mf CLI version and detected
    frameworks; the External API section lists the configured providers
    themselves — endpoint, last connection test and how many runtimes use
    each — linking to the providers page, rather than runtime rows. Each
    section carries a direct create entry for its kind,
    and the rail's New-runtime affordances (a plus in the header and the bottom
    button) open a quick dropdown menu instead of the old modal chooser. The
    list view renders each section as a proper table — per-kind columns
    (status, storage, active time, platform, mf CLI, endpoint, last test,
    agents) instead of a single compressed meta line. Cards and rows click
    through to the existing host detail, and the kind
    breadcrumb links back to the dashboard. The dashboard also has an explicit
    address — /settings/runtimes/dashboard, reachable from a new rail entry — so
    on narrow screens, where the bare URL still opens the rail, it remains one
    tap away.

    Framework detection now runs only when a sandbox is explicitly selected, so
    opening the page no longer pokes the alphabetically-first sandbox. If sandbox
    usage or the provider list fails to load, the affected columns degrade to
    placeholders instead of failing the page.

    The rail itself gets simpler: grouping gains a None option (a plain host
    tree, no group headers) and None becomes the default — the cascade store
    moves to a fresh key (`mf.runtimes.cascade.v2`) because the old one had
    auto-persisted "Kind" for every returning browser, so a fallback change
    alone would never land. The search box and the All/Ready/Issues filter
    chips are gone — the dashboard is now the place to survey and triage.

    The three create/manage surfaces move under the runtimes namespace and
    render beside the rail instead of replacing it: /settings/local-daemons
    and /settings/external-agent-providers become
    /settings/runtimes/local-daemons and
    /settings/runtimes/external-agent-providers (old URLs redirect), and
    /settings/runtimes/sandbox now keeps the rail too. Leaving one of these
    pages refetches hosts and providers, so a sandbox you just created or a
    machine you just revoked is reflected in the rail without a reload.

## 0.44.0

### Minor Changes

- [#42](https://github.com/manyfold-open/manyfold/pull/42) [`f7eb47b`](https://github.com/manyfold-open/manyfold/commit/f7eb47b09edb60a244f995d0c57dd7a6db3832d4) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - The agent create form says what a name may contain, and offers to fix one that
  does not.

    The rules — letters, numbers, emoji, spaces, underscore, dash and dot — were
    never written down anywhere on the form. The quick-create row at least turned
    red when a name broke them; the advanced form and the external-agent form
    render that same field through a different node, and that one carried no hint
    and no error. An em dash or an ampersand pasted in from a task title left the
    field looking untouched and the Create button grey, with nothing on screen to
    say why. That field now states the rules under itself and swaps them for the
    error when a name breaks them; the quick row, which stays deliberately terse,
    keeps speaking only when something is wrong. Both inputs report `aria-invalid`.

    A rejected name usually only misses by a character or two, so `suggestAgentName`
    turns it into the nearest legal one — dash lookalikes become a dash, the rest
    of the disallowed characters collapse into the spaces around them — and the
    form offers that as a one-click repair rather than rewriting what was typed.

### Patch Changes

- [#41](https://github.com/manyfold-open/manyfold/pull/41) [`859381c`](https://github.com/manyfold-open/manyfold/commit/859381ca3da64b972f29b8d7646d5d7e44810124) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - The create-agent page keeps its mobile header, so a phone cannot strand a new
  account on it.

    Below `md` the workspace collapses to a drawer and the shell's header holds the
    only button that opens it. `/agents/new` sat on the shell's list of routes whose
    page draws a header of its own — true while the v1 form did, and not true after
    the v3 rewrite, which replaced that header with none. On a narrow screen the
    page therefore rendered with no chrome at all, and an account with no agents yet
    converges on exactly that page from every direction: signed in, `/` sends you to
    the workspace, and a workspace with nothing to open sends you here. An account
    that already has an agent could still leave through the form's own close button;
    a first-time one has no such button, because there is no workspace for it to
    close back to.

    The shell draws the header for this route again, and the v1 form drops the
    duplicate it was carrying. Chat is the only route left on the list — its toolbar
    carries the menu button at every width — and a test now pins both halves of that
    deal, so the next rewrite of a page cannot quietly take the navigation with it.
    The header's title comes off the same table as the browser tab, so it reads
    "New agent" instead of repeating the brand back at itself.

- [#41](https://github.com/manyfold-open/manyfold/pull/41) [`859381c`](https://github.com/manyfold-open/manyfold/commit/859381ca3da64b972f29b8d7646d5d7e44810124) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - The mobile header is one line, and the brand sits at the top of the drawer.

    Below `md` the header stacked the page name over a brand link of nearly the
    same size and weight. It read as a subtitle — "New agent, by Manyfold" — and
    spent half a 56px bar on the one word that never changes between pages, while
    the chat page's own bar next door carries a menu button and a single title.

    The brand moves to the top of the drawer, which had none: the rail keeps it
    there on desktop, and the mobile drawer was the one place in the product
    missing it, so the link out to the marketing page is a tap further in rather
    than gone. What is left in the bar is the menu button and the page name.

- [#43](https://github.com/manyfold-open/manyfold/pull/43) [`7cf8cb0`](https://github.com/manyfold-open/manyfold/commit/7cf8cb03ef0c9de937fa69ffb74d308d2ee53e89) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - The workspace answers for itself when there are no agents yet.

    `/workspace` was a route that could not be visited. With no agent to open it
    forwarded straight to the create form, which made every "back to workspace"
    affordance a loop and forced that form to hide its own close button — there was
    nowhere to close back to. A first-time account therefore met the product as a
    form with a single button, having never seen the page that form belongs to.

    It renders a first-use empty state now, and only redirects when there is an
    agent to open. The state follows §10.7 rather than inventing its own: the
    object's own glyph, a title that names the fact, a body saying what having an
    agent gets you — its own sandbox, chat, skills, a schedule — and exactly one
    creation action inside the dashed frame that means "your action fills this".
    Because creating is something you navigate to rather than something you are
    sent to, the browser's back button now returns you to the workspace.

## 0.43.0

### Minor Changes

- [#33](https://github.com/manyfold-open/manyfold/pull/33) [`95e4991`](https://github.com/manyfold-open/manyfold/commit/95e499187d2208c7dede9d6bd216bf4c3fb522fc) Thanks [@yingca1](https://github.com/yingca1)! - Agents can now be reached from a LINE Official Account. Create a Messaging API
  channel in the LINE Developers console, paste the channel secret and a
  long-lived channel access token, and Manyfold sets the webhook URL and captures
  the bot identity for you.

    The channel works in one-on-one chats and in groups and multi-person rooms,
    with the usual allowed-user, operator and mention-only gating; group mentions
    use LINE's own `isSelf` flag rather than name matching. Inbound images, video,
    audio and files reach the turn, replies are chunked to LINE's 5,000-character
    limit, and a group reply quotes the message that triggered it.

    Two limits come from the platform. LINE has no message-edit API, so replies are
    final-only — there is no live preview. Outbound media needs publicly hosted
    URLs, so the agent's file links stay in the text. Replies are push messages and
    count against the LINE plan's monthly quota.

    Two console settings still need a human: turn **Use webhook** on (the channel's
    Test action reports when it is off) and turn auto-reply messages off, or LINE
    answers alongside the agent.

- [#32](https://github.com/manyfold-open/manyfold/pull/32) [`329ce8c`](https://github.com/manyfold-open/manyfold/commit/329ce8c974cf0e45f8f42bde959d772b370c8703) Thanks [@yingca1](https://github.com/yingca1)! - Added a WhatsApp channel. Create one under Settings -> Channels, scan the QR
  code from your phone's **Linked devices** screen, and the agent starts
  answering on that number — no token to paste, no webhook to expose, no Meta
  Business account.

    Direct messages and group chats are both supported. Groups are mention-gated by
    default (a reply to the agent counts as addressing it) and can be restricted to
    specific group jids. Allowed and operator senders accept either a phone number
    or a raw jid. Inbound images and documents reach the agent as attachments, and
    files the agent links come back as images or documents. The triggering message
    is marked 👀 while the agent works, then ✅ or ❌.

    Two things worth knowing before you link a number. Linking runs through
    WhatsApp Web, which Meta does not officially support for automated use, so use
    a number you can dedicate to the agent rather than your personal one. And if
    the linked device is later removed from the phone, the stored session cannot be
    revived — delete the channel and scan again.

## 0.42.10

### Patch Changes

- [#15](https://github.com/manyfold-open/manyfold/pull/15) [`1909ba4`](https://github.com/manyfold-open/manyfold/commit/1909ba441c54570ff977b1399c9e08d39a2afaf7) Thanks [@yingca1](https://github.com/yingca1)! - Rename the mf CLI's pre-release update channel from `staging` to `dev`
  throughout. The channel a user selects with `mf update --channel dev` and the
  name the product reports are now the same word.

    - The runtime list labels the channel "Dev" instead of "Staging".
    - `staging` stays accepted as an alias everywhere it can arrive from an older
      peer: the `--channel` flag, a saved `~/.manyfold/update-channel.json`
      preference, the `daemon.update` RPC payload, and version strings — builds
      published before this rename are versioned `x.y.z-staging.<stamp>.<sha>` and
      are still installed in the field, so they keep reading as dev builds.
    - `GET /daemon/cli-versions` gains a `dev` list; the `staging` list is retained
      as a deprecated mirror so an older web bundle keeps working against a newer
      API during a rolling deploy.

    No distribution or update-source behaviour changes here.

- [#19](https://github.com/manyfold-open/manyfold/pull/19) [`582285d`](https://github.com/manyfold-open/manyfold/commit/582285dbbcf8e6168102b4abbba8b886323f2a6b) Thanks [@yingca1](https://github.com/yingca1)! - The API and web app now point at `https://manyfold.ai/cli/install.sh` and read
  CLI versions from the release manifests instead of the CDN.

    - The copy-paste install commands in the runtime dialogs, and the install script
      the API runs inside sprites, all use the one installer URL. The channel now
      rides `MF_CHANNEL=dev` rather than a separate staging URL.
    - `GET /daemon/cli-versions` lists stable releases from
      `manyfold-open/manyfold` and reports the dev channel as the single build its
      manifest names — a rolling channel has exactly one installable build by
      definition.
    - Versions below `0.24.0` are filtered out of the stable list: they have no
      per-version manifest, so a pinned upgrade to one could not be resolved by the
      current CLI or installer. Offering it would hand the operator an upgrade that
      fails at download time.
    - The daemon's latest-version probe reads the channel manifest and now also
      reports the target commit, which is what distinguishes two dev builds that
      share a version.

    **Operator-visible:** the API no longer reads `R2_S3_ENDPOINT`,
    `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` or `R2_PUBLIC_BUCKET` for the CLI
    version catalog — listing dev builds out of an object store is gone. Those
    variables are still used by other features; nothing needs to change to deploy
    this, and they can be retired from the CLI catalog's perspective.

- [#17](https://github.com/manyfold-open/manyfold/pull/17) [`a365fa8`](https://github.com/manyfold-open/manyfold/commit/a365fa8e2a3046e0826a13e22a824e7147508467) Thanks [@yingca1](https://github.com/yingca1)! - The installer is now manifest-driven and served from `https://manyfold.ai/cli/install.sh`.

    `install.sh` used to call the GitHub Releases API to find a release, scrape
    `browser_download_url` out of the JSON, and recover the CLI version from the
    asset filename. It now reads the same release manifest `mf update` reads, which:

    - removes the GitHub API dependency and its unauthenticated rate limit — the
      common failure mode was an installer that worked yesterday and 403s today;
    - drops the download from three requests to two, because the checksum travels
      inside the manifest instead of a detached `.sha256` that could be served from
      a different cache generation than the archive it describes;
    - stops depending on `releases/latest`, which is what makes it safe for the CLI
      to leave the edition release train;
    - supports `MF_CHANNEL=dev` for real (`staging` is accepted as the pre-rename
      alias), and `VERSION=` pins either a stable or a dev build.

    The script is also served by the web app at `/cli/install.sh`, so the advertised
    install command becomes:

    ```sh
    curl -fsSL https://manyfold.ai/cli/install.sh | sh -s -- setup
    ```

    It is a committed copy under `apps/web/public/cli/`, kept honest by a
    byte-equality test: neither the OSS nor the cloud web Dockerfile has `apps/cli`
    in scope, so a build-time copy or a symlink would break the image builds.
