# Admin Design System

A design reference for `apps/admin` — the Manyfold SaaS management backend. The aesthetic is anchored on the **Stripe Dashboard** (dense data, brand-consistent purple/navy), **not** the Stripe marketing site. Tokens are defined in `apps/admin/tailwind.config.ts`; primitives live in `apps/admin/src/ui/`.

## 1. Visual Theme

This is a backend for operators: cluster admins, account managers, support engineers. Every screen is a list, a table, a stat tile, or a settings form. The product earns its keep by showing more data per pixel than its peers, while staying scannable.

Three principles drive the system:

1. **Density first.** Default to compact rows (`py-1.5`), compact panels (`p-2`), 13px caption text in tables, and inline status badges. Use breathing room only where the content demands it (empty states, login/protected-route shells, or multi-line operational copy).
2. **Chrome serves data.** Headings, padding, and dividers exist to frame the data, not decorate the page. No hero sections, no gradients, no marketing flourishes.
3. **Brand quietly present.** The Stripe-inspired purple (`#533afd`) is reserved for affordances (links, primary CTAs, active nav). Surfaces stay white; text stays deep navy. The brand reads through restraint, not ornament.

## 2. Color Palette

All tokens are exported by `tailwind.config.ts`. Use the Tailwind class form — never hardcoded hex.

### Foreground & surface (the workhorse set)

| Token          | Hex       | Tailwind                  | Use                                     |
| -------------- | --------- | ------------------------- | --------------------------------------- |
| Heading        | `#061b31` | `text-heading`            | Page titles, table cells, primary copy  |
| Label          | `#273951` | `text-label`              | Form labels, secondary headings         |
| Body           | `#64748d` | `text-body`               | Subtitles, captions, helper text        |
| Surface        | `#ffffff` | `bg-white` / `bg-surface` | Page and card background                |
| Surface subtle | `#fafbfc` | `bg-surface-subtle`       | Table-header rows, zebra accents        |
| Surface muted  | `#f6f9fc` | `bg-surface-muted`        | Hover backgrounds on nav, neutral fills |
| Border         | `#e5edf5` | `border-border`           | Card borders, table dividers            |

### Brand (interactive)

| Token        | Hex                    | Tailwind                  | Use                               |
| ------------ | ---------------------- | ------------------------- | --------------------------------- |
| Brand        | `#533afd`              | `bg-brand` / `text-brand` | Primary CTA, links, active nav    |
| Brand hover  | `#4434d4`              | `hover:bg-brand-hover`    | Primary CTA hover                 |
| Brand subtle | `rgba(83,58,253,0.05)` | `bg-brand-subtle`         | Active nav background, soft hover |
| Brand light  | `#b9b9f9`              | `border-brand-light`      | Ghost-button border               |
| Brand soft   | `#d6d9fc`              | `border-brand-soft`       | Subtle interactive border         |

### Status

| Token               | Tailwind                                                     | Use                                      |
| ------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| Success             | `bg-success-bg` `text-success-text` `border-success-ring`    | Healthy clusters, success badges         |
| Error / destructive | `text-accent-ruby` with `/5`, `/10`, `/30` opacity utilities | Error banners, error badges, error focus |
| Warning             | `text-accent-lemon` with `/10`, `/30` opacity                | Warning badges                           |

### Decorative (reserved)

`accent.ruby` (`#ea2261`), `accent.magenta` (`#f96bee`), `accent.lemon` (`#9b6829`) and the `brand.dark` / `brand.darkest` indigos are **decorative-only** — kept in the token set for future marketing or onboarding surfaces. They should not appear in admin chrome (no gradient hero panels, no dark brand sections, no warm-tone CTAs).

## 3. Typography

Body font is **Inter** (with `SF Pro Display` fallback); monospace is **Source Code Pro**. The `Heading` primitive uses `font-medium` (weight 500) so page and table titles stay crisp at compact sizes. Body copy, controls, and table cells default to `font-normal` (weight 400). There is no weight 600/700 in the admin app.

### Scale

The utility scale below mirrors `tailwind.config.ts` exactly. Sizes `display-lg` (56px) and `display` (48px) exist for cross-app consistency but are **not used in admin**. The `Heading` primitive is intentionally tighter than these marketing-scale tokens: level 2 page titles render at 18px, level 3 card titles at 15px, and level 4 compact table/subsection titles at 14px.

