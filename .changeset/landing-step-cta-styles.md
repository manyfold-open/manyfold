---
'@manyfold/web': patch
---

Restore the landing hero's gated two-step CTA styling. The landing rebuild dropped the `.lp-step-cta*` rules from `styles.css` but kept the markup, so with no rules to hide either variant both the full "Step 1" badge and its phone-only "1" counterpart rendered at once and the buttons read "Step 11Request access" / "Step 22Sign in". The badges, the connector arrow and the mobile swap are back; the badge is now sentence case at normal tracking, per the landing type rules adopted since. Only surfaces that enable the signup gate render these buttons, which is why the breakage went unseen.

A new `landingClassContract` test now fails on any `lp-` class the markup asks for that no rule defines, so the next removal is caught in CI rather than on the page. It also cleared four class names that never had a rule at all (`lp-step-cta-label`, `lp-usage-mark`, `lp-price-feat-star`, `lp-nav-more-root`).
