# @manyfold/admin

## 0.27.5

### Patch Changes

- [#55](https://github.com/manyfold-open/manyfold/pull/55) [`d01d06b`](https://github.com/manyfold-open/manyfold/commit/d01d06b3454d99a0a5d156535fc50b0c1c0df400) Thanks [@yingca1](https://github.com/yingca1)! - Self-hosted accounts created before the deployment set `MF_DEFAULT_PLAN_ID`
  no longer keep cloud `free` limits forever. That variable only ever applied to
  the `users` INSERT, so an account created by an older self-host stack landed
  on `free` and nothing — not upgrades, not migrations, not logging back in —
  ever moved it. The symptom was a quota error naming a plan the operator never
  chose, such as `External API limit reached (3 for Free plan)` when adding a
  fourth Dify / Langflow / A2A agent. On the first start after upgrading, a
  deployment with no billing module and `MF_DEFAULT_PLAN_ID` set to something
  other than `free` moves every remaining `free` account to that plan. It runs
  once, claims its marker in the same transaction as the update, and records the
  move in the audit log — so a later deliberate assignment is never overwritten,
  and a cloud deployment is never touched.

    The admin console gains a **Plan** card on user detail, backed by
    `GET /admin/plans` and `PATCH /admin/users/:id/plan`. Until now the
    open-source composition root had no way to change a user's plan at all, since
    plan changes lived only in the cloud billing module; recovery meant editing
    the database by hand. The route refuses on deployments where billing owns the
    assignment, so a subscription can't be silently desynced from what a user pays
    for.

    `MF_SELFHOST_DEFAULT_PLAN_ID` now overrides the compose stack's default tier
    for new accounts, and self-hosting docs cover how to read and change a user's
    plan.