| Class             | Size | Line height | Tracking | Use                                                      |
| ----------------- | ---- | ----------- | -------- | -------------------------------------------------------- |
| `text-display-lg` | 56px | 1.03        | -0.025em | reserved (not admin)                                     |
| `text-display`    | 48px | 1.15        | -0.02em  | reserved (not admin)                                     |
| `text-h1`         | 24px | 1.16        | —        | Reserved large title token                               |
| `text-h2`         | 20px | 1.2         | —        | Reserved large section token                             |
| `text-h3`         | 18px | 1.25        | —        | Stat-tile values, not table titles                       |
| `text-body-lg`    | 16px | 1.35        | —        | High-emphasis body text                                  |
| `text-body`       | 14px | 1.4         | —        | Form fields, button labels, generic copy                 |
| `text-caption`    | 13px | 1.4         | —        | **Default table cell text**, secondary labels, nav items |
| `text-caption-sm` | 12px | 1.33        | —        | Table headers (uppercase), metadata, badge text          |

### Weight policy

- **Page and section titles** (`Heading` levels 1–4): weight 500. Use the `Heading` primitive so page titles and table titles share the same compact hierarchy.
- **Body, table cells, form fields, buttons, nav, badges**: weight 400 (`font-normal`). At 13–16px, weight 300 reads thin and hurts scannability.
- **Stat-tile values** (the only exception): weight 300 at `text-h3` — visually quiet so the number reads as the figure, not as a headline.

### Numeric & technical text

- **Tabular numerals**: every numeric column in a table, every stat-tile value, and every cost/token/count display gets the `tnum` utility (defined globally; pair with `text-right` for table cells).
- **Monospace**: use `font-mono` for IDs, framework slugs, runtime kinds, emails-as-identifiers, and any technical label where character alignment helps (the Dashboard top-agents table is the canonical example).

## 4. Components

All primitives live in `apps/admin/src/ui/`. Prefer them over ad-hoc class strings.

### Buttons (`Button.tsx`, `ButtonLink`)

Variants: `primary`, `ghost`, `info`, `neutral`. Sizes: `md` (`h-8 px-2.5 text-caption`, default) and `sm` (`h-7 px-2.5 text-caption-sm`). Focus-visible always shows a 2px brand ring.

- `primary`: `bg-brand text-white hover:bg-brand-hover`. Single primary CTA per view.
- `ghost`: transparent, `text-brand`, `border-brand-light`, hover `bg-brand-subtle`. Secondary action.
- `info`: muted blue outline. Tertiary / informational links shaped like buttons.
- `neutral`: transparent, muted text, neutral border. Disabled-feeling actions, inline cancels.

There is no `destructive` variant — use `ghost` with confirmation copy, or compose error styling at the call site.

### Cards (`Card.tsx`, `CardBody`)

Elevations map directly to `boxShadow` tokens:

| `elevation` | Shadow token      | Use                                                 |
| ----------- | ----------------- | --------------------------------------------------- |
| `flat`      | none              | Inline error panels, stat tiles inside another card |
| `ambient`   | `shadow-ambient`  | **Default for content panels and tables**           |
| `card`      | `shadow-card`     | Stand-alone cards in lists                          |
| `elevated`  | `shadow-elevated` | Featured/hover-emphasized cards, popovers           |
| `deep`      | `shadow-deep`     | Modals, floating dialogs                            |

`CardBody` defaults to `p-2` (8px). Use `p-0` for sectioned panels where headers/rows provide their own padding. Section headers and footers should use `px-2 py-1.5`; dense detail rows should use `px-2 py-1`. Tables typically wrap a `Card elevation='ambient' className='overflow-hidden'` with **no** `CardBody` (the table provides its own padding).

### Badges (`Badge.tsx`)

Inline-only. Always live inside a table cell, never as a standalone block-level status. 10px text, weight 300, tracking-wide, `px-1.5 py-0.5`, 4px radius.

Tones: `success` (healthy), `error` (failed/degraded), `warning` (attention), `neutral` (unknown/idle), `brand` (active/featured).

### Inputs (`Input.tsx`)

`h-8`, `border-border`, 13px text, 13px label (`text-caption text-label font-normal`). Focus shifts the border to `border-brand` and adds a 1px brand ring. Errors swap border/ring to `accent-ruby` and surface a 12px message under the field.

### Tables (compact by default)

Tables are the most important admin component. Use the same class strings everywhere:

```tsx
<Card elevation='ambient' className='overflow-hidden'>
    <table className='admin-table'>
        <thead>
            <tr>
                <th>Name</th>
                <th className='text-right'>Cost</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td className='font-mono'>{id}</td>
                <td className='tnum text-right'>{cost}</td>
            </tr>
        </tbody>
    </table>
</Card>
```

Rules:

