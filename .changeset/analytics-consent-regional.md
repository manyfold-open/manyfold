---
'@manyfold/web': minor
'@manyfold/i18n': patch
---

Analytics consent gains a build-time posture, `VITE_ANALYTICS_CONSENT_MODE`. The default, `opt-in`, is unchanged: nothing Google-bound loads until the visitor accepts. `regional` keeps opt-in for visitors whose browser time zone places them in Europe or an EEA Atlantic zone, and elsewhere treats an undecided visitor as consenting until they decline — the banner still appears, with a message that says analytics runs unless turned off, and Decline works as before. Account settings show implied consent as "on" so the toggle turns it off.
