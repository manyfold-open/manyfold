---
'@manyfold/web': minor
---

On a `regional` consent build, Account settings now describe Google Analytics
the way the banner does for a visitor outside the opt-in region: it sets
`_ga` cookies and runs unless they turn it off. The settings used to say it
only runs with consent, while the toggle beside that text already showed it
running.