- Apply `admin-table` to every data table. It enforces the compact SaaS backend density (`text-caption`, `px-2.5 py-1.5`, row dividers, subtle hover) even when a legacy page still has wider cell utility classes.
- Header row: `text-caption-sm`, uppercase, `tracking-wider`, weight `font-normal`. Optional `bg-surface-subtle` for a tinted header band on dense list pages.
- Cell padding: `admin-table` enforces `px-2.5 py-1.5`. Use wider padding only for non-table settings/forms, not list data.
- Cell text: `text-caption text-heading`.
- Numeric columns: `tnum text-right`.
- Identifier columns (IDs, emails-as-identifiers, framework slugs): `font-mono`.
- Inline links inside cells: `text-brand hover:text-brand-hover`.
- Row dividers: `divide-border divide-y` on `<tbody>`.
- Action cells: right-aligned `Button size='sm'` group; column header is empty.

For overflow on narrow viewports, wrap the `<table>` in `<div className='overflow-x-auto'>` (the Dashboard top-agents table does this).

### Sidebar nav (`AppLayout.tsx`)

At `sm` and above, the left rail is collapsible. Expanded width is `w-52` (208px); collapsed width is `w-14` (56px). The rail stays white with a `border-border` right edge and has its own vertical scroll area. Below `sm`, the persistent rail is replaced by a modal navigation drawer opened from the sticky header.

Navigation is organized by operator task rather than by URL prefix:

- Dashboard is the only standalone destination.
- The five accordion groups are Operations, Infrastructure, Users & billing, Catalogs, and Platform settings.
- At most one group is expanded. Navigating to a page automatically opens its owning group.
- Expanded group headers use icon + label + chevron. Child destinations are indented text rows without icons.
- The collapsed rail shows only Dashboard and the five group icons. Selecting a group icon expands the rail and opens that group.
- The active child uses `bg-brand-subtle text-brand`; its group header uses `text-brand`. In the collapsed rail, the active group icon uses `bg-brand-subtle text-brand`.
- Group buttons expose `aria-expanded` and localized accessible names. Truncated child labels retain their full value in `title`.
- The mobile drawer uses the expanded hierarchy, 44px navigation rows, a native modal focus boundary, and a dimmed backdrop. It closes from the header button, backdrop, Escape key, viewport resize past `sm`, or successful navigation.

Related admin views share one sidebar destination and use URL-backed page tabs. Tabs are compact link rows with a bottom border, remain horizontally scrollable on narrow screens, and expose the active destination with `aria-current='page'`. Detail and CRUD routes stay independent even when their list views are consolidated.

### Breadcrumbs (`Breadcrumbs.tsx`)

Every detail page starts with `<Breadcrumbs />` instead of a back-link. The component defaults to `mb-2`, uses `text-caption-sm`, and separates crumbs with a 14px `ChevronRight`. The first crumb links back to the owning list page; the final crumb is the current entity name, slug, email, or ID fallback.

### Empty / loading / error states

- **Loading**: a single line of `text-caption text-body` ("Loading…"). No spinners on list pages — the data populates fast enough that a spinner is more distracting than absent text.
- **Empty**: dashed-border placeholder card with center-aligned copy and a primary CTA (`border-border-dashed rounded-lg border border-dashed bg-white p-4 text-center`).
- **Error**: `Card elevation='flat'` with `border-accent-ruby/30 bg-accent-ruby/5 p-2` and a `text-caption-sm text-accent-ruby` `<pre>` body. Place above the data area, not below.

## 5. Layout

### Frame

Defined in `apps/admin/src/components/AppLayout.tsx`:

- Desktop sidebar: sticky `h-screen`, `w-52`, white, `border-r border-border`, `px-3 py-4`; collapsed rail is `w-14 px-2`. Only the navigation region scrolls vertically.
- Mobile sidebar: native modal dialog, `h-dvh`, width `calc(100vw - 3rem)` capped at `w-72`, with a dismissible backdrop.
- Header: sticky, `h-12`, `border-b border-border`, `bg-white/95 backdrop-blur`; mobile navigation trigger on the left and user controls on the right.
- Main: `flex-1 overflow-auto p-4 lg:p-5 xl:p-6`.

### Page container

Use full available width for list and detail pages:

- `mx-auto max-w-none`: dashboards, list pages, and operational detail pages.
- `mx-auto max-w-3xl`: forms where line length would otherwise get too wide.

Detail pages start with `<Breadcrumbs />`, which defaults to `mb-2`, then the compact page header/data surface. List page headers are one heading + one subtitle line:

