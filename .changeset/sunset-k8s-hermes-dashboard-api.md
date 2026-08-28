---
'@manyfold/api': minor
---

The legacy k8s hermes dashboard host is removed. The dashboard toggle and the control-UI URL mint now reject k8s runtimes (sprite dashboards are unchanged), and the cookie-auth endpoints that served the `-dashboard` ingress (`POST /agent-runtimes/dashboard-ticket`, `GET /agent-runtimes/:id/dashboard-auth-check`) are gone, together with the `MF_AUTH_URL` / `MF_DASHBOARD_COOKIE_DOMAIN` / `MF_DASHBOARD_SIGNIN_URL` configuration (no reader is left; set values are inert). Measured on prod and staging [2026-08-28]: zero k8s runtimes had the dashboard enabled.
