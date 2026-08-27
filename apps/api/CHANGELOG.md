# @manyfold/api

## 0.53.1

### Patch Changes

- [#48](https://github.com/manyfold-open/manyfold/pull/48) [`c491d19`](https://github.com/manyfold-open/manyfold/commit/c491d1996c03a3f69d8c14337ca701023cb2257d) Thanks [@yingca1](https://github.com/yingca1)! - A WhatsApp registration whose pairing socket cannot be opened now fails
  instead of sitting in the pending state forever. Nothing polls a registration
  whose start threw and the sweeper only removes rows an hour past expiry, so
  each failed attempt used to hold one of the three per-user slots for its full
  eight-minute lifetime — the fourth attempt then reported "too many pending
  registrations", which named the wrong problem entirely. Start now answers with
  a 502 `whatsapp_registration_unavailable`, and a socket that cannot be
  reopened during a QR refresh fails its row the same way.

    The per-user cap also counts only registrations that are genuinely live.
    Cancelled, failed and expired attempts stopped holding capacity the moment
    they settled, for both WhatsApp and WeChat. And a Baileys import that fails is
    retried on the next attempt rather than being remembered, so one bad load no
    longer answers every request for the life of the process.

## 0.53.0

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

### Patch Changes

- [#23](https://github.com/manyfold-open/manyfold/pull/23) [`2e6fc28`](https://github.com/manyfold-open/manyfold/commit/2e6fc28a34c51d511be3358673bcbcf165488be1) Thanks [@yingca1](https://github.com/yingca1)! - The edition release (`v*`) no longer carries mf CLI binaries. The CLI has its
  own release train (`cli-v*`), so a CLI fix no longer waits for an edition
  release, and the edition tag no longer implies a CLI version it never matched.

    Install the CLI with `curl -fsSL https://manyfold.ai/cli/install.sh | sh`, or
    pick a build from the `cli-v*` releases. Nothing needs to change for existing
    installs: the installer resolves a channel manifest, not `releases/latest`.

## 0.52.0

### Minor Changes

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