```tsx
<div className='mb-3 flex items-start justify-between gap-2'>
    <div>
        <Heading level={2} className='mb-2'>
            {title}
        </Heading>
        <p className='admin-page-description max-w-2xl'>{subtitle}</p>
    </div>
    <ButtonLink variant='primary' to={newPath}>
        New
    </ButtonLink>
</div>
```

### Route topology

Admin URLs follow the sidebar's operator-task hierarchy. Canonical paths are declared in `src/routes.ts`; components must link through those helpers instead of duplicating path strings.

| Area | Canonical paths |
| --- | --- |
| Operations | `/agents`, `/runtimes`, `/sandboxes`, `/channels`, `/model-providers` |
| Infrastructure | `/infrastructure/clusters`, `/infrastructure/sandbox-accounts`, `/infrastructure/self-owned-computers/*`, `/infrastructure/container-skus`, `/infrastructure/sandbox-capacity` |
| Users & billing | `/accounts/users`, `/accounts/waitlist`, `/billing/subscriptions`, `/billing/invoices`, `/billing/payments` |
| Catalogs | `/catalog/frameworks/*`, `/catalog/skills/*`, `/catalog/mcp/*` |
| Platform settings | `/platform/authentication`, `/platform/email`, `/platform/notification-webhooks`, `/platform/turn-policies`, `/platform/rollouts/*` |

- A resource's list, new, and detail pages share one path hierarchy; for example `/accounts/users/:id` and `/catalog/mcp/catalog/:id`.
- Consolidated page tabs use path segments, not `?view=` or `?tab=`, so every visible page has a stable, descriptive URL.
- `/settings/*`, `/agent-runtimes/*`, and other retired paths exist only as compatibility redirects in `App.tsx`. New links must never target them.
- A relative link in admin must resolve to an admin route. Cross-app destinations require an explicit external URL; do not assume a user-workspace `/settings/*` route exists on the admin host.

### Spacing

Base unit 8px. Common values from the Tailwind scale:

- Inline gaps: `gap-1` (4px) for nav items, `gap-2` (8px) for inline button groups, `gap-3` (12px) for stat-card grids.
- Section gaps: `mb-3` (12px) for page headers and major list sections, `mb-2` / `space-y-2` for stacked cards or tabs inside a detail page.
- Card interior: `p-2` by default. Sectioned detail panels use `p-0` with `px-2 py-1.5` headers/footers and `px-2 py-1` dense detail rows. Tables use no container padding (cells own it).
- Empty-state panels may use `p-4`; they need more room than data panels so the CTA does not feel cramped.

### Border radius

| Class        | Value | Use                                           |
| ------------ | ----- | --------------------------------------------- |
| `rounded`    | 4px   | Buttons, inputs, badges, table cells, default |
| `rounded-md` | 5px   | Standard cards                                |
| `rounded-lg` | 6px   | Panels, nav containers                        |
| `rounded-xl` | 8px   | Modals, featured cards                        |

Never use pill shapes (`rounded-full`) on cards or buttons. Avatars and status dots are the only legitimate use.

## 6. Depth & Elevation

Four levels in admin (drop the marketing "decorative depth" tier):

| Level                        | Token                             | Use                                            |
| ---------------------------- | --------------------------------- | ---------------------------------------------- |
| Flat                         | none                              | Page background, inline error panels           |
| Ambient (`shadow-ambient`)   | `rgba(23,23,23,0.06) 0px 3px 6px` | Default for content panels, tables, stat tiles |
| Elevated (`shadow-elevated`) | blue-tinted multi-layer           | Popovers, dropdowns, hover-emphasized cards    |
| Deep (`shadow-deep`)         | deeper blue-tinted                | Modals, floating dialogs                       |

Shadows keep their blue tint (`rgba(50,50,93,...)`) — this ties elevation to the brand palette and is already wired into `tailwind.config.ts`. Keyboard focus uses `shadow-focus-brand` (a 2px brand ring) on inputs, and `focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2` on buttons.

## 7. Do's and Don'ts

### Do

- Use `text-caption` (13px) as the default for table cells and dense lists.
- Use `tnum` on every numeric column or stat value.
- Use `font-mono` for IDs, emails-as-identifiers, framework slugs.
- Put status as an inline `Badge` inside a table cell, not as a standalone block.
- Start pages at `Heading level={2}` and follow with a single `text-body` subtitle line.
- Start detail pages with `<Breadcrumbs />`, not a hand-written back link.
- Default cards to `elevation='ambient'`.
- Reach for the `Button`, `Card`, `Badge`, `Input`, `Heading` primitives before writing class strings by hand.

### Don't

