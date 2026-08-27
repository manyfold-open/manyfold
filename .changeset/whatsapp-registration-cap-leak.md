---
'@manyfold/api': patch
---

A WhatsApp registration whose pairing socket cannot be opened now fails
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
