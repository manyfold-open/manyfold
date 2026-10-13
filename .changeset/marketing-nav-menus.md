---
'@manyfold/web': minor
---

The marketing site's nav groups its pages into menus. The bar reads Product · Pricing · Docs, with Product opening a panel of Channels and Self-host, each with a line saying what it is; a composition can lead that menu with its own pages and add whole groups after it through the new `editionNavMenus` slot, which also lets it add one footer column. On phones the folded menu opens the same groups in place, one at a time, and puts the GitHub, X, Discord, language and theme controls in a single row instead of five, so the whole menu fits well inside the first screen; the Sign in row gets an icon so its label lines up with the rest. The Challenge entries leave the nav and the footer, and with them the `ChallengeNavLink` slot; the `CloudNavLink` slot keeps only its footer and landing-tour entrances. `/apps` is routed as a new editions slot page that redirects home here.
