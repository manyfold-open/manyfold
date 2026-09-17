---
"@manyfold/web": patch
---

Explicitly limit consented Google Analytics cookies to 400 days, renewing with consented activity, and document the difference from first-party attribution storage. Analytics remains opt-in: no Google tag loads before acceptance, withdrawal stops events and clears accessible cookies, and SPA pageviews stay application-owned and sanitized. This corrects the earlier release note describing the original consent-less integration; that historical entry does not describe the current behavior.
