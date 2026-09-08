---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/cli': patch
---

Add an iMessage channel provider

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
