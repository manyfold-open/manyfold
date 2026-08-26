# @manyfold/web

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
