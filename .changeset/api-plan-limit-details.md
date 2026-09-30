---
'@manyfold/api': minor
---

Every plan limit or quota refusal (`CHANNEL_LIMIT_REACHED`, `AUTOMATION_LIMIT_REACHED`, `AUTOMATION_RUN_QUOTA_REACHED`, `ACTIVE_HOURS_QUOTA_REACHED`, `STORAGE_LIMIT_REACHED`, `CONCURRENT_ACTIVE_LIMIT_REACHED`, the always-online limits and `API_REQUEST_QUOTA_REACHED`) now carries `details` with `current`, `limit` and `planName` (and `resetAt` or `kind` where they apply), as `RUNTIME_LIMIT_REACHED` already did. Before, the numbers never reached a client, because the error envelope forwards only `details`.
