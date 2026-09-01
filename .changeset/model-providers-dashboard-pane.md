---
'@manyfold/web': patch
---

Clicking the **Model providers** rail title while a provider is open now actually returns to the dashboard. The route changed to `/settings/model-providers/dashboard`, but the pane kept rendering the provider that was already open and the title never took its own active state: the effect that syncs the selection from the URL returned early on the dashboard segment, so it never cleared the previous pick. The early return was guarding against an auto-select fallback that no longer exists — the branch it skipped had since become the one that clears.

The rule now lives in `pages/Settings/modelProviderSelection`, alongside the selection helpers it uses: the dashboard segment resolves to no selection and outranks a lingering `?selected=` param, which is what lets the pane switch back and keeps the rail from lighting up a provider beside the dashboard.
