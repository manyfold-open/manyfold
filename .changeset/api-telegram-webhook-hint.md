---
'@manyfold/api': minor
---

A Telegram channel test or registration that fails now mentions `PUBLIC_API_BASE_URL` only when Telegram refused the webhook URL. A missing or rejected bot token is reported on its own, without the misleading hint about a public HTTPS URL.
