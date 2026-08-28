# @manyfold/web

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