- Don't use `text-display` / `text-display-lg` in admin — they're reserved for cross-app surfaces.
- Don't apply `font-light` to page titles, table titles, body, table cells, form fields, or buttons. Weight 300 at 13–16px reads thin.
- Don't add hero sections, gradient panels, or dark brand sections. They don't belong in admin chrome.
- Don't use `accent.ruby` or `accent.magenta` for actionable elements — ruby is for error states only; magenta is decorative-only.
- Don't pad table rows past `py-1.5` without a content reason (multi-line cells).
- Don't add local `p-4` to regular data cards. Use the primitive default `p-2`, or `p-0` for sectioned panels.
- Don't use pill shapes or radii above 8px on cards or buttons.
- Don't introduce a new shadow token — pick one of the four levels.

## 8. Responsive Behavior

| Breakpoint | Width         | Behavior                                                                                                                                                             |
| ---------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile     | `<sm` (640px) | Persistent sidebar is hidden. A header button opens the modal navigation drawer. Stat-card grid stacks to 2 cols. Tables horizontal-scroll inside `overflow-x-auto`. |
| Tablet     | `sm` to `lg`  | Sidebar also initializes collapsed through 900px unless the user has saved a preference. 2-col grids, tables visible without scroll for ≤4 columns.                  |
| Desktop    | `≥lg`         | Full layout, sidebar + main, tables natural width.                                                                                                                   |

- Stat-card grid: `grid grid-cols-2 sm:grid-cols-4 gap-3`.
- Tables that exceed viewport width: wrap in `<div className='overflow-x-auto'>` rather than collapsing columns. Operators expect the same columns at every size.
- Touch targets: mobile drawer rows are 44px (`h-11`). Other primary controls and inputs are 32px tall (`h-8`). Dense inline table/actions may use `Button size='sm'` (`h-7`) only when surrounded by compact data rows.

## 9. Agent Prompt Guide

When prompting an LLM (or yourself) for new admin UI, anchor every request to these tokens.

### Quick reference

- Page background: `bg-white`
- Page heading: `<Heading level={2}>` (renders as 18px weight 500, `text-heading`)
- Page subtitle: `admin-page-description`
- Primary CTA: `<Button variant='primary'>` or `<ButtonLink variant='primary'>`
- Cards: `<Card elevation='ambient'>` with compact `<CardBody>` (`p-2`) for padded content, or no body for tables
- Status: `<Badge tone='success' | 'error' | 'warning' | 'neutral' | 'brand'>` inside a cell
- Numeric data: `tnum` + `text-right`
- Identifiers: `font-mono`

### Example prompts

- "Create a list page wrapped in `mx-auto max-w-none`. Page header: a flex row with `<Heading level={2}>` + `text-body` subtitle on the left and a `<ButtonLink variant='primary'>` on the right. Below: a `<Card elevation='ambient' className='overflow-hidden'>` containing `<table className='admin-table'>`. Let `admin-table` own header/body typography and padding; add only alignment (`text-right`), `tnum`, `font-mono`, or truncation classes at the cell level."
- "Create a stat tile: `<Card elevation='ambient'><CardBody>`. Label `text-caption-sm text-body font-normal`. Value `text-h3 text-heading tnum mt-1 font-light`. Optional sub-line `text-caption-sm text-body mt-1`. Keep the tile compact; do not add local `p-4` unless the metric has multi-line supporting text."
- "Create an inline status badge: `<Badge tone='success'>healthy</Badge>` for ok, `tone='error'` for failed, `tone='neutral'` for unknown. Render inside a table cell, never standalone."
- "Create a settings form: vertical stack with `space-y-2`. Each field is `<Input id=... label=... hint=...>` (label `text-caption text-label`, input `h-8 text-caption`, hint `text-caption-sm text-body`). Submit row at the bottom with `<Button variant='primary'>` and a secondary `<Button variant='ghost'>`."
- "Create an error banner above the data area: `<Card elevation='flat' className='border-accent-ruby/30 bg-accent-ruby/5 p-2'>` containing `<pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>`."

### Iteration checklist

1. Did you start at `Heading level={2}`, not `level={1}` or `display`?
2. Are tables using `admin-table` without local font-size overrides?
3. Is every numeric column `tnum text-right`?
4. Is every identifier column `font-mono`?
5. Is status an inline `Badge`, not a standalone block?
6. Does the card use `elevation='ambient'` (the admin default) and compact body padding (`p-2`)?
7. Do detail pages start with `<Breadcrumbs />` rather than a custom back link?
8. Did you reuse a primitive from `src/ui/` instead of writing class strings?