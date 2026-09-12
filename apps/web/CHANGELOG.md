# @manyfold/web

## 1.1.1

### Patch Changes

- [#362](https://github.com/manyfold-open/manyfold/pull/362) [`a72fd5e`](https://github.com/manyfold-open/manyfold/commit/a72fd5e55423bfba77276928f047960c70ced0f2) Thanks [@yingca1](https://github.com/yingca1)! - Use `mf a2a send` to invoke a peer or URL and `mf a2a status` to list callable peers and in-flight tasks. The deprecated `call`, `stream`, and `peers` aliases have been removed. Replace `stream <url> <prompt>` with `send <url> <prompt> --stream`; replace scripts reading the `peers --json` array with `status --json` and read its `peers` field. Update saved scripts and Agent instructions before upgrading the CLI.

    The Web A2A exposure dialog now points to the supported status command in every language.

## 1.1.0

### Minor Changes

- [#354](https://github.com/manyfold-open/manyfold/pull/354) [`aef0bb7`](https://github.com/manyfold-open/manyfold/commit/aef0bb74954b2e95c40cf3e29f4c333fc8ddb4d8) Thanks [@yingca1](https://github.com/yingca1)! - Agent create (v1): the model provider section is built like the runtime section — an All / Cloud / Local chip row over one grid of pick cards (the saved providers and the runtime's accounts side by side, the chips only filtering) and one row of dashed add chips under it. Cloud lists the saved providers and adds new ones through the same built-in / custom forms as Settings → Model Providers, in a dialog that refreshes the list and picks the new row. Local lists the runtime's host sign-in and its added accounts as the runtime page's Account section shows them (same identity, plan and status tags, the same Sign in for a host or account that needs one, a Manage accounts link for the rest), signs a new subscription in from the page, and can now store an API key on the runtime: an `api-key` auth profile keeps the key in its own credential context on the host and injects it as the vendor variable for that profile's runs (needs an `mf` daemon advertising `auth-api-key.v1`; the API refuses the create on older ones). The runtime page's Account section and the create form's Local group now render one shared account list (`RuntimeAccountList`): the same rows, the same Sign in button and account menu, the same dashed "+ Add account" / "+ Add API key" chips and the same sign-in dialog; the create form only adds the pick. The accounts are laid out like the create form's runtime cards, two to a line: each account is headed by who it is signed in as (the host row is simply "Host sign-in" until it is), with plan and organization on one quiet line, its status tag, and Sign in on the row when it needs one; the host's usage sits two windows to a line, and the list ends with Add account. The explanatory copy that repeated what the rows already said is gone. Joining an existing runtime no longer offers a "Same credentials as the runtime" row: for a coding framework the runtime's credentials are the Local list (its host sign-in row is that binding), so a Cloud pick is always an explicit provider; the frameworks without a Local list (openclaw, hermes, external, narranexus) simply inherit, as before, and a subscription choice no longer sends an empty credentials PATCH.

    Sandbox runners come up earlier: a coding-framework agent create registers and starts the sprite's runner while the VM is still awake from the framework install (`starting_runner` step), picking a sandbox runtime in the create form prewarms its runner (debounced, same admission and metering as a click), and a runner woken for an account operation is held awake for a few minutes so the sign-in or key that follows does not wake it again.

    A sandbox delete whose sprites.dev call fails no longer pins the user's active-slot cap: revoked host rows are excluded from every concurrent-active count, and the sandbox reaper now retries the delete for a revoked row a few minutes later instead of leaving it as a permanent ghost. A wake refused by that cap is reported as its own state (`sandbox-limit`) on the runtime page and in the create form's Local list, with a check-again action, and is never cached as a failed probe.

    Account usage is read from the vendor at most once every ten minutes per runtime: the runtime page's opens and refreshes re-read the sign-in but reuse the kept usage, a refused re-read keeps the last good numbers (the card says when they were read), and the host card's menu has Refresh usage for an explicit re-read (`GET …/account?refreshUsage=1`; the daemon's `account.inspect` and the sandbox probe both accept a usage flag).

    The create form (v1) gathers every model setting under one Advanced config section after the provider: the framework's model mapping (folded) with its default model and effort for a platform provider on Claude Code or Codex, the primary model for openclaw / hermes, or the model override for an agent that simply inherits its runtime's credentials. The mapping now applies when joining an existing runtime too: the join sets the agent's model config right after its credentials. Both the Model provider and the Advanced config labels carry the same question-mark help as the framework and runtime labels, opening a short explanation of Cloud vs Local and of what the mapping does.

    Opening the create form for a runtime (`?runtimeId=`) no longer loses that selection to the first sandbox host when the hosts load before the runtimes.

    Each sandbox card in the create form (v1) shows every framework a sandbox can hold as icons — the three coding CLIs and OpenClaw, Hermes and NarraNexus — present ones in colour with a green edge, absent ones greyed behind a dashed edge — and each icon opens a menu with the installed version against the catalog, the agents already running that framework there (each a link to its chat), and the one action that closes the gap: Check (a sandbox never probed), Install, or Upgrade to the latest. A coding CLI on a bare sandbox installs through a new `POST /sandboxes/:id/frameworks/:framework/install` (the same staged npm install as the agent-level upgrade, re-probed and persisted afterwards); a sandbox that already runs the framework upgrades through its primary agent, as the runtime page does. The service frameworks are known through the runtime that runs them and install by a click too: the menu's Install brings the framework up on the sandbox as a runtime with no agent yet (installed and started, its model provider filled in by the first agent's pick), and the menu says when the sandbox's one public port is already taken by another of the three. Deep links into the form (`?sandboxId=`, `?runtimeId=`) no longer lose their target to the first host when the lists load in the other order.

    A bare sandbox that already has the coding CLI takes a subscription account before any agent exists: picking it in the create form (a click, a deep link or a sandbox just created — never the list's own default pick, which offers Add account instead and prepares on the click) brings the framework's runtime up on it right away (`POST /sandboxes/:id/frameworks/:framework/runtime` — an agent-less runtime row, the CLI left at the version found, only a missing one installed at the version agent create would pick; idempotent over a live runtime — the form's own prewarm starts the runner) and re-targets the form at that runtime, so Codex and Gemini CLI on a sandbox show the same Local group as Claude Code — host sign-in, added accounts, Add account / Add API key — instead of a "sign in after creating" row. A sandbox never probed is checked first (its CLI inventory read while it is awake), and one whose CLI turns out to be missing gets an Install chip in the same place — so a sandbox created from the form goes straight to its accounts, or straight to installing the framework, instead of the "sign in after creating" copy. A failed step shows why, with a retry. The agent then joins the runtime the way any later one would, promoted to its primary; the runtime page lists such a runtime with zero agents until then. A credentials change for an agent on a sprites runtime that has no stored credentials yet (one prepared this way) resolves from the request instead of demanding a rebuild.

    The Model provider section has the same shape for every framework now. OpenClaw and Hermes, which speak both vendors' protocols, list the saved providers of both families in one grid under All / Anthropic / OpenAI chips that only filter (the picked card's family is the vendor the primary-model default follows), with the same dashed "Add model provider" chip offering both families' catalog entries; the old Anthropic | OpenAI toggle over a separate list is gone. NarraNexus, which takes no provider from Manyfold, shows one card saying it manages its model provider in its own UI, and creating a NarraNexus agent no longer demands an unrelated saved provider.

    Every runtime card in the create form's Agent runtime section has a menu bottom-right. A sandbox card — bare, or the runtime on it — offers Rename runtime, Rename sandbox and Delete sandbox (once no agent runs there; its agent-less runtimes go with it): the sandbox is the machine the card stands for, so its runtimes are not deleted one by one from here. A cloud computer's card renames its runtime and deletes it once no agent is left; a daemon's runtimes are the daemon's own and only rename.

    While a picked sandbox is still on its way to being usable, the create button says so and stays disabled — Creating the sandbox… (the new-sandbox dialog closes on the click), Checking the sandbox…, Installing <framework>…, Preparing the sandbox…, Starting the sandbox runner… — so the form cannot be submitted around a step that is still running; the runner-starting line the account list used to show is that same progress and is gone from the list.

    The create form keeps waking the picked sandbox's runner until it answers (asking again after every cycle that ends without an answer) instead of handing the user a "start runner" line and button, so those never appear there; the plan's slot-cap notice keeps a Check again. The sandbox cards' status line says what the machine is doing — Active / Warm / Cold for the VM (the runtime list's words), Starting runner… and Runner online for the picked one — instead of a flat Ready.

    Waking a sandbox runner no longer stalls on a stale twin: when two registrations left two runner-host rows for one sprite, the wake picked one arbitrarily and could wait its full two minutes on the row the process was not using; the lookup now takes the row the runner last answered on.

    A sandbox woken for its accounts no longer sits in the plan's active slot for minutes after the user has moved on. The create form's prewarm holds it for a short window it renews while the runtime stays picked and releases when the pick moves or the page closes (`POST /agent-runtimes/:id/auth-profiles/release`); the runtime page releases the hold its Refresh or sign-in placed when it is left; and a wake the slot cap refuses first lets go of the account holds on the user's other sandboxes, so the next attempt is admitted once they suspend — on the Free plan's single slot, switching sandboxes in the form used to wait out a five-minute hold.

    A sandbox wake the plan refuses fails fast in the create form instead of spinning: the prewarm's admission now runs on the request and answers with the refusal (`RuntimeAuthPrewarmView.refused`), so used-up active hours end the wait at once — the card reads Can't wake, the Local group says the hours are used up with an Upgrade plan link where a plan is sold, and Create is not held — while a full concurrent slot keeps the wait going with the button saying it is waiting for another sandbox to fall asleep.

    Every lookup of a sandbox's runner by name now agrees on which row is the runner when a double registration left two: the one it last answered on. Before, the account list could read a sandbox as asleep off the twin nothing ever connected to while the wake reported the runner live — the create form then showed Starting the sandbox runner… indefinitely. The twin rows are dropped when found, once they are old enough not to be a registration still dialling in.

- [#350](https://github.com/manyfold-open/manyfold/pull/350) [`1daff03`](https://github.com/manyfold-open/manyfold/commit/1daff035b6205c78504d8f9d6ab651f1241a04aa) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - The /channels page now lists every channel the product supports. Microsoft
  Teams, Google Chat and iMessage were shipped channels missing from the
  marketing page, which listed ten of thirteen and named ten in its meta
  description, its crawler snapshot and its hero.

    Each tile is one row: the mark, the app's name, and "Setup guide" with its
    arrow at the end. It carried a third thing — how that channel is connected,
    "Paste a key" or "Install an app" — in a bordered chip that looked like a
    button, was not one, and outweighed the 15px corner arrow that was doing the
    actual linking. By the time somebody is reading this grid they are looking for
    the name of the app their team uses; which credential its API wants belongs in
    the guide, one click away, where the whole procedure already lives.

    The grid drops to three columns so the thirteen apps no longer leave a single
    stranded tile in a row of its own, and the Google Chat and iMessage marks were
    redrawn: both shipped as plain green bubbles and were about to sit two rows
    apart reading as the same app.

    The document title now matches the page's own heading — "Claude Code and Codex,
    now in your everyday apps · Manyfold" — in all eleven catalogues. It named
    three of the apps instead, which is a different promise from the one the
    headline makes, in the one place a reader meets the page before opening it: the
    tab, the search result and the share card all read from this string.

- [#350](https://github.com/manyfold-open/manyfold/pull/350) [`1daff03`](https://github.com/manyfold-open/manyfold/commit/1daff035b6205c78504d8f9d6ab651f1241a04aa) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Two marketing pages get names a stranger can read, and permanent redirects
  from the old ones.

    `/cloud` becomes `/hosted-agents`. A URL travels without the site around it —
    a search result, a pasted link — and to this audience a bare "Cloud" means the
    paid tier of an open-source product, a reading the footer's Self-hosting link
    sat a few centimetres away and confirmed. The page argues something else: a
    cloud machine of its own for your agent, signed in with the subscription you
    already pay for. The nav and footer label changes with it, because that is
    where the misreading actually bit — the address bar is the quieter half.

    `/channels` becomes `/agent-channels`. This one was not wrong, only
    unresolvable: channels of what, whose? The qualifier answers it. It stays
    `channels` rather than becoming `integrations`, which would promise skills,
    MCP and A2A as well, or `chat`, which would disown the two issue trackers. The
    nav label stays the bare word — a label is always read inside the site that
    owns it, so it does not need the qualifier the URL does.

    Both old paths 301 to the new ones in apps/web/Caddyfile, query strings
    intact, and the caddy contract test holds them there.

### Patch Changes

- [#335](https://github.com/manyfold-open/manyfold/pull/335) [`5b318db`](https://github.com/manyfold-open/manyfold/commit/5b318db5ae80cb1a30eeff1667c82a004ae02965) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Point the new chat view at the setup each framework actually needs — connect a channel, install skills, add MCP tools, check an external provider — with the recommended step leading the list.

- [#347](https://github.com/manyfold-open/manyfold/pull/347) [`fbfa7fe`](https://github.com/manyfold-open/manyfold/commit/fbfa7febf0f08ebaa8ae1683ddf344677de4d3c8) Thanks [@tldr0810](https://github.com/tldr0810)! - Label system and in-flight rows in a channel's Recent deliveries table

    A delivery whose direction is `system` — the row recorded when a provider sends an event the channel does not handle — had no label in any language, so the table printed the translation key itself. The long dotted string overflowed the narrow Direction column and overlapped the cell beside it. The four in-flight and dead-letter statuses (`pending`, `queued`, `processing`, `dead`) were unlabelled the same way. All eleven catalogs now carry them, and the Direction cell wraps so an unlabelled value can no longer overlap its neighbour.

## 1.0.0

### Major Changes

- [#349](https://github.com/manyfold-open/manyfold/pull/349) [`77d8543`](https://github.com/manyfold-open/manyfold/commit/77d85432dbbdb2ee0f6cb60efc624a4a0b686c97) Thanks [@yingca1](https://github.com/yingca1)! - Close retired runtime and configuration compatibility windows. Daemon registration,
  heartbeats and WebSocket connections require CLI 0.34.0 or newer. Coding daemon
  prompts use stdin transport; turn RPCs use split budgets; update channels use stable/dev.
  Missing credential facts no longer establish readiness, and daemon MCP writes
  always use restrictive file permissions.

    Lark message ingress accepts only the current receive_v1 event contract. Retired
    API environment aliases fail startup, Web/Admin stop reading old build aliases,
    and startup no longer adopts A2A timeout or self-host plan settings. Upgrade older
    self-hosted installations through API 4.0.0 and migrate configuration first.

    Normal runtime provisioning, upgrades, skill activation and keep-alive operations
    no longer perform the completed identity, shared-shell, home-clone or fused-task
    migrations. Existing persisted workspace and lease state paths remain valid.
    Every service wake gets an independent report generation; changing a keep-alive
    lease preserves the current service's report fence and files.

## 0.69.1

### Patch Changes

- [#323](https://github.com/manyfold-open/manyfold/pull/323) [`3eede59`](https://github.com/manyfold-open/manyfold/commit/3eede59bbfb385092e23bede3639732864a90e1e) Thanks [@yingca1](https://github.com/yingca1)! - Chat errors now include a server-classified cause used by the web workbench and
  terminal telemetry. Live events, replayed streams and historical messages use
  the same classification rules. The web no longer guesses authentication,
  billing or thread contention from error wording. Retryability remains the
  adapter's explicit decision.

## 0.69.0

### Minor Changes

- [#312](https://github.com/manyfold-open/manyfold/pull/312) [`540b929`](https://github.com/manyfold-open/manyfold/commit/540b929109ce074d666aa11e7e482477ce1fb9b3) Thanks [@yingca1](https://github.com/yingca1)! - Remove the retired k8s dashboard's `dashboardUrl` field from runtime summaries
  and the exported `AgentRuntimeSummary` type. The field always returned null;
  sprite dashboards continue to use the existing control-ui URL endpoint.

    All web sign-in methods now accept only internal redirect paths. Remove
    `VITE_DASHBOARD_ORIGIN_SUFFIXES` and `MF_SELFHOST_DASHBOARD_SUFFIXES` from build
    configuration; the retired dashboard redirect flow no longer uses them.

### Patch Changes

- [#313](https://github.com/manyfold-open/manyfold/pull/313) [`b4d77bc`](https://github.com/manyfold-open/manyfold/commit/b4d77bc81448da61fbbd554d3f52e849c795ba3d) Thanks [@yingca1](https://github.com/yingca1)! - Row action menus (the "…" button) now open above any card that clips its contents, so the menu on an added account of a runtime is visible again instead of being cut off at the card edge.

- [#314](https://github.com/manyfold-open/manyfold/pull/314) [`6afa649`](https://github.com/manyfold-open/manyfold/commit/6afa6490cc45ec2a17b1da73f7bee8e7896cc173) Thanks [@yingca1](https://github.com/yingca1)! - Managing added accounts on a sandbox runtime now wakes the sandbox and its runner instead of timing out against a frozen one. Adding, signing in, signing out and removing an account resume a sleeping sandbox on the user's behalf; a runtime whose sandbox has never run a turn, or whose runner is not answering, shows a "Start runner" action on the runtime page instead of a dead-end notice.

## 0.68.0

### Minor Changes

- [#288](https://github.com/manyfold-open/manyfold/pull/288) [`6b4d090`](https://github.com/manyfold-open/manyfold/commit/6b4d090f692764c94d2367b014e153b2c63d2dcd) Thanks [@yingca1](https://github.com/yingca1)! - Retire the Phase 8 user-grant compatibility layer. The API no longer exposes the legacy CLI poll route or bearer-grant endpoint, runtime authorization no longer uses `enforce_agent_binding`, and the web CLI approval screen keeps only browser login. External A2A grants remain supported.

- [#289](https://github.com/manyfold-open/manyfold/pull/289) [`0929915`](https://github.com/manyfold-open/manyfold/commit/0929915546b0f5cd7ebba6dc72b1bea82c81e4d1) Thanks [@yingca1](https://github.com/yingca1)! - A version and its update are now one pill. Wherever a surface shows an installed version — an agent's framework and mf CLI, a runtime, a machine, a sandbox, a skill — that pill is also the update reminder: it stays neutral while the version is current, and when something newer is out it takes the tone (blue, or red when the upgrade is required) and grows an arrow that opens the Update Center. The separate badge that printed the available version beside the installed one is gone, along with the agent overview's "↑ latest v… available" caption; the version being offered now shows on hover, and the full comparison stays in the Update Center.

## 0.67.0

### Minor Changes

- [#281](https://github.com/manyfold-open/manyfold/pull/281) [`89937bc`](https://github.com/manyfold-open/manyfold/commit/89937bc768486f432134974b5c683f6c144cfb0b) Thanks [@yingca1](https://github.com/yingca1)! - Runtimes can now hold more than one signed-in account, and each agent picks which one it runs under. The runtime page's Account section lists the host sign-in beside the accounts added on that runtime, with Add account, Sign in, Sign out, Remove and a default for new agents; sign-in for an added account opens a terminal already inside the CLI's login, scoped to that account. The create wizard offers the account chooser when an agent joins an existing runtime on its own subscription, and the agent's Model provider tab lets you move an existing agent between accounts (applies from its next run). The chat sign-in card names the account the agent is bound to.

## 0.66.0

### Minor Changes

- [#272](https://github.com/manyfold-open/manyfold/pull/272) [`909c84a`](https://github.com/manyfold-open/manyfold/commit/909c84a197b194dd7be5c1d980b5f139f837b985) Thanks [@yingca1](https://github.com/yingca1)! - The Update Center now lets you choose which version to install, and it fits more on screen.

    The single Version column is split into From and To, and where more than one release is a valid upgrade, To is a picker instead of a fixed value. A machine's mf CLI is offered the versions on the channel it was installed from — plus the other channel only when the machine reports it can cross over — a sandbox is offered both, and an agent framework is offered every catalog release newer than what it has. Skills stay read-only, because both sides of a skill update are git revisions with no catalog between them.

    The Status column is one short tag per row again. Long explanations — why a release is withheld, which phase an upgrade is in, what an API refused — moved to a full-width line under the row, so a sentence can no longer stretch the row or squeeze the other columns. Rows are shorter, and the table has the wider page to spread across.

    Everywhere else, "a newer version exists" now looks the same: the installed version, and next to it a badge carrying the release you would move to, which takes you to the Update Center. That replaces the sidebar banner, four notice strips, several inline captions and a red card. The sidebar's update count only turns red when something in the list is overdue rather than merely available. Machines the platform cannot upgrade remotely keep their recovery instructions, since for those the commands are the upgrade path.

## 0.65.1

### Patch Changes

- [#268](https://github.com/manyfold-open/manyfold/pull/268) [`3a2ec8a`](https://github.com/manyfold-open/manyfold/commit/3a2ec8afa20124a0f5ca4cc7f32731c211d035a7) Thanks [@yingca1](https://github.com/yingca1)! - The runtime page's sign-in terminal now shows what you type. `claude auth
login` does read the code pasted at its `Paste code here if prompted >`
  prompt, but it echoes none of it, so the terminal looked dead and there was
  no way to tell whether anything had been entered. The sign-in command now
  leaves the terminal to `cat` and pipes it into the CLI, which is enough to
  get the echo back — the same code, typed or pasted, still reaches the CLI.

## 0.65.0

### Minor Changes

- [#256](https://github.com/manyfold-open/manyfold/pull/256) [`b665068`](https://github.com/manyfold-open/manyfold/commit/b665068914d0d5926d8bd3ec1265cc22f7f4e5f5) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - A new marketing page at `/channels` (and `/zh/channels`) explains connecting Claude Code or Codex to the apps a team already works in — chat on one side, issue trackers on the other. It answers four questions in four screens: what this is, which apps are supported, how long connecting one takes, and what happens to the conversations afterwards.

    The hero draws the claim instead of describing it. Under a centred headline, the two runtimes stand on a planet at the bottom edge as the world's own agent figure — the same bot, now shared out of `ScrollyWorld` rather than copied, and running a standing idle instead of the desk one: two small hops with a crouch, a stretch and a squash, and a cast shadow that shrinks at the apex. `WorldAgent` takes a `motion` prop for it, and its shadow moved outside the animated group, where a shadow belongs. The channels orbit above the bots as bodies on four rings, each ring turning slower the farther out it sits. The rings are drawn the way the home page draws the light between its planes: a translucent bloom under a thin core, both in `--lp-w-wire`. A ring is a circle, so a body turns on a CSS rotation about the planet's centre and unwinds the same turn about its own middle to keep its mark upright, rather than following a path with `<animateMotion>`: Blink holds an inline SVG's SMIL clock at zero until the document's load event, which left the sky painted and the bots hopping while every body stood still, waiting for the slowest thing on the page to arrive. A body travels past the bottom edge before its turn restarts, so it crosses the figure's fade and goes fully transparent before the loop's seam rather than blinking out mid-air. Under `prefers-reduced-motion` the turn is paused rather than dropped, so the bodies hold the resting positions their offsets give them.

    Above 900 the hero is exactly the first screen and the figure is sized to that screen rather than to the window: capped at the page's own 1200 measure, so a wide monitor no longer stretches the rings edge to edge and flattens the composition, and hanging a little past the fold, so the drawing reaches the bottom of the screen at full strength and dissolves in the space above the next section instead of washing out inside the first one. The figure's other edges give up as little as they can: a straight fade across the top was cutting the outer rings' arms flat, which is the part of the drawing that gives it its reach, so the top instead carries a clearance hung under the headline and the buttons. It dissolves the cropped crowns where they sit behind the copy and leaves the arms drawn out to the corners.

    The app catalogue groups the destinations by where the conversation happens — a team or community space, your own messenger, an issue tracker — because a visitor knows the name of the app their team uses and not which credential its API wants. Three peer headings replace an unlabelled grid with a sentence bolted underneath it, and the grouping is what lets the section stop claiming that every app on it is one a team is already in: WeChat's bots are direct-message only and cannot join a group at all. Each tile still says what its setup asks for — scan a code, paste a key, or install an app — but as one chip rather than an ink ladder that reserved the page's accent for the QR flows and so ranked the apps by the credential their API happens to want. Every tile is itself the link to that provider's guide, resolved to the language its own URL pins (`channelDocsHref` gained an optional language for it), and the closing screen states that every conversation, file, cost record and setting lands in the same agent whichever app it arrived from — drawn as the product's own shell in miniature, brand on a rail down the left, so the panel reads as a screen inside Manyfold rather than as a card about it. Each entrance feeds it along a wire of the same material as the hero's orbits, the four converging on one lit point at the panel's edge — the shape the home page's world uses for the light running between its planes. Copy avoids naming a count, because the list keeps growing. The hero's lead names four of the apps and the thing a visitor weighing this asks next — that the agent runs on their own subscription — and it holds one line: centred and broken in two under a headline already two lines deep, it reads as a paragraph rather than as a caption to the headline, so the hero's measure clears the string in the display font and in the fallback stack both. Nothing runs under the buttons any more. The objection anyone brings to putting an agent in a team's chat is answered where it is raised instead: the third step, the one that says to drop it into a group, carries it as an aside — on most apps the platform delivers only the messages that mention it, and the rest of the group never reaches Manyfold at all. It costs the page no screen of its own.

    One pair of calls to action, in the hero, resolving the same three states the landing hero does — open the workspace when signed in, one button to `/login` when the signup gate is off, request-access alongside sign-in when it is on — so a visitor arriving from an ad meets the flow the rest of the site offers. Its second button reads the docs, in the language the page's own URL pins. A closing screen used to repeat that pair under a second headline and a row of reassurances; the page now ends on the thing it was arguing for, and the crawler snapshot keeps a closing call of its own, built from the copy the manifest was already carrying (the home page's snapshot still renders none — see the separate changeset for that). The page joins the SEO manifest, so it is indexed, listed in the sitemap, pinned to the language its URL carries, and rendered without waiting for the auth round trip. Copy ships in all eleven catalogs.

    The three-steps block moves out of the page into `components/landing/LandingSteps.tsx`, so every marketing page takes one instead of writing its own. It is flat now rather than a bordered card divided by full-height rules with a chevron on each divider: only a flat row absorbs the uneven columns these lists actually have, since a step carrying a command and an aside runs a good deal taller than its neighbours, and it is a block you read once rather than one you scan. The ordinal stays the display numeral — set as a mono caption it measures under 2:1 against the canvas, and it is the only thing in the block saying the steps are ordered. `.lp-step-num` is the name `DESIGN.landing.md` §2.4 had already reserved for it. The three steps themselves come off the shared content table the crawler snapshot reads, so the aside on the third one cannot go missing from one of the two.

    Nothing on the page keeps a type scale of its own. It had been carrying three private overrides — a smaller `.lp-h1`, a smaller `.lp-h2`, and a smaller `.lp-h1` again for Chinese — each argued for locally, which is how a shared ramp stops being shared. Its section titles take `.lp-h2` and its hero headline takes the size the home page's hero headline takes, sharing one declaration with it rather than a second copy of the number: `.lp-h1`'s own ramp sits a step above that and is rendered by nothing but the crawler snapshot, so pointing a real hero at it made the sub-page half again the size of the page it belongs to. Chinese steps down with the same rule the home hero uses. The headline's measure is capped in `ch`, a line-length decision that holds at whatever size the ramp gives. The step numeral joins the display rule the home page's own big numeral is listed in rather than restating family, axes, tracking and leading beside it. Weights come back inside the sans register, which runs 400 and 500: three headings had drifted to 600. Sizes and leading that had landed a half-step off the home page's ladder move onto it, and the closing four claims take the values of the identical row on the home page rather than near-misses of them. The hero copy keeps the rhythm a section head keeps — 22px under the eyebrow and again above the lead — and its buttons sit where the home page's button rows sit.

- [#256](https://github.com/manyfold-open/manyfold/pull/256) [`b665068`](https://github.com/manyfold-open/manyfold/commit/b665068914d0d5926d8bd3ec1265cc22f7f4e5f5) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - The marketing header and footer are rebuilt around the pages the site now has. The centre group reads product, then price, then documentation — what a visitor can get, what it costs, how to work it. Docs held the leftmost slot for historical reasons, which put the surface written for people who have already committed ahead of the pages arguing that they should; Challenge trails the group because it is a campaign, not a permanent line of the product. Standing on one of those pages is said with an active style and `aria-current`, in the bar and in the folded menu both: `.lp-nav-link-active` had been in the stylesheet with nothing rendering it, which was fine while every entry led off the page and stops being fine the moment one of them is a page of our own. Only a page of our own gets the state — Docs leaves for the docs site, and Pricing is a section of the landing page, so marking it current on the home page would claim the visitor is standing on a section they may not have scrolled to.

    Pricing's default destination follows the language the URL pins rather than a hard-coded `/`. It had been a constant, so the entry sent a visitor reading a `/zh/` page to the English landing page; the landing page still passes a bare hash of its own, because there the click should scroll rather than route.

    The folded menu is a two-view panel rather than one list. Measured on local dev at 390x844 [2026-09-08]: with the eleven locales listed flat it stands 873px tall, which under the 54px bar overflows a phone of exactly that size by 89px, before considering a shorter one. Drilled down it is 422px, and one row — the language, with the current one named beside it — replaces the two the locales used to take. The list scrolls inside the panel rather than growing it past the fold, closing the menu returns it to the root view, and its rows drop the per-row globe, because a panel that is entirely languages does not need to say so eleven times. Language and theme sit in one group with no rule between them: both answer how the page should be shown to me. The menu also has the room the bar does not for saying what "Channels" means to somebody who has not used the product, so that row carries a second line naming four of the apps.

    `.lp-nav-menu-item svg` loses its `margin-left: auto`. It was written for a trailing chevron, but an overflow row is icon-then-label: the icon is the first flex child, so it absorbed the free space and dragged the pair to the right edge, against the same rule's own `text-align: left`. The meta span carries its own auto margin and the leading-icon rule already zeroed this one, so two rules were arguing about a declaration neither needed.

    The footer is three columns and a legal line rather than one row of eight. A row ranks nothing: it had Cloud and "Cookie settings" at the same weight, which is a worse answer than leaving a page out of the footer altogether. Product, Resources and Legal each get a heading; the campaign sits with the resources because it is an event, not a line of the product; the brand, its wordmark and the three social marks hold the first column with no hairline under them, since the white space already separates the cluster and a rule would read as a divider from whatever sits below. Product gains a self-hosting entry — naming Cloud in a nav asserts that something is not cloud, so the site has to say what that is or the word carries nothing, and it is the open-source core's only entrance here that is a word rather than a glyph.

    Both marketing pages also get a way in from the landing tour itself. The scene about runtimes and the scene about surfaces each end in a link to the page that argues them in full, at the accent rather than as a button: the tour already carries one button pair on its hero card, and a filled control per scene would read as four competing primary actions down the page. The header and the footer catch a visitor who already knows those pages exist; this is where somebody reading the tour first meets them.

- [#256](https://github.com/manyfold-open/manyfold/pull/256) [`b665068`](https://github.com/manyfold-open/manyfold/commit/b665068914d0d5926d8bd3ec1265cc22f7f4e5f5) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Every page in the SEO manifest now renders its own crawler document. The build-time renderer had one body for all of them — the home page's snapshot — so `/channels` and `/zh/channels` shipped the landing page's sections (runtimes, one workspace, works-with, observability, pricing, FAQ) under the channels headline: two URLs, one body, near-duplicate content, and not a word about channels in the document a crawler actually reads. The title, description, canonical URL and hreflang pair were all correct, which is what made it survive review; nothing rendered the manifest's `ctaTitle`, `docsLinksLabel` or `docsLinks` at all.

    `/channels` gets the four screens it argues: the app catalogue grouped the way the page groups it, the three steps with the aside on the third, the closing claims about one agent in one place, and a closing call built from the copy the manifest was already carrying. Its tile groups, setup labels, display names, step keys and closing claims move into `seo/channelsContent.ts`, beside `landingContent.ts` and for the same reason — the snapshot and the interactive page have to name the same apps in the same groups, and a second copy of the list is how they stop doing that.

    The crawler footer lists the manifest's own pages rather than one hard-coded entry, so an indexable page gains an inbound link from every indexed document — the sitemap is not the only way a page gets found, and a crawler that does not run JS never sees the real footer. It stays the short list otherwise: that footer exists to give a crawler something, not to mirror the real one.

    A manifest page with no snapshot is now a build error rather than a page quietly serving somebody else's body, and a test asserts that only the home page's document carries the landing sections.

    The manifest itself gains an editions slot. `seo/editionPages.ts` is empty in an open-source build and shadowed by a composition that has marketing pages of its own; `SEO_PAGES` spreads it, so the language pin, the tab title, the canonical URL, the sitemap, robots and the nav's current-page state all learn about such a page from one place. A slot page whose copy is composition-owned sets `ownCopy` and holds finished text rather than catalogue keys, so a commercial argument stays out of the open-source catalogue instead of being machine-translated into nine locales for a page that does not exist there.

    The post-build renderer reaches a composition's pages through `MF_WEB_OVERLAY_DIR` directly, because the overlay resolver is a vite plugin and this step runs after the bundle under tsx. That imposes two rules on a slot module, both documented where they bite: import core modules through `@/` but never overlay-local ones, and describe the crawler body as data rather than shipping a component — a `.tsx` outside this app is transformed with the classic JSX runtime whatever its own tsconfig or `@jsxImportSource` pragma says, and throws `React is not defined` on its first element.

## 0.64.1

### Patch Changes

- [#248](https://github.com/manyfold-open/manyfold/pull/248) [`6961e53`](https://github.com/manyfold-open/manyfold/commit/6961e53d34fc14b3760b43c5ac228daa972e8a16) Thanks [@yingca1](https://github.com/yingca1)! - Show the iMessage webhook help text on the channel settings page. The iMessage provider's `webhookHelp` copy shipped in the catalogs but the settings view never referenced it, so it fell back to the generic help; iMessage now renders its own BlueBubbles-specific guidance.

## 0.64.0

### Minor Changes

- [#242](https://github.com/manyfold-open/manyfold/pull/242) [`e9f99df`](https://github.com/manyfold-open/manyfold/commit/e9f99df9c8a424c1cffc89474e596dc66898c87d) Thanks [@yingca1](https://github.com/yingca1)! - Add an iMessage channel provider

    Bind an agent to iMessage and reach it from the Messages app, in one-on-one
    conversations and in group chats. Apple publishes no iMessage API, so the
    channel talks to a BlueBubbles server you run on your own Mac: paste its URL
    and server password, and Register pings it, reads its version and installs the
    inbound webhook itself, so nothing has to be copied back by hand.

    iMessage has no bot identity to @-mention, so group messages are gated on
    literal wake words instead, stripped from the message before the agent sees it.
    Wake words are escaped as literals rather than compiled as user-supplied
    patterns, because parsing runs on the unauthenticated webhook path where a
    hostile regex would be a denial of service against every channel on the
    instance. Allowlists normalize handles, so `+1 (555) 555-0123` and
    `+15555550123` are one person.

    BlueBubbles can neither set custom headers nor sign its payloads, so inbound is
    authenticated with a per-channel secret embedded in the registered webhook URL
    and compared in constant time. That is weaker than every other channel here:
    the URL is a bearer capability, visible in the BlueBubbles webhook list and in
    tunnel logs, and the allowlist is not a second factor. The channel docs say so
    plainly. Outbound calls are re-checked against the private-address guard on
    every request, not only when the URL is saved, because a write-time-only check
    loses to DNS rebinding.

    Replies are flattened to plain text and split one bubble per paragraph, since
    Messages renders no markdown and cannot edit a sent message — so there is no
    streaming preview. Attachments work in both directions. Reactions, typing
    indicators, read receipts and reply threading are detected and reported but not
    implemented: they all require the BlueBubbles Private API helper, which needs
    SIP disabled on the operator's Mac.

### Patch Changes

- [#243](https://github.com/manyfold-open/manyfold/pull/243) [`95a31eb`](https://github.com/manyfold-open/manyfold/commit/95a31eb1f773a54b71303bcdc1e796e3a8e6877a) Thanks [@yingca1](https://github.com/yingca1)! - Stop a codex thread's single-writer rule from costing a conversation. Codex admits one writer per thread and refuses the second with `thread/resume failed: … already has an active writer (code -32600)`, in the same `thread/resume failed` wrapper it puts on a missing rollout — so the resume-load self-heal matched it and cleared `framework_session_ref`, forking the session onto a fresh thread and silently dropping the conversation the user was still reading, while the holder went on appending to the thread nothing pointed at any more. The self-heal is now keyed on positive evidence of a lost rollout rather than on that wrapper, so no other reason codex wraps the same way can trigger it either; the busy refusal keeps the ref, fails retryably, is classified as its own `resume_contention` failure cause instead of a stale ref, and — when it is the session's own TUI holding the thread — is explained in the chat as such instead of shown as a JSON-RPC line.

    The terminal's "resume this session in the TUI" no longer walks into the same collision. The API refuses it while `chat_sessions.inflight_message_id` is held — which stays held through a SUSPENDED turn, the exact state where the API has stopped watching and the CLI has not stopped writing — opens a plain shell, and reports the verdict on the terminal's `session_info` frame. The web records that verdict on the tab (its own stream view both lags and leads it), explains the plain shell from it, and rebuilds the tab into the TUI on the first switch back after the turn ends — including after a mid-turn reload, where the tip message id never moves.

    Turn adoption now holds the sandbox awake while it recovers a sprites turn from the runtime transcript: that recovery polls the sandbox for the turn's remaining life, none of which is platform-visible activity, so it was racing a suspend that could freeze the very files it was reading. Every path that holds a turn's awake lease now settles it by one rule — released only at a real terminal, left on its TTL when the turn suspended or moved to another owner — and releasing waits for the lease's own in-flight create, so a hold settled on its first poll can no longer leak a full-TTL lease.

- [#240](https://github.com/manyfold-open/manyfold/pull/240) [`8b45def`](https://github.com/manyfold-open/manyfold/commit/8b45defb678f660c0cd5dca9a30555e9701e77d0) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Stop the landing world's mesh dots under `prefers-reduced-motion: reduce`, and
  start them on the first frame rather than on the load event.

    Three dots hand a light along the leads of the control plane's mesh. They were
    SMIL — an `animate` on `opacity` and one each on `cx` and `cy` — and they
    carried no class, so the reduced-motion block, which stills every CSS animation
    in the world and then removes the flux by class name, had nothing to catch
    them: they went on animating. `DESIGN.landing.md` §6.3 lists three things
    allowed to move on the landing page and says reduced motion freezes or removes
    the rest, and these were the last unhandled mover in the drawing.

    They were also why a reduced-motion screenshot of `svg.lp-world` was not
    reproducible. Measured on Chrome 148 [2026-09-08]: six frames of the world
    taken 420ms apart differed from one another by 216–313 subpixels, every one of
    them inside the mesh's own 45×22px box. The same six frames now differ by none,
    which is what makes the world pixel-comparable in that mode at all.

    The travel is now a CSS `transform: translate()` off the node a dot is drawn
    on and the fade a CSS `opacity` animation, which also fixes the cold-refresh
    defect [#239](https://github.com/manyfold-open/manyfold/pull/239) describes for
    the flux packets: an inline SVG's SMIL clock does not start until the
    document's load event, so a cold refresh of `/` drew the mesh and left nothing
    crossing it. Seen on Chrome 148, Firefox 150 and WebKit 26.4 [2026-09-08], with
    one 3s subresource holding the load event open: the world was in the DOM inside
    500ms and `svg.getCurrentTime()` still read 0 a second later, while the CSS
    clock had already run 1.25s and the dot was half way along its lead.

    Nothing about the choreography changes. A dot is drawn on its lead's first node
    and carries that lead's own delta, so the two keyframes are shared and a dot
    differs from its neighbours only by the `animation-delay` that was its SMIL
    `begin`. Sampled every 25ms across two full periods — 519 phases over the three
    dots, each against the SMIL it replaces, the SMIL clock seeked with
    `pauseAnimations()` and `setCurrentTime` and the CSS one with
    `animation.currentTime` on the same absolute time — a dot lands within 0.0007
    user units of its old position in Chrome, 0.025 in Firefox and 0.00006 in
    WebKit, and the opacity curves match exactly bar Chrome's computed-style
    rounding. Rasterised rather than merely laid out: the ink centroid of the first
    dot, sampled at ten phases across its run, lands within 0.15 CSS px of where
    the SMIL dot drew, and both track the analytic point to within a quarter pixel.

    Reduced motion removes the dots rather than stilling them, alongside the flux
    classes. Stopping them is now possible — `animation: none` leaves an
    `opacity='0'` circle parked on a node the mesh already draws, and measured on
    Chrome 148 the frame is the same to the subpixel either way — so the rule
    removes them in order to say which parts move rather than leave that to a
    presentation attribute. That is a weaker reason than the one the same rule
    gives for a packet, whose invisible remains do shift the antialiasing along the
    wires; the comment there now says so, so that neither argument is carried over
    to the other part without being measured again.

    One thing the reduced-motion frame buys that a moving one cannot: while
    animations run, Chrome's rasterisation of the drawing depends on which elements
    carry them. Measured on Chrome 148 [2026-09-08], baking the three dots'
    computed transform and opacity into inline style and cancelling their
    animations — the identical picture — already moves 4,439 subpixels of
    antialiasing elsewhere in the world. A pixel test of this illustration
    therefore belongs in reduced motion, where it is now exact.

- [#239](https://github.com/manyfold-open/manyfold/pull/239) [`d783f51`](https://github.com/manyfold-open/manyfold/commit/d783f51584b032cc64eea67702d217623df7a456) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Start the landing world's light on the first frame instead of on the load event.

    The packets that travel the wires were SMIL — `animateMotion` plus `animate`
    and `animateTransform` — and Blink does not start an inline SVG's SMIL time
    container until the document's `load` event fires. On a cold refresh of `/`
    the world was drawn, the wires were lit and nothing moved along them until the
    last subresource had arrived, which is exactly the moment the illustration is
    supposed to be explaining itself.

    Measured on Chrome 148 [2026-09-08], with one artificial 3s subresource
    holding the load event open: the drawing was in the DOM at 241ms and
    `svg.getCurrentTime()` still read 0 at 3211ms. No API starts that clock early
    — `setCurrentTime(0)`, `setCurrentTime(0.001)`, `unpauseAnimations()` and a
    `pauseAnimations()`/`unpauseAnimations()` pair all leave it at zero.

    A packet now travels on a CSS motion path (`offset-path` + `offset-distance`,
    `offset-rotate: auto` for the tail), and its fade and pop are CSS animations
    too, all of which run from the first frame the element is styled. The same
    holds after the swap: the world moves 59px of packet travel before the load
    event in Chrome 148, Firefox 150 and WebKit 26.4, while `getCurrentTime()` is
    still reading 0.

    Nothing about the choreography changes. SMIL's `values` and `keyTimes` carry
    over as a per-packet `linear()` easing over keyframes that run a plain 0 → 1,
    so each stop in the CSS is the value the SMIL attribute named, and the wire
    paths, clocks and offsets are the same constants as before. Sampled at 104
    phases across all 11 packets against the SMIL positions they replace: beads
    land within 0.0002 user units in Chrome, 0.61 in Firefox and WebKit (a
    difference in how each engine measures arc length — under half a CSS pixel at
    the size the world is drawn), tails point within 0.25°, and the scale and
    opacity curves match to five decimal places.

    `prefers-reduced-motion: reduce` keeps removing the moving parts rather than
    stilling them, and the frame it leaves behind is unchanged. The reasoning
    behind that rule is not: a packet is now stoppable, so it is removed because a
    stopped one is still drawn — parked at the head of its wire — and, measured on
    Chrome 148, an invisible packet left in the paint tree shifts the antialiasing
    along the wires even when it is moved off the canvas. A ring is still SMIL,
    which CSS cannot stop at all.

## 0.63.1

### Patch Changes

- [#223](https://github.com/manyfold-open/manyfold/pull/223) [`62a984b`](https://github.com/manyfold-open/manyfold/commit/62a984b0c687da55363d2e4d19b7ebb799458cbc) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Fix the editions overlay resolver serving a wrap-and-extend overlay to itself instead of its base module. The plugin already declined to map a base file back onto the overlay importing it, but it recognised that case by the importer alone — and the dev server then fetches the base by its own URL (`/src/routes.ts`), a request whose importer is the HTML entry. The mapping ran a second time, answered the base URL with the overlay, and the overlay's own `import { encodePathSegment } from '<base>/routes'` pointed at itself: `SyntaxError: The requested module '/src/routes.ts' does not provide an export named 'encodePathSegment'`, and a blank admin console. Base resolutions now carry an `?mf-overlay-base` id the mapping leaves alone, so the overlay and its base stay two distinct modules. Seen on a cloud dev server whose `MF_ADMIN_OVERLAY_DIR` overlays the core admin route table; production builds resolve by path and were never affected.

## 0.63.0

### Minor Changes

- [#215](https://github.com/manyfold-open/manyfold/pull/215) [`1829eb8`](https://github.com/manyfold-open/manyfold/commit/1829eb8914b60fe94bc5f738a23d6711a0031596) Thanks [@yingca1](https://github.com/yingca1)! - Add a Microsoft Teams channel provider

    Bind an agent to a Microsoft Teams bot and reach it from personal chats, group
    chats and team channels. Bring your own Azure Bot: paste its app ID, client
    secret and tenant ID, run Register to activate the channel, then download a
    ready-made Teams app manifest from the channel page and upload it to Teams.

    Inbound activities are authenticated by validating the Bot Framework JWT
    against Microsoft's key set, checking the audience, the issuer, the signed
    service URL and the tenant on the channel. Allowlists are keyed on Entra
    (Azure AD) object IDs, never on user names or email addresses, because those
    can be reassigned.

    Replies stream by editing one message, land in the originating channel thread,
    and support typing indicators and agent-initiated sends. Personal-chat
    attachments are read; files posted in a channel or group chat are not, because
    Teams strips the reference and recovering it needs Microsoft Graph admin
    consent.

## 0.62.0

### Minor Changes

- [#207](https://github.com/manyfold-open/manyfold/pull/207) [`575b309`](https://github.com/manyfold-open/manyfold/commit/575b3094d06e2f1f585324668f89ad8ef9d13c1a) Thanks [@yingca1](https://github.com/yingca1)! - Add per-message model switching for openclaw agents in the chat composer, matching hermes. The model list comes from the agent's provider-models cache (openclaw joins the model-config provider-detail allowlist), and the pick is applied to the openclaw ACP turn via an in-box `openclaw gateway call sessions.patch {model}` in the exec wrapper — probe-verified to change a live session's model from the next prompt, stick to the gateway session key, and route through to the provider even for models not pre-registered in the gateway config (so no catalog registration is needed). Behind `MF_OPENCLAW_ACP`; narranexus is unaffected.

- [#207](https://github.com/manyfold-open/manyfold/pull/207) [`575b309`](https://github.com/manyfold-open/manyfold/commit/575b3094d06e2f1f585324668f89ad8ef9d13c1a) Thanks [@yingca1](https://github.com/yingca1)! - Show the permission-mode selector for openclaw agents in the chat composer, with the two openclaw modes (`Ask for approval` / `Don't ask`, default `Don't ask`), and wire the interactive approval card so an openclaw agent's `session/request_permission` can be answered from the chat. Mirrors the hermes controls: the mode persists per agent in local storage and rides each message; `Ask for approval` turns exec approval on for the ACP turn. Strings added across all 11 locale catalogs. Behind `MF_OPENCLAW_ACP`.

### Patch Changes

- [#207](https://github.com/manyfold-open/manyfold/pull/207) [`575b309`](https://github.com/manyfold-open/manyfold/commit/575b3094d06e2f1f585324668f89ad8ef9d13c1a) Thanks [@yingca1](https://github.com/yingca1)! - Collapse the chat composer's four per-framework permission-mode option arrays and the parallel `canChoose`/options/active/dispatch ternary chains — plus AgentChat's four permission-mode states, storage helpers and handlers — into one framework-keyed table (`lib/permissionModes.ts`), pinned by `test/permissionModes.test.ts`. Adding a framework's selector is now one table entry instead of a fifth branch in each chain, and there is no silent wrong-dispatch arm to forget. Also routes the after-grant continue send through the same table, so a hermes/openclaw agent's chosen permission mode rides that resend as it already does the first send (previously only claude-code/codex did).

## 0.61.0

### Minor Changes

- [#200](https://github.com/manyfold-open/manyfold/pull/200) [`39d4d34`](https://github.com/manyfold-open/manyfold/commit/39d4d349cc41c7c48faa2b9619990cbb15d7e124) Thanks [@yingca1](https://github.com/yingca1)! - The chat sidebar now shows new chats as they appear, without a reload. Until
  now the session list under each agent was fetched once per page load, so a chat
  started anywhere other than the current browser tab stayed invisible — a Slack,
  Discord, Telegram, Lark or GitHub thread reaching your agent, a scheduled
  automation, or a call to the A2A or OpenAI-compatible API. Those chats now
  arrive in the sidebar within about a second, and pick up their title as soon as
  it is derived from the first message.

## 0.60.0

### Minor Changes

- [#199](https://github.com/manyfold-open/manyfold/pull/199) [`2a51fa7`](https://github.com/manyfold-open/manyfold/commit/2a51fa740de47ca8284503772dc62f7d7a69d1b4) Thanks [@yingca1](https://github.com/yingca1)! - Add a Google Chat channel provider. Connect a Google Chat app to an agent to reach it from direct messages and spaces in Google Workspace: mention gating, one session per thread with replies nested under the message that started them, space and user allowlists with operator rights, inbound file downloads, and native slash commands.

    Google signs inbound requests with a JWT rather than an HMAC, so the channel verifies it against Google's key set in either audience mode the Chat API console offers — the endpoint URL (captured for you by Register) or the Cloud project number.

    Chat allows only one write per second in each space, shared with every other Chat app there, so this provider defaults its reply mode to Final and paces long replies. Live progress is available per channel. Sending files is not supported: uploading to Chat requires user authorization that an app cannot hold.

    `mf channels create --provider` lists the new provider.

## 0.59.0

### Minor Changes

- [#188](https://github.com/manyfold-open/manyfold/pull/188) [`832cd55`](https://github.com/manyfold-open/manyfold/commit/832cd5569a38397c17a2e4602428d4bf89af88e0) Thanks [@yingca1](https://github.com/yingca1)! - Codex agents can now run GPT-6 Astra. It joins the model catalog at the head of the default preference scan (Astra → GPT-5.6 Sol → Terra → Luna → GPT-5.5 → …), matching the priority order Codex 0.153.4 ships, so a provider that serves Astra now defaults new agents to it while providers without it keep resolving as before. The `max` and `ultra` reasoning levels move from unexposed to selectable, gated per model — Astra, Sol and Terra reach `ultra`, Luna stops at `max`, GPT-5.5 and older stay at `xhigh`. GPT-5.3 Codex is deactivated in the catalog: it no longer exists in the upstream Codex model list.

## 0.58.1

### Patch Changes

- [#176](https://github.com/manyfold-open/manyfold/pull/176) [`5e61a09`](https://github.com/manyfold-open/manyfold/commit/5e61a092ffbdab0508c917b8323786b2246affa3) Thanks [@yingca1](https://github.com/yingca1)! - Fix the concurrency meter's releasing state, which rendered no colour at all.

    Two `className` template literals in `ConcurrencyIndicator` put one
    interpolation straight after another with no separator, so the two class names
    fused into one that matches nothing:

    - a bar belonging to a releasing sandbox emitted
      `h-2 flex-1 rounded-[3px] bg-successanimate-pulse opacity-60` — losing both
      its fill colour and the pulse, leaving an apparently empty bar at 60%
      opacity;
    - the chip emitted `… bg-success-bg text-successanimate-pulse` whenever
      anything was releasing — keeping its background but losing its text colour
      and the pulse.

    Both now separate the interpolations with a literal space. The space
    deliberately does not live inside the ternary branch: `prettier-plugin-tailwindcss`
    trims a leading space out of a plain string in that position, which is how the
    admin chat-session page's selected-row highlight had been broken by the same
    mechanism.

    Found by sweeping every class-string template literal in the repo for an
    interpolation adjacent to class text — 62 such templates in `apps/web`, 13 in
    `apps/admin`, 4 in `apps/web-cloud`; these two were the only remaining defects.

## 0.58.0

### Minor Changes

- [#167](https://github.com/manyfold-open/manyfold/pull/167) [`0d6b7ed`](https://github.com/manyfold-open/manyfold/commit/0d6b7edd7e479b7b9da929b0647434d880fb1705) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Make the model list navigable, and stop tagging every row with its protocol.

    A provider can expose 184 models and the list had no search, so finding
    `claude-sonnet-4-6` meant reading. It has a search field now, filtering on the
    model id, with the header count switching to `8 of 184` while a query is
    active and the group counts following the filtered subset.

    The deeper change is what a row is. "All" used to de-duplicate by model id, so
    a row could stand for the same id served over two protocols with a different
    enabled state on each — which is why every row carried a protocol tag, struck
    through where that protocol was off, and why one switch had to toggle them all
    at once with an indeterminate middle state. A row is now a single
    (protocol, model) pair under a protocol group heading. The tag disappears
    because the heading says it once, the switch means exactly what it looks like,
    and the counts stop contradicting each other: `All` is the sum of its own tabs
    (184 = 66 + 45 + 7 + 66), where the de-duplicated count never could be. Group
    headings carry that protocol's enabled count and its own enable-all /
    disable-all, so the batch controls sit next to what they act on.

    `ProtocolModelGrid` derives the grouping itself when a caller passes the whole
    protocol map, so existing callers — including the cloud edition's managed
    panel — get the grouped view without changing their call. Passing `groups`
    explicitly is what a caller with its own search box does.
    `SingleProtocolModels` keeps its signature and delegates to the grid, so a
    single-protocol tab and the "All" tab render rows the same way.

    Three narrow-screen fixes ride along, all of which the search field would
    otherwise have made worse. The tab strip scrolls instead of wrapping — a
    wrapped row of tabs reads as two rows of buttons rather than one segmented
    control. A row's price drops below the model id instead of squeezing it,
    because the tail of `claude-haiku-4-5-20251001` is the part that identifies
    it and an ellipsis eats exactly that. And the search / refresh / save group
    takes the full width of a narrow column with the field flexing into it, while
    `Refresh models` collapses to its icon: at their desktop widths the three come
    to 375px inside a 335px column, which pushed `Save` off the right edge and put
    20px of horizontal scroll on the page. Refresh is the one that gives up its
    label — the widest of the three, and the least urgent, since the list refreshes
    itself on load — and keeps it as the tooltip and the `aria-label`.

- [#174](https://github.com/manyfold-open/manyfold/pull/174) [`ea49728`](https://github.com/manyfold-open/manyfold/commit/ea497284b2e6d091be3243c3ef9e7481da53b84d) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Move the resource meters to the foot of the rail.

    The concurrency chip hung from the Agents section header, and that header is
    not rendered at all when the rail is collapsed — so the one indicator telling
    you whether another sandbox can start disappeared exactly when the rail was
    narrow enough that you might want to check it without expanding anything.

    It now sits in its own strip above the account row, which is where the question
    it answers lives: not "what about these agents" but "how much of this account
    is left". Collapsed, the chip keeps its tone and drops its numbers — 58px
    cannot hold `0/10`, and a glyph that still reads red is worth more than no
    glyph at all. The count comes back in the tooltip and in the panel.

    The panel it opens now picks its side. It always dropped downward, which was
    fine when the chip hung from a section header near the top of the rail and is
    not fine at the foot of it — measured at a 950px window with no sandboxes
    running, 140px of the panel fell below the fold, and the list inside it grows
    by up to another 256px. It opens below when it fits there, flips above when it
    does not, and is capped to whichever side it lands on so a long list scrolls
    instead of running off the screen.

    One editions extension point ships alongside it, contributing nothing in this
    build and changing no layout: `src/shell-extra.tsx` names two regions of the
    shell — the new meter strip and the shell root — that a distribution can mount
    into by shadowing the module at its path. Regions, not features: this app does
    not know what a distribution puts there.

    `SidebarSectionHeader`'s `meta` slot is removed along with the move: it had
    exactly one caller, and an unused extension point on a header that collapses
    out of view is an invitation to repeat the bug.

- [#180](https://github.com/manyfold-open/manyfold/pull/180) [`6af34bb`](https://github.com/manyfold-open/manyfold/commit/6af34bba9fb0c4de72d8122738887c7278834aa7) Thanks [@yingca1](https://github.com/yingca1)! - Update Center batches keep running after you leave the page. The queue now lives outside the route, so the per-row states and the "N updated · M failed" summary are still there when you come back, and the account menu's Updates entry shows "Updating" while a batch runs.

### Patch Changes

- [#174](https://github.com/manyfold-open/manyfold/pull/174) [`ea49728`](https://github.com/manyfold-open/manyfold/commit/ea497284b2e6d091be3243c3ef9e7481da53b84d) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Scan the editions overlay directory for Tailwind classes.

    `tailwind.config.ts` listed `./src` and nothing else, but a distribution that
    sets `MF_WEB_OVERLAY_DIR` replaces modules under `./src` by path — so part of
    the markup Tailwind is generating rules for lives outside the directory it was
    looking at. Any utility used _only_ by an overlay module was therefore purged,
    and the failure is silent: the class stays on the element, no rule is emitted,
    nothing warns. A `pl-7` reserving room for an input's prefix adornment was
    dropped this way, and the adornment landed on top of the value.

    The config now appends `$MF_WEB_OVERLAY_DIR/**/*.{ts,tsx}` when that variable
    is set — the same signal `vite.config.ts` already keys the overlay resolver
    off, so the two agree on what the app is made of. Unset here, where the spread
    contributes nothing and the content globs are byte-identical to before.

## 0.57.0

### Minor Changes

- [#169](https://github.com/manyfold-open/manyfold/pull/169) [`6671c65`](https://github.com/manyfold-open/manyfold/commit/6671c65615b7aec5f064a6a47d4ace41c077f089) Thanks [@yingca1](https://github.com/yingca1)! - The Agent sessions panel loads progressively and stays fast with many sessions. Cloud sessions show at once — each with its title, newest reply and model straight from the database — while the runtime is scanned in the background; reopening the panel shows the last list immediately and refreshes it, and "Show more" reaches runtime sessions older than the newest 25. The panel no longer closes when you switch sessions, only when you switch agents.

    On the runtime, the scan now takes one index of every transcript and reads only the files that changed since the last scan, instead of forking a process per file and re-reading the newest fifty every time; Claude Code subagent transcripts, which duplicated their parent session, are left out. The `runtime-sessions/list` API accepts `local: 'skip'` and `localLimit`, and reports `localTotal` / `localListed` with `localScan: 'skipped'` when the runtime was not asked.

## 0.56.0

### Minor Changes

- [#159](https://github.com/manyfold-open/manyfold/pull/159) [`b8108e9`](https://github.com/manyfold-open/manyfold/commit/b8108e9bdc2ac76513b3d405192e98ffdba32309) Thanks [@yingca1](https://github.com/yingca1)! - The chat's right-hand runtime session panel becomes **Agent sessions**, and it
  opens on a list of every conversation the agent has instead of dropping you into
  one transcript.

    The list is the union of both places a session can live. The cloud database
    holds the conversations you started in the web app; the framework's own CLI
    leaves transcripts on the runtime. They are joined on the runtime's session id,
    so a conversation that exists on both sides is one row, and each row says which
    sides it is on, whether it is the conversation currently open, how many messages
    it holds, when it was last active, the model that wrote the newest reply and
    what that reply said. A row we never read on the runtime stays silent about
    replies rather than claiming there were none.

    An unreachable runtime no longer fails the whole panel. A stopped sandbox or an
    offline daemon now degrades to the cloud half of the list and says the local
    side is unknown, instead of returning a service error.

    Each row carries a menu to copy the framework's resume command, the session id
    and the transcript's file path, refused with a reason where the row has no
    runtime transcript or the framework's CLI cannot be pointed at a session by id.
    The copied command is deliberately the plain `claude --resume <id>` /
    `codex resume <id>` form: the terminal's own resume adds a permission-bypass
    flag because it is entering a runtime that is already the trust boundary, and a
    command on your clipboard runs wherever you paste it.

    Opening the panel used to read a whole transcript before it could show anything.
    The list is now its own endpoint, `POST /agents/:id/runtime-sessions/list`, which
    runs one bounded scan and reads no transcript; opening a named session skips the
    scan the caller already paid for. That scan now also reads the last 64 KiB of any
    transcript past its head window, because the newest reply, its timestamp and its
    model are at the end of the file. Frameworks whose transcripts record no model —
    OpenClaw and Hermes — leave that field empty rather than showing a guess.

    Two smaller things in the same panel. Arriving at a chat no longer opens the
    Files panel for you — it used to open itself on first entry to any agent with a
    workspace, taking the side of the screen before you asked for anything. And
    below the large breakpoint the panel now covers the screen instead of sharing
    the height with the conversation, which left both halves too short to use on a
    phone.

### Patch Changes

- [#162](https://github.com/manyfold-open/manyfold/pull/162) [`e4ddda0`](https://github.com/manyfold-open/manyfold/commit/e4ddda0759688561f5adefc83afe6255c010f44d) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Let heading tracking come from the rung.

    Every heading rung carries its own letter-spacing in the `fontSize` tuple —
    h3 −0.01em, h2 −0.015em, h1 −0.02em, display −0.025em — because tracking has
    to tighten as size grows and the tuple is the one place that knows the size.
    34 headings then stacked `tracking-tight` on top of that. Both write
    `letter-spacing`, and Tailwind emits the `tracking-*` utilities after the
    `text-*` ones, so the utility won: an 18px panel title rendered at −0.025em,
    the tightening reserved for 32px display copy, roughly a quarter-pixel per
    letter too tight and a few pixels narrower over a title.

    It read as inconsistency rather than as a bug — some titles tightened, some
    not, depending on which page you were on. Removing the utility puts every
    heading back on its rung's own value; nothing else changes.

    `.settings-stat-value` had the same stack and is fixed with them. The one
    `tracking-tight` that stays is on a mono caption in the chat footer, which is
    not a heading rung — tightening a mono run there is a deliberate choice.

- [#160](https://github.com/manyfold-open/manyfold/pull/160) [`daa8ad9`](https://github.com/manyfold-open/manyfold/commit/daa8ad9ee4774f88c9fce50f6dfd52ab0b4609c2) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Keep the landing copy on screen when the language changes.

    Switching language on the landing page left the whole left-hand column blank —
    nav and artwork intact, hero headline, tagline and CTAs gone — until the next
    scroll brought them back. The five scrollytelling cards cross-fade, so
    `.lp-scene` defaults to `opacity: 0` and the scroll loop writes the live
    opacity in; but each card was keyed by its own eyebrow text, so a language
    change gave every card a new key, React remounted all five, and the fresh
    nodes came up with no inline style and nothing to repaint them. The cards are
    now keyed by position: the copy swaps in place, and a switch made part-way
    through the story keeps the scene the reader is on.

## 0.55.0

### Minor Changes

- [#155](https://github.com/manyfold-open/manyfold/pull/155) [`f052ae2`](https://github.com/manyfold-open/manyfold/commit/f052ae2fad5ff5146b0217d001b5b4e4abf410c5) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Land Fraunces as the landing's display face.

    The spec has said Fraunces since it was written — SOFT 50, WONK 0, weight 300
    — but `styles.css` imported Source Serif 4, and had since the register was
    built. A plan was written down and never executed, and the two are not the
    same kind of serif: Fraunces is a high-contrast display face drawn for large
    sizes, Source Serif 4 is a low-contrast text face Adobe drew for screen body
    copy. Every rule downstream of that choice — weight, tracking, the optical
    size cut a heading lands on — was tuned for a face the page was not using.

    The page now loads `@fontsource-variable/fraunces/full.css`, not `opsz.css`:
    Fraunces carries four axes and this register uses SOFT, which the narrower
    file would leave inert with no error. Weight drops to 300, which is where a
    display serif sits at the same visual mass a text serif needs 400 for, with
    `.lp-h3` overridden back to 400 — at 24-29px the thin strokes stop carrying.

    The social cards follow, since they reproduce the hero: someone who clicks a
    shared link must not meet a different face on arrival. The zh card gains a
    pinned Noto Serif SC so its headline is a serif too, matching the landing's
    CJK fallback rather than staying on the sans it had. Cards ship as v5.

    Source Serif 4 is removed; nothing else used it.

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

- [#155](https://github.com/manyfold-open/manyfold/pull/155) [`f052ae2`](https://github.com/manyfold-open/manyfold/commit/f052ae2fad5ff5146b0217d001b5b4e4abf410c5) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Move the product register onto the landing visual system.

    Colour: the neutral axis is re-hued from cool graphite to Ash on landing's
    cool-bias curve while keeping every tier's luminance, so the workbench's
    volume hierarchy and hover contract are untouched; the brand colour moves
    from steel blue to the Iris ramp (which both registers now share); the four
    judgment colours take landing's hues at product contrast, and every status
    text colour clears WCAG AA where none did before.

    The radius scale itself is unchanged at 8 / 10 / 14. What changes is docs:
    its header controls and buttons were pill-shaped off the scale entirely and
    now sit on it, so a docs button and a workbench button are the same shape.

    Every page title now sits on the `text-h1` rung; docs headings drop from 600
    to the 500 cap. The product stays in Geist throughout.

- [#155](https://github.com/manyfold-open/manyfold/pull/155) [`f052ae2`](https://github.com/manyfold-open/manyfold/commit/f052ae2fad5ff5146b0217d001b5b4e4abf410c5) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Repaint the social cards onto the Iris palette.

    Both were left behind by the product migration, in two different directions.
    The generated card behind changelog entries was still teal (`#0f8c6f`) — the
    accent from two brand colours ago. The static poster every other page shares
    was still the pre-Iris steel blue, on a ground (`#dde0e3`) darker than the
    landing has used since the neutral axis moved. Sharing a link produced a
    preview in a colour the page it opened did not contain.

    The poster's headline also stopped etching itself. `.lp-h-accent` dropped its
    metal gradient when the landing went flat; the poster kept reproducing it,
    including a gradient stop (`#d6e0e8`) that belonged to no palette. It now
    paints flat `--lp-info`, as the page does.

    Cards ship as v5. v3 is frozen into `RETIRED_CARDS`, so a link shared before
    this still resolves to the exact bytes it was shared with.

    The colours in both cards are still written literally rather than imported —
    that is deliberate, so a CSS refactor cannot silently repaint every card that
    is already in circulation — but each constant now names the token it mirrors,
    which is what was missing when they drifted.

### Patch Changes

- [#155](https://github.com/manyfold-open/manyfold/pull/155) [`f052ae2`](https://github.com/manyfold-open/manyfold/commit/f052ae2fad5ff5146b0217d001b5b4e4abf410c5) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Stop the viewport flashing grey before the app paints.

    `html` / `body` painted `--color-app-bg`, the chassis colour. Since the
    neutral axis inverted, the chassis sits 24 levels below the canvas in light
    mode (and 14 above it in dark), so every cold load showed a grey viewport
    that then jumped to near-white the moment boot rendered — boot fills with
    `bg-main`, and the ground underneath it did not match.

    They now paint `--color-main-bg`, the canvas boot actually fills with. The
    chassis is unaffected: `AppShell` already paints it on its own root, as do
    the other eleven top-level surfaces paint theirs, so this layer was only
    ever visible in the gap between stylesheet and first paint.

## 0.54.0

### Minor Changes

- [#143](https://github.com/manyfold-open/manyfold/pull/143) [`d33315f`](https://github.com/manyfold-open/manyfold/commit/d33315f21fc026403638529d45e0aec7553ead08) Thanks [@yingca1](https://github.com/yingca1)! - The chat header carries a Chat / Terminal switch, so a session's terminal is a
  full-height view of that session rather than only a dock along the bottom. Both
  panes stay mounted: switching back to Chat keeps the reading position, and
  switching back to Terminal keeps the shell, its scrollback and its websocket, so
  the toggle costs nothing on either side. The terminal segment is refused with a
  reason for an external-provider agent (no shell exists to attach to) and for a
  stopped one, and a sprites sandbox with the terminal turned off still asks
  before enabling it. The bottom dock is unchanged: it remains the place for
  several shells at once, for a shell opened at a particular directory from the
  file tree, and for one that must outlive the page you opened it on.

- [#143](https://github.com/manyfold-open/manyfold/pull/143) [`d33315f`](https://github.com/manyfold-open/manyfold/commit/d33315f21fc026403638529d45e0aec7553ead08) Thanks [@yingca1](https://github.com/yingca1)! - Switching a session to Terminal can now land you straight in the coding CLI's
  own interactive interface, resumed on that same conversation, instead of at a
  bare prompt. The chat view and the TUI become two front ends over one session.
  Works on sandbox and self-hosted (daemon) agents alike; a daemon needs a CLI
  new enough to advertise the `pty.command` capability, and one that is not says
  so rather than opening a plain shell under a UI that promised a resume.

    The command runs as the shell's argv rather than being typed into the pty, so
    there is no guessing whether the prompt is ready yet, and quitting the TUI
    leaves the interactive shell you would otherwise have had. Only the chat
    session id travels from the browser: the API looks up that session's own
    recorded reference and builds the argv, so no caller chooses what runs in the
    sandbox. Claude Code and Codex are supported; Gemini's resume takes a session
    index rather than an id, so it opens a normal shell.

    The resumed TUI opens in full-access mode (`--dangerously-skip-permissions` for
    Claude Code, `--dangerously-bypass-approvals-and-sandbox` for Codex) and forces
    transcript persistence on, so continuing the conversation there stays in sync
    with the chat view rather than prompting for every action or silently
    discarding what you did. The runtime is already the trust boundary — your own
    daemon machine, or an externally-sandboxed sprite.

    Codex needs nothing further — it signs in on the sandbox at creation and its
    credentials are already on disk. Claude Code's are injected per turn and never
    persist, so its TUI has nothing to authenticate with unless you turn on the
    new per-sandbox **Model credentials in the terminal**, which is off by default
    and separate from the existing terminal switch. It is worth reading before
    enabling: anyone who can open that terminal can then read the key, which the
    API otherwise only ever returns masked. A runtime-local agent needs no such
    opt-in, only its CLI sign-in. When resuming is unavailable the terminal still
    opens as a shell and says which of the two things it was missing.

- [#143](https://github.com/manyfold-open/manyfold/pull/143) [`d33315f`](https://github.com/manyfold-open/manyfold/commit/d33315f21fc026403638529d45e0aec7553ead08) Thanks [@yingca1](https://github.com/yingca1)! - Messages you write in the resumed terminal TUI now appear back in the chat
  view. The TUI writes only to the framework CLI's own transcript, which the
  cloud chat never read, so continuing a conversation there used to vanish from
  the structured view. The chat now folds that transcript's additions back into
  the session — on switching back from the terminal, and on opening the session —
  by diffing the CLI's file against the stored messages and appending only what
  is new. Idempotent and skipped while a live turn is running, so it is safe to
  run automatically. Claude Code and Codex; the API endpoint is
  `POST /agents/:id/runtime-sessions/sync`.

### Patch Changes

- [#143](https://github.com/manyfold-open/manyfold/pull/143) [`d33315f`](https://github.com/manyfold-open/manyfold/commit/d33315f21fc026403638529d45e0aec7553ead08) Thanks [@yingca1](https://github.com/yingca1)! - The chat header's lower-frequency actions — share, open terminal, refresh, and
  the runtime session viewer — collapse into a single overflow (⋯) menu, leaving
  the bar to the Chat / Terminal view switch and the file / preview / tasks panel
  toggles. Fewer competing icons, and the "open terminal" dock action no longer
  sits confusingly next to the Chat / Terminal view switch.

- [#143](https://github.com/manyfold-open/manyfold/pull/143) [`d33315f`](https://github.com/manyfold-open/manyfold/commit/d33315f21fc026403638529d45e0aec7553ead08) Thanks [@yingca1](https://github.com/yingca1)! - Fixes for folding a resumed TUI's messages back into the chat. Appended
  messages now carry their `done` terminal in the same transaction (all recovery
  writers), so a page reload no longer mistakes a synced turn for a dead inflight
  one and stamps `server_restart` over it. The append is idempotent by
  `source_event_key`, so repeated Chat↔TUI switches can no longer duplicate
  messages, and a TUI turn that is still streaming is left for the next sync
  instead of being frozen as an empty bubble. The session terminal now follows
  the sidebar's session switch, resuming the newly selected session — and the
  sync runs the other way too: messages sent from the chat after the TUI was
  opened rebuild it on the next switch, so the resumed TUI always shows the
  whole conversation.

- [#143](https://github.com/manyfold-open/manyfold/pull/143) [`d33315f`](https://github.com/manyfold-open/manyfold/commit/d33315f21fc026403638529d45e0aec7553ead08) Thanks [@yingca1](https://github.com/yingca1)! - The chat's right-hand panels — background tasks, the workspace files (tree +
  preview), and the runtime session viewer — now share one side pane whose title
  is a dropdown that switches between them, instead of three separate overlapping
  panels living at two different layers. Only one is open at a time; the header
  buttons and the Shift+Cmd+E / Option+Cmd+B shortcuts open the pane to their
  panel, and each single-column panel remembers its own width.

## 0.53.0

### Minor Changes

- [#144](https://github.com/manyfold-open/manyfold/pull/144) [`6ee91e5`](https://github.com/manyfold-open/manyfold/commit/6ee91e5679ad9e22f9f999b0b87663df5586f85a) Thanks [@yingca1](https://github.com/yingca1)! - Show the signed-in account and its usage on the runtime page, and sign in from there.

    The runtime detail page (`/settings/runtimes/<runtimeId>`) gains an Account section for Claude Code, Codex and Gemini CLI runtimes on self-owned machines and sandboxes: the signed-in identity (email, organization, plan), the sign-in status, and the subscription usage windows with their reset countdowns (Claude 5h/7d, Codex primary/secondary, Gemini per-model quota). The host reads the CLI's own credential files and calls the vendor usage endpoint itself; only the response and non-secret identity fields ever leave the machine.

    - CLI daemon: new `account.inspect` RPC, advertised through the `account.inspect` client feature. Runtime pages of daemons on older CLIs show an update prompt instead of a probe failure.
    - API: `GET /agent-runtimes/:id/account` (`?wake=1` to probe a sleeping sandbox, which starts the VM and reserves an active slot), plus a `runtimeId` target on the terminal websocket for a bare host shell.
    - Web: when the runtime is not signed in, "Sign in" opens an inline terminal on the host that starts the CLI's own headless sign-in (`claude auth login --claudeai`, `codex login --device-auth`, `NO_BROWSER=true gemini`); closing it re-checks the account. The chat sign-in card now recommends `claude auth login --claudeai` too.
    - On macOS machines the Claude and Gemini tokens live in the Keychain, which the daemon deliberately does not read, so identity shows but usage does not.

### Patch Changes

- [#142](https://github.com/manyfold-open/manyfold/pull/142) [`f55932a`](https://github.com/manyfold-open/manyfold/commit/f55932a2303b3970f03361f40a7c67cac591a70d) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - The landing's popular pricing tier is marked by its tag alone.

    The Plus card also carried a 1.5px iris ring inset over its shadow, which put
    two markers on one tier and made the card itself look selected next to the
    three plain ones — on a page where the signed-in cards already use a badge to
    say which plan is current. The ring is gone and every card now renders the same
    frame; the POPULAR tag is the whole signal.

    Its `.lp-price-badge.lp-price-popular` rule went with it: `--lp-terracotta`,
    which the base badge paints with, has been an alias of `--lp-info` since the
    palette consolidated, so the override resolved to the colour it was already
    painting.

- [#142](https://github.com/manyfold-open/manyfold/pull/142) [`f55932a`](https://github.com/manyfold-open/manyfold/commit/f55932a2303b3970f03361f40a7c67cac591a70d) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - The landing world's solids now all take the same light in light mode.

    Two boxes were reading against the scene's own key light, which falls from the
    upper left — tops brightest, left faces a step above right ones. The archive
    plane's three cabinets are authored facing the other way and mirrored into
    place, and the mirror had been added without swapping their side shading back,
    so each one was lit from the right while everything around it was lit from the
    left. The delivery cube's top used `--lp-w-box-accent`, the landmark step above
    an ordinary top: in dark mode that is a lighter face, but on paper an ordinary
    top is already white, so the light value had been stepped the other way and the
    landmark rendered as the one grey box in a scene of white ones.

    The cabinets swap their two side tokens inside the mirrored group, and the
    accent tops out at white where it has nowhere brighter to go. Dark mode is
    untouched: its accent still sits a step above its ordinary tops. Checked in
    both themes — every left face on the stage is now the lit one, and every box
    top matches its neighbours.

## 0.52.1

### Patch Changes

- [#136](https://github.com/manyfold-open/manyfold/pull/136) [`e9f681e`](https://github.com/manyfold-open/manyfold/commit/e9f681eb1f22d424ec9520c69d864c25d22e5579) Thanks [@yingca1](https://github.com/yingca1)! - Serve `/updates` and `/account` as SPA routes. Caddy serves the app shell only
  for an explicit list of route families and 404s everything else, so both were
  registered in the router but unreachable once deployed: the Update Center
  returned the 404 page, as did the account-deletion confirm and restore pages
  that people reach from an emailed link.

## 0.52.0

### Minor Changes

- [#132](https://github.com/manyfold-open/manyfold/pull/132) [`cc2faee`](https://github.com/manyfold-open/manyfold/commit/cc2faee7fe103a0685d5032d045c8280c4f8bd87) Thanks [@yingca1](https://github.com/yingca1)! - Add the Update Center: one page listing every available update across machines,
  agents and skills, with group-by filtering and multi-select batch updates.

    Update reminders that used to act in place now link there instead — the mf CLI
    banner, the CLI and framework notices on the runtimes pages, the agent overview
    hints, the self-owned machine list and the agent skills panel. Version pickers
    and "install missing" prompts are unchanged; they are separate actions.

### Patch Changes

- [#130](https://github.com/manyfold-open/manyfold/pull/130) [`3e82814`](https://github.com/manyfold-open/manyfold/commit/3e8281460f92b21631afa748353311d6554b6c42) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - The landing world's leader captions now read as blocks instead of nine
  different indents.

    Every caption is a title with a mono line under it, and the pair is supposed to
    hang off one leader. But the second line's `x` had been set by eye for each
    one: measured against its own title it sat at -48, -26, -13, -6, +8, +13, +18,
    +21 and +48. No two agreed, and on the cloud-computer plate the offset was
    large enough that `ALWAYS ON` started where `Cloud computer` ended and ran back
    under its own leader. Each mono line now takes its title's `x` and anchor, so
    both lines are flush on the side the leader comes from — which is the edge the
    elbow points at.

    Flush lines are wider than staggered ones, and two captions then reached
    artwork their title had cleared on its own, so their leaders drop or rise
    further before turning out: `Your own machine` now sits above the screen it was
    printing over, and `Stateful sandboxes` has more than the 0.4 units it had
    between its mono line and the plate below.

    Three placements are fixed alongside them. `Skills & MCP` and the control
    plane's own layer title were drawn through each other — the note hangs into the
    margin below the plate's near edge, which is where the title lives; the title
    now sits further along that edge, since the note cannot move up without landing
    on the plate or down without a leader twice the length of any other.
    `External services` and `Your schedule` were both printed on their own plate,
    crossing its front edge, and now drop clear of it first. The delivery plane's
    layer title moves along its edge too: at 1024 it was overlapping the copy
    column's third bullet.

    Checked at 390, 430, 768, 820, 1024, 1280, 1440 and 1920 across all three
    scenes: no caption overlaps another caption, the copy column, or runs off the
    stage.

- [#130](https://github.com/manyfold-open/manyfold/pull/130) [`3e82814`](https://github.com/manyfold-open/manyfold/commit/3e8281460f92b21631afa748353311d6554b6c42) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - The landing world's top plane now puts each framework on the runtime it
  actually runs on.

    The four agent plates are labelled by runtime — stateful sandboxes, cloud
    computer, your own machine, external services — but three of the marks standing
    on them were placed before the runtimes were, and had drifted into claims that
    aren't true: OpenClaw sat in a sandbox, Dify on the cloud computer, and a second
    Claude Code stood in for the external services the platform doesn't host. A
    reader who knows the frameworks reads the plane as a map, so a mark on the wrong
    plate is a wrong statement, not a decoration.

    The sandbox plate now carries NarraNexus, the cloud computer carries OpenClaw,
    and external services carries Dify — which also stops Claude Code from appearing
    twice in a scene whose whole point is that the marks are the variable.

    `@lobehub/icons` has no NarraNexus mark, so the world borrows the product's own
    asset, the pair `frameworkMeta` already renders everywhere else. It goes in as
    two `<image>` elements swapped by theme rather than one tinted mark, because the
    stroke is a black-to-grey gradient in light and white-to-grey in dark, which
    `currentColor` cannot express; a nested `viewBox` crops the file's square canvas
    to the artwork's own band so the mark fills its slot on the head instead of
    sitting at 60% with air above and below it.

## 0.51.0

### Minor Changes

- [#125](https://github.com/manyfold-open/manyfold/pull/125) [`550f52f`](https://github.com/manyfold-open/manyfold/commit/550f52fc2f3d995dcd1b713c11df310fcd8862ac) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - The landing page's closing CTA block is gone.

    It restated the hero one screen after the pricing table and the FAQ had already
    made the case, with the same two buttons the hero opens with and the same offer
    the pricing table states — a third ask on a page whose reader has by then been
    asked twice. The FAQ now runs into the footer, which still carries the sign-up
    route for anyone who reaches the bottom.

    The no-JS snapshot drops its matching block for the same reason: that view's
    contract is to mirror what the page shows, and its hero already carries the
    same two crawlable links, so nothing is lost to a crawler. About 130 lines of
    the CSS that drew the card — a graphite slab with its own LED edge, chamfer
    washes and brushed grain, none of it used anywhere else — and the four copy
    keys behind it come out with it.

    The rule above the footer goes with it. It was the page's only full-width
    hairline: every section boundary on this page is white space, and the hairlines
    that do exist belong inside a block — the FAQ's rows, the pricing card's
    feature list — rather than between blocks. It had the CTA card to separate
    itself from; without it, it sat 112px under the FAQ's own closing rule and
    underlined nothing. The footer's smaller, quieter type and 148px of clearance
    carry the boundary on their own.

- [#125](https://github.com/manyfold-open/manyfold/pull/125) [`550f52f`](https://github.com/manyfold-open/manyfold/commit/550f52fc2f3d995dcd1b713c11df310fcd8862ac) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - The landing page's metering section is now an observability section.

    It used to argue one thing — that a run's price is visible — with a
    month-to-date figure heading the section and three claims underneath that were
    all restatements of it. What a reader needs in order to trust an agent they
    cannot watch is broader than the bill: what it did, what that cost, and what it
    was allowed to touch. Those are three peers, so the section is now three
    columns instead of three stacked pairs, and the month-to-date figure sits in
    the cost column where it belongs.

    The paired rows are gone with it. Each row put a wide artefact beside the
    sentence it proved, which left the three artefacts at three different heights
    with no shared baseline between the halves. The columns are a CSS subgrid, so
    every panel sits in the same row and the three share a height without anyone
    picking a min-height; stacked under 900px they go back to sizing themselves.
    The closing line about failed runs is dropped — the claims carry the section
    without it.

    The no-JS snapshot follows the same copy, so a crawler reads the section the
    page actually shows.

- [#125](https://github.com/manyfold-open/manyfold/pull/125) [`550f52f`](https://github.com/manyfold-open/manyfold/commit/550f52fc2f3d995dcd1b713c11df310fcd8862ac) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - The landing page is now one scrolled explanation instead of a hero plus five
  sections that each restated the product from a different angle.

    The old page opened on a floor of roaming agent standees that could fold away
    to reveal a second, classic hero behind it, and then said the same thing four
    more times: Flow ("three steps to a working agent"), Machines ("run your
    workspace anywhere"), Features ("automations, integrations, connective
    tissue"), each with its own illustrated apparatus. Everything above the pricing
    table was an argument about what Manyfold is, made three ways, none of which
    showed how the parts sit together.

    The hero is now a pinned stage the reader scrolls through. One isometric world
    holds the whole product in three stacked planes — agent infrastructure on top,
    the Manyfold control plane in the middle, delivery surfaces at the bottom — and
    the camera pans and zooms to the plane each scene is describing while the copy
    rail cross-fades beside it. Five scenes: the claim, hosting, one workspace,
    every surface, and the point. Below the stage, "Works with" lists what actually
    plugs in (frameworks, channels, runtimes) as three rows of chips rather than
    prose, and a new metering section shows a per-turn usage ledger next to the
    three things it buys you — visible, choosable, capped — with an honest note
    that we do not claim the cheapest run every time.

    Pricing, FAQ and the closing CTA keep their existing treatment; the Plus tier
    now carries the POPULAR badge the grid always implied, and the FAQ answers the
    five questions someone weighing this against building it themselves actually
    asks.

    The stage sits on the page's own grid rather than floating over the viewport:
    the copy starts on the same left edge as every section below it, and the world
    occupies a column inside the container instead of being shoved against the
    right edge by its aspect ratio. The drawing's viewBox was also trimmed to its
    own ink — a quarter of its width was empty space on the right, which had been
    holding the illustration away from the words. Section headings drop from 76px
    to 54px so they sit under the 62px hero title instead of above it.

    Copy notes: the hero's four keys are the ones the OG card renders, so the card
    is a still of the new hero and has been re-rendered. Chinese sets solid, so zh
    gets `word-break: keep-all` and its own step down the heading ramp — without
    it the browser was breaking 成倍放大 across two lines in the 46%-wide rail.

    Removed with the old page: `ProductDemo`, the workspace-floor hero, and about
    2,900 lines of the CSS that drew them.

### Patch Changes

- [#125](https://github.com/manyfold-open/manyfold/pull/125) [`550f52f`](https://github.com/manyfold-open/manyfold/commit/550f52fc2f3d995dcd1b713c11df310fcd8862ac) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Both sites now link the public repository. GitHub joins X and Discord in the
  navigation and the footer on manyfold.ai and docs.manyfold.ai, and leads them:
  for an open-source product the source is where the other two are pointing
  people anyway. The docs header, which carries only the doors a reader
  mid-problem needs, gains it alongside Discord.

- [#125](https://github.com/manyfold-open/manyfold/pull/125) [`550f52f`](https://github.com/manyfold-open/manyfold/commit/550f52fc2f3d995dcd1b713c11df310fcd8862ac) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - On phones the hero's drawing is centred and the dead air under the copy is
  gone.

    The world's viewBox had been trimmed to the drawing's ink once, but the ink has
    moved since — planes translated, bodies rebuilt — and it had drifted 64 units
    right of the frame's centre, which on a phone reads as the whole illustration
    sitting off to one side. The viewBox is re-centred on where the ink actually is
    now, and the camera's own centre moves with it so the zoomed scenes still frame
    the plane they are describing.

    The portrait layout gave the art a fixed 46vh band and the copy everything
    below it, so the taller the phone the larger the pocket of nothing under the
    scroll hint — 146px at 375x812 — while the drawing stayed the same size. The
    copy now takes only what it needs and the drawing takes the rest: at 375x812
    the art goes from 374px to 464px and the pocket from 146px to 56px. The rail's
    scenes are absolutely positioned, so its row cannot size to content; the clamp
    is set from the tallest scene there is, which is the Chinese hero at 305px on a
    360-wide phone.

    The scenes themselves framed badly in portrait. The art band sat inside the
    stage's 22px gutter, so a drawing that was already wider than the band showed
    two pale bars down the sides and lost its leader captions to the clip; the band
    is full bleed now, and the gutter belongs to the copy alone. The narrow zoom was
    the other half: `km` was 2.3, which put a plane and its labels half again wider
    than the phone. A plane plus its captions is about 240px across at rest, so the
    narrow keys are 1.45 and 1.35 — the most zoom the width will take.

    The camera also gained a horizontal focus. It only ever had `focusY`, so every
    zoom happened about the world's own centre, and the planes do not share it —
    they sit at 346, 368 and 359 against the world's 388, a difference that any
    zoom above 1 magnifies into a plane pushed off to one side. Each scene now
    names the centre of the plane it is describing, which squares up the desktop
    framing too.

- [#125](https://github.com/manyfold-open/manyfold/pull/125) [`550f52f`](https://github.com/manyfold-open/manyfold/commit/550f52fc2f3d995dcd1b713c11df310fcd8862ac) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Remove the landing page header's background fill and bottom divider so the
  navigation sits directly on the hero canvas in both themes.

- [#125](https://github.com/manyfold-open/manyfold/pull/125) [`550f52f`](https://github.com/manyfold-open/manyfold/commit/550f52fc2f3d995dcd1b713c11df310fcd8862ac) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Delay landing World layer annotations until the camera zoom and focus settle,
  then fade them in as the active layer comes into view.

    Layer names are scoped to their active scene rather than remaining visible in
    the global overview, and use the landing display face at a quieter size. The
    camera transition leaves a clearer pause before supporting callouts appear.

    The Skills & MCP node is now illustrated as a compact isometric toolbox while
    keeping its existing annotation anchor aligned.

    Screen copy and usage marks now follow the isometric face direction instead of
    remaining flat to the viewport.

    The usage chart details are nudged inward from the card edge for a cleaner
    visual margin.

    The complete usage device is inset from the lower plate edge so its base and
    screen share the same visual margin.

    The control-plane usage device is shifted right within its card to match the
    requested alignment.

- [#125](https://github.com/manyfold-open/manyfold/pull/125) [`550f52f`](https://github.com/manyfold-open/manyfold/commit/550f52fc2f3d995dcd1b713c11df310fcd8862ac) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - The GitHub link in the marketing nav and footer has a label again.

    It called `web.marketing.sourceGithub`, which no catalog defined, so the
    accessible name and the menu item's text both rendered as the raw key.

- [#125](https://github.com/manyfold-open/manyfold/pull/125) [`550f52f`](https://github.com/manyfold-open/manyfold/commit/550f52fc2f3d995dcd1b713c11df310fcd8862ac) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - The landing world's three planes are now joined by light rather than by line.

    Every solid in the scene is drawn as a lit body — modelled faces, a silhouette
    outline, a contact shadow — but the wires between the planes were flat
    hairlines of one uniform alpha with flat discs sliding along them, and the
    mismatch is what made the lower half read as unfinished. The connective tissue
    now uses the same language as the bodies: each wire is a soft bloom under a
    crisp core whose stroke is a gradient fading with distance, so a cable has a
    length instead of being a band of constant value.

    Below the control plane the three trunk strands splay where they leave the
    plate and gather into a junction, so the bundle has a round cross-section
    instead of reading as a barcode — and all three now carry traffic, where only
    the middle one used to. The trunk lands on an actual junction: a puck with a
    plinth, a contact shadow, a halo and a ripple that fires on each arrival,
    rather than on a bare four-unit dot floating over a plate. The four routes out
    of it are curves that stop at a lit pad on each destination plate instead of
    straight chords aimed at the object standing on it, which is what used to send
    them through the solids they were meant to reach.

    One clock now runs the whole chain, so a single run can be followed all the way
    down: a packet reaching the junction, the ring it fires there and the route
    that leaves are the same run, where the old 3.2s trunk and the fan-out's own
    begins were aliased against each other and no two events were ever related.

    The packets themselves are lit beads — an aura, a hot core, and a tail that
    trails the head however the wire curves — that scale in and out rather than
    blinking. Above the control plane they keep their framework's hue, because
    what arrives there is a particular framework's run; below it they are the brand
    hue, because Manyfold has normalised them. The light is carried by gradients
    rather than blur filters, which would be re-rasterised on every camera frame.

    Light mode now treats the blue energy as reflected light on paper: the wide
    wire bloom, plane spill and control-cube glow are reduced independently, while
    dark mode keeps the stronger emissive treatment.

    `--lp-w-flux` and `--lp-w-flux-spec` are new: the flux is read against the
    world's plates rather than against the page, so on the near-black plate it has
    to climb the Iris ramp to hold the same weight, exactly as `--lp-w-wire` does.
    SMIL cannot be stopped from CSS, so under `prefers-reduced-motion` the moving
    parts are removed and the wires, ports and pads they travel between stay.

- [#125](https://github.com/manyfold-open/manyfold/pull/125) [`550f52f`](https://github.com/manyfold-open/manyfold/commit/550f52fc2f3d995dcd1b713c11df310fcd8862ac) Thanks [@jiam1ngfu](https://github.com/jiam1ngfu)! - Every body in the landing world now turns a face of the right width to the
  camera, and the agents work behind their desks instead of standing on them.

    The world was drawn on a correct 30° isometric grid, but a solid's footprint
    decides how wide each of its two visible faces reads: a body 52 deep by 34
    wide shows a 52-wide face to the left and a 34-wide face to the right. Nothing
    enforced a relationship between those two numbers, so bodies came out sheared.
    The desks were the loudest case in a second way — the ones whose screen faced
    left stood on their long edge and the ones facing right stood on their short
    edge, so the same workstation was 52 wide in one corner of the plane and 32 in
    another, wearing a 34-wide monitor in one place and a 16-wide one in another.

    Desks are rectangles now, and the long edge is always the one they face the
    camera with: the side the screen stands on and the figure works behind. The
    pipeline plate follows the same rule for the same reason — the node chain runs
    along it, so its long edge faces the camera too. The bodies that genuinely have
    no front — plinths, racks, the control-plane cube — are square in plan instead,
    which is that rule with no facing to honour; between them that fixed the
    terminal plinth at 1.96:1, the pipeline plate at 3.05:1 and the skills base at
    2.82:1. Thirteen of them were
    rebuilt, with their screens, bars, lamps and leader-line captions carried
    along. The ground plates keep their shapes, since a plot of ground is allowed
    to be oblong.

    The four identical stations, the bring-your-own desk and the two that face the
    other way were also nine separate copies of the same drawing. They are now one
    `Workstation` built on an isometric helper, where `flip` swaps the two ground
    axes to turn a whole station — desk, screen, long edge and figure — without
    touching a single proportion.

    The figure itself: it used to stand on the desktop, which is not what an agent
    at a workstation does. It is now drawn before its desk, so the desk's far edge
    cuts it at the waist and it reads as working behind it. Its head was a grey
    shell around a stroked inner card around the framework mark, three frames deep;
    it is now one blank face with the mark centred in it, a size larger. And it has
    an antenna — a stalk and a lamp that breathes green — because nothing in the
    world said whether an agent was actually running.

    The planes are also positioned with a denser vertical rhythm: the upper plane
    is translated down and the lower plane up as complete groups, bringing the
    stack together without changing the artwork's proportions. Short desktop
    viewports additionally give the hero copy a proportional step down.

    The delivery layer is now enlarged uniformly around its junction, with the
    fan-out curves and pads following the same coordinates so the larger footprint
    stays connected to the control plane.

    The top plane is also at work now. Each screen carries a live log: a line wipes
    and types back in over five steps, along the screen's own axis rather than
    across the drawing — the contents are authored in the face's own frame, so
    `scaleX` writes a line out instead of shearing it off the isometric grid. The
    run slot on each agent's body breathes with it, and the figure works: it taps
    four beats while its line is being written and stands still while the line
    stands. At this size a body moving a unit is under the eye's floor, so the read
    is carried by the head — a five-degree lean pivoted at the neck, two beats
    behind the body so the antenna whips rather than moving with it, which swings
    the lamp, the brightest thing on the plane, about three pixels in the hero and
    twice that once the camera is on this plane. Three clocks drive all of it —
    the log on 4.8s, the active line on 3.1s, the slot on 2.2s, none a multiple of
    another — and every station is handed each clock on its own negative delay, so
    seven desks never fall into step and none of them waits for a cycle to begin on
    load. The antenna lamps were pulsing in unison; they are staggered now too. All
    of it is CSS, so the world's existing reduced-motion rule already stops it, and
    the state it stops on is every line finished — which is what a screen at rest
    should show.

    The checklist board on the delivery plane had its tiles authored in screen
    coordinates inside a group that already carried the panel's own matrix, so the
    lattice was sheared twice and its columns marched across the drawing instead of
    along the face. The tiles are laid out in the panel's frame now — an even 4 x 3
    grid, one cell running and one ticked — and the tick stays upright, the way
    every other legend in the world is drawn.

    The delivery plane was four copies of one composition — a plate, a plinth, an
    upright panel — so the four surfaces it names read as one thing repeated rather
    than as the different places an agent's work actually lands. Each is now shaped
    like what it is. The terminal is a machine: a deck lying on the plate with the
    screen hinged up from its back edge, keys and a trackpad printed on the deck,
    and no plinth at all, which is what breaks the repeated stack. Your product arrives
    on a monitor: a cabinet with real thickness, so its top and side edges read as
    depth rather than as a poster stood on edge, carried on a column that reaches
    the desk, with the machine that drives it standing beside it and desk left in
    front of both, and the screen itself is smaller than the panel it
    replaces. It wears a window's own chrome, a title bar with three dots and an
    address pill. Its plinth follows the desks' rule too — the long edge is the one
    the screen faces the camera with.
    Team chat gets a speaker slit and a home bar, and the card is a handset. The
    schedule board already had its own grid and keeps it.

    The terminal's surface was also the only pure black in a near-white world, a
    hole in the light theme. It is a light console there now and stays dark in the
    dark theme, where dark is what the rest of the world is.

    The three surfaces that were still single quads have bodies now, built the same
    way as the monitor: a slab four to six units thick, so the lid and the side
    edge do the work a drop shadow would otherwise have to. Team chat is a phone —
    a bezel around an inset display, standing in a dock. The schedule and the usage
    readout are boards standing in base rails, one carrying a month header over a
    day grid, the other a bar chart on a baseline. A panel with no thickness reads
    as a sheet of paper propped up; in an isometric drawing the two visible edges
    are the whole of the illusion, and they cost three paths.

    The delivery wires now land somewhere. Each of the four pads sat on a plate's
    own edge or inside the footprint of the body standing on it, so the light
    arrived at a seam rather than on a surface; two of them were a pixel off a
    plinth's rim. Every pad is on bare plate now, clear of the plate's edges and of
    the body it serves, and the curves are shaped to approach from a side that
    crosses nothing. The product desk was the reason one of them had nowhere to go —
    it filled its plate to within ten units — so it is shallower, and the plate has
    an apron again.

    The lower two planes move now, and neither of them invents a clock. The wires
    already ran on one — FAN is 6.4s and every route arrives at a known beat — but
    nothing at the far end ever answered, so a packet landed on a pad and the
    surface it landed on carried on as though nothing had happened. Each of the
    four delivery surfaces is now handed its own route's arrival as a negative
    delay: a line types onto the terminal, a message lands on the phone, a row
    lands in the product, a tick appears on the schedule, each on the beat its
    packet touches down and each clearing again before the next. One run can be
    followed from an agent typing on the top plane to the row it becomes at the
    bottom.

    The control plane in between is deliberately not reacting to anything — it is
    simply running, on two slow periods of its own: the model rack answering in a
    scan rather than four lamps in lockstep, and the usage bar climbing in steps
    before the meter rolls over. The stores stay still — a cabinet blinking its
    handles reads as hardware status rather than as work being done. All
    of it is CSS, so the world's reduced-motion rule stops it and leaves every
    surface showing its finished state.

    The leader captions point at things again. Thirteen of them had been left
    behind by the rebuild: risers ending in mid-air beside a rack that had since
    been mirrored, an anchor a pixel off a plinth's rim, one that ran straight
    through an agent's head on its way up, and one whose whole elbow was buried
    inside the cube it named. Every anchor now sits a few units inside the
    silhouette of the body it names — never on a corner, never in the air — every
    riser is routed clear of anything it does not belong to, and the four captions
    whose elbow had inverted were moved to the side their leader can actually
    reach.

    The captions also sat too far out — risers long enough that a label floated in
    the dark well clear of the drawing, and on the agent plane one of them reached
    so far left it landed in the hero copy. Every riser is shorter now and every
    elbow is a short hook rather than a run, so a label hangs off the body it names
    instead of orbiting it. The two that still had nowhere to go were re-placed
    rather than shortened: one anchors further along its desk so its caption can
    lie against the plate, and one drops to where its plate is wide enough to
    carry it.

## 0.50.1

### Patch Changes

- [#121](https://github.com/manyfold-open/manyfold/pull/121) [`1c27f0f`](https://github.com/manyfold-open/manyfold/commit/1c27f0f60a63fcf1a6e255fbef4a6e96cc185631) Thanks [@yingca1](https://github.com/yingca1)! - Clicking the **Model providers** rail title while a provider is open now actually returns to the dashboard. The route changed to `/settings/model-providers/dashboard`, but the pane kept rendering the provider that was already open and the title never took its own active state: the effect that syncs the selection from the URL returned early on the dashboard segment, so it never cleared the previous pick. The early return was guarding against an auto-select fallback that no longer exists — the branch it skipped had since become the one that clears.

    The rule now lives in `pages/Settings/modelProviderSelection`, alongside the selection helpers it uses: the dashboard segment resolves to no selection and outranks a lingering `?selected=` param, which is what lets the pane switch back and keeps the rail from lighting up a provider beside the dashboard.

## 0.50.0

### Minor Changes

- [#116](https://github.com/manyfold-open/manyfold/pull/116) [`c139842`](https://github.com/manyfold-open/manyfold/commit/c139842d1e797d5f57829b49c7c128e643b5907a) Thanks [@yingca1](https://github.com/yingca1)! - The create-agent form gains a third model-provider choice for Claude Code, Codex and Gemini CLI: **Use your own subscription** — the agent runs on the sign-in the coding CLI holds inside its sandbox/computer (a Claude Pro/Max plan, a ChatGPT plan, a Google account), and Manyfold stores no API key for it. Picking it sends `modelConfigSource: 'runtime-local'` with no credential block. On self-hosted builds this mode is the default for those frameworks via a new editions slot (`lib/agentCreate/providerDefaultMode`); the cloud overlay keeps the saved-provider default (protagolabs/manyfold#1112 pairs with this and must merge there before the pin bump that carries it).

    After creating, the chat page shows a sign-in card while the runtime has no usable credentials: per-CLI instructions (run `claude` then `/login`; `codex login --device-auth`, since the standard flow needs a localhost callback the runtime cannot offer; gemini's `NO_BROWSER` flow), an **Open terminal** button, and a **Refresh status** action that re-runs the existing runtime-local credential probe. The card probes once on mount, so a target that is already signed in — an existing sandbox or a self-owned computer — resolves to ready without a click. Docs cover the option in model providers, the self-owned computer FAQ, and choose-a-runtime, in both languages.

## 0.49.1

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
