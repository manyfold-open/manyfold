---
'@manyfold/web': patch
---

Self-hosted builds no longer offer billing controls that only redirect.

Billing — plans, pricing, container purchase — is a cloud surface: the
open-source API has no billing routes, and every page under
`/settings/plan-and-billing` is a stub that navigates back to `/settings`. Six
places linked into it anyway, so a self-hosted user could reach a control that
bounced them straight back:

- the **Plan & billing** entry in the settings sidebar
- **View plans** on the quota-limit dialog
- **Upgrade** in the active-hours warning on the concurrency popover
- **Rent a persistent container** in all three agent-create surfaces

All six now check one build-time capability. On a self-hosted build the sidebar
shows seven entries, the quota dialog offers only Close, the active-hours
warning still appears without a call to action, and agent create no longer
advertises a purchase flow that does not exist there. The cloud build is
unchanged.

Two related corrections. The **Sandbox usage** page is reachable from the
runtimes dashboard in both editions, but its breadcrumb always named Plan &
billing as the parent; on a self-hosted build it now names Runtimes, which is
where the page is actually reached from. And agent create's persistent-runtime
option is no longer disabled behind a rent link on self-hosted installs, where
containers are provisioned on the fly rather than purchased — it is selectable,
as it always should have been.
