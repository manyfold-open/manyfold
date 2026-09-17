---
"@manyfold/web": patch
---

Explicitly limit consented Google Analytics cookies to 400 days, renewing with consented activity, and document the difference from first-party attribution storage. Analytics remains opt-in: no Google tag loads before acceptance, withdrawal stops events and clears accessible cookies, and SPA pageviews stay application-owned and sanitized. This corrects the earlier release note describing the original consent-less integration; that historical entry does not describe the current behavior.

Improve the contrast of small landing-page labels, example records, status text and footer copy using the existing design tokens.

Keep font subsets out of the initial stylesheet and load the NetMind sign-in form only when its dialog opens. Web loads non-English catalogs on demand while preserving one shared translation runtime, URL-pinned marketing language, and correctly localized analytics titles.

Restore the landing's two-step CTA layout and mutually exclusive desktop/mobile step labels. A failed sign-in chunk keeps the dialog closable and offers an explicit page reload to clear the browser's failed-module cache.

Prioritize the static marketing body's styles and fonts ahead of its SPA enhancement without lowering the product shell's entry priority.

Cancel a marketing page's pending language selection when leaving its URL, so a late catalog cannot override browser navigation or a newer product language choice.
