---
'@manyfold/api': minor
---

Automations run at the time of day their schedule names in their own timezone, whatever timezone the server runs in. On a server not set to UTC (a self-hosted install with `TZ` set, or a local stack), every run was off by the server's own UTC offset: a daily 09:00 in Asia/Shanghai ran at 17:00 on a server set to Asia/Shanghai, and every "next run" read the same. Around a daylight-saving change the schedule now follows RFC 5545: a time the clocks skip runs on the offset before the change (a 01:30 in London runs at 02:30 on the March change day, where it ran an hour early), and a time they repeat runs once, at its first showing. A next run already set keeps its time; the ones after it follow this.
