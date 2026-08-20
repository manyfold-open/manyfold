# What

<!-- One paragraph: the behavior change and why. -->

## Feature placement

<!-- One line (see CONTRIBUTING.md): useful to everyone self-hosting, with no
proprietary dependency? If it belongs to a hosted edition, this PR should at
most add a neutral seam (port / slot / registry entry). -->

## Contract surfaces

<!-- Delete if untouched. If this PR changes a port interface, a
composition-root seam, the capabilities contract, or a @manyfold/* package
export, call out the breaking change and its downstream impact here. -->

## Checklist

- [ ] `pnpm check && pnpm lint && pnpm knip` pass locally
- [ ] Tests cover the intent of the change (and fail without it)
- [ ] Changeset added for any user-visible change (`pnpm changeset`)
- [ ] Migrations (if any) touch only core-owned tables
