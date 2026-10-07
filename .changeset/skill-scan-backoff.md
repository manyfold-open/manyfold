---
'@manyfold/api': minor
---

A skill repository whose catalog scan fails is not scanned again until a backoff ends, and every API instance honours it. The wait is at least a minute and doubles while failures continue, up to an hour; when GitHub rate-limits the scan, it also lasts at least until its `Retry-After` or, with no requests left, its `x-ratelimit-reset`. Before, a failed scan left nothing behind, so each catalog page view started the same scan again: during one rate-limit window, 18 scans in three and a half minutes spent over 2,000 GitHub requests. Inside the backoff the catalog still lists the skills from the last good scan. A skill install or catalog refresh that needs the repository answers 503 `github_source_unavailable` with a `Retry-After` header, instead of sending a request GitHub would refuse. A skill import that fails at GitHub, or while saving, now logs its stage and failure classification.
