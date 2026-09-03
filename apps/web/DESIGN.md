# Design System for `@manyfold/web`

This document is the source of truth for the visual and interaction language of `@manyfold/web` — and of `@manyfold/docs`, which is the same register at a different surface tier. It describes the **design intent** (the why) and the **implementation reference** (the how). Token values live in `src/styles.css` and `tailwind.config.ts`; this document explains what each token means and when to use it.

The landing page (`.landing-root`, `.lp-*`) is a separate register with its own spec, [`DESIGN.landing.md`](./DESIGN.landing.md). The two share one brand — the same Ash neutral curve, the same Iris ramp. They differ in **density** — landing is sculptural and read once; the product is a workbench read for hours — and that is where radius, type scale and shadow weight are allowed to diverge. Nothing in this document applies inside `.landing-root`.

Three commitments, one line each:

- **Colour** — a genuinely neutral ground (Ash) with a single accent (Iris). Paper feel comes from near-white lightness and narrow steps between tiers, never from tinting the ground.
- **Type** — two families with two jobs: Geist for everything, Geist Mono for technical signal. No serif in the product; landing's display face stays on landing.
- **Shape** — flat finish: a solid fill, one 1px hairline ring, an optional quiet drop. Radius runs 8 / 10 / 14 and never above 14 except the chat composer.

The reference moods: Linear / Vercel for the calm of the neutral ground and the single accent; Codex (macOS) for the workbench posture inside chat and settings.

## 2. Product posture

The interface expresses a clear hierarchy:

1. The active workspace / chat is the main stage.
2. Agent identity, session history, and runtime context are supporting context, held by a persistent left rail.
3. Settings, providers, usage, and runtime management are secondary surfaces — same language, lower volume.
4. The landing page is the marketing front door — the same brand at hero scale, specified separately in `DESIGN.landing.md`.

Avoid the IM metaphor. Threads should read closer to documents or task logs than to casual chat bubbles.

### Where the volumes shift

| Surface          | Background tone                                              | Radii used                          | Accent allowed                  | Density         |
| ---------------- | ------------------------------------------------------------ | ----------------------------------- | ------------------------------- | --------------- |
| Workspace home   | `--color-main-bg` Ash neutral                                | Md (14, ceiling), Sm, Xs, Pill      | Neutral / workflow accents only | Compact desktop |
| Chat canvas      | `--color-main-bg` Ash neutral — **near-white working stage** | Md (14), Sm, Xs, Pill + composer 18 | Workflow accents only           | Compact desktop |
| Settings         | `--color-settings-bg` (matches `--color-main-bg`)            | Md, Sm, Pill                        | Neutral                         | Compact desktop |
| Auth / CLI login | `--color-main-bg` Ash neutral                                | Md 14 for the card, Sm 10 inside    | Neutral                         | Form-scale      |

### The workbench surface ramp

Inside the product, the ramp runs from recessed chrome up to the working stage. **Light is the signal for "this is where the work is."**

1. **Persistent rail** (`--color-rail`) — recessed chrome. It holds agent identity, session history, and navigation: things you consult, not things you work in. It steps _down_ from the canvas so it settles behind the content without needing a stripe or border to do the work. `--color-app-bg` sits one notch below it, anchoring the floor.
2. **Chat canvas** (`--color-main-bg`) — the near-white stage, and the brightest large surface in the product. The agent's workspace, the message list, the chat shell. This is the reading surface; it should feel like paper, not like a tray.
3. **Composer, popovers, cards** (`--color-surface`) — a few units above the canvas, plus a 1px ring and a drop shadow. Near white there is no headroom left for fill alone to carry elevation, so **the ring and shadow do that job** and the fill only keeps the surface from looking like a hole. `--color-surface-elevated` is one half-step above for the top-most modal layer.

Content that should read as _recessed_ against the canvas — tool blocks, code, the user's own message — steps down to `--color-surface-subtle`.

Dark mode keeps this **structure** but not its direction. The rail is still the recessed chrome and the canvas is still the stage, but there elevation reads as _brighter_: rail → canvas → surface all step up. Dark mode has no true recession (a fill below the canvas reads as a hole), which is why `--color-surface-subtle` sits just _above_ the canvas in dark and _below_ it in light. **What never flips is which surface is chrome and which is stage** — that is what carries the "one material, three volumes" reading across themes.

**Hover/active fills are tuned per background tier.** A single global hover token can't serve every surface — `--color-rail` (237 light / 15 dark), `--color-surface` (252 / 35), and `--color-surface-elevated` (254 / 45) sit at different absolute lightnesses, so a fixed-value hover reads "too dark" on some and "invisible" on others. The system therefore exposes three hover tokens, each anchored to its background:

| Hover token             | Background it sits on                                                  | Light Δ | Dark Δ | Used by                                                                                             |
| ----------------------- | ---------------------------------------------------------------------- | ------- | ------ | --------------------------------------------------------------------------------------------------- |
| `--color-rail-hover`    | `--color-rail` (sidebar, agent rail, main-bg adjacents)                | -11     | +16    | Agent rail rows, session rows in the sidebar                                                        |
| `--color-surface-hover` | `--color-surface` (composer card, ghost buttons sitting on the canvas) | -16     | +16    | Composer chip hover (permission / model / agent), header icon buttons, ghost icon buttons on a card |
| `--color-soft`          | `--color-surface-elevated` (popover panels, dropdown menus)            | -18     | +16    | Popover/menu item hover (Class **L**); active/selected fill inside a popover                        |

**Light-mode and dark-mode deltas are intentionally asymmetric** — the goal is the same _perceived_ contrast, not the same RGB delta. Because the eye is more sensitive to lightness changes at high luminance (Weber-Fechner), a δ-12 in light mode reads about as strong as δ+22 in dark mode. Earlier attempts to keep the numbers symmetric produced two opposite bugs: a too-loud light-mode rail-hover (δ-20) that dipped below `--color-app-bg` and read as a depression cutting through the chrome, and a too-quiet dark-mode rail-hover (δ+14) that the eye couldn't see at all against near-black.

**Rail-hover specifically: the light-mode value sits between `--color-app-bg` (224) and `--color-rail` (237).** The hovered row dims gently _toward_ the page floor but never below it — a quiet acknowledgement, not a depression. If you find yourself wanting to push it lower, you're treating hover as "selected/pressed" feedback; that's the wrong class — use a real selected state instead.

**Pick the hover token whose background the hovered element actually sits on.** Reaching for `--color-soft` on a `--color-rail` background was the long-standing bug that made sidebar row hovers nearly invisible: soft is 230, rail is 232, so the "hover" was actually 2 RGB units _darker_ than rest. The tokens are now named after their parent background so the right choice is mechanical.

These tokens are not standalone surfaces — never paint a region in `--color-soft` / `--color-surface-hover` / `--color-rail-hover` to substitute for the corresponding background. They exist only as hover/active fills.

**Active fill = hover fill on the same tier.** When a list row has a persistent "selected" state (the open chat session in the sidebar, the highlighted item in a popover), its background uses the _same_ token as its hover state. The user sees: hovering a row reveals the exact tone the currently-selected row already wears — a clear signal that "clicking this row will move the selection here." Introducing a third tone for active (one for rest, one for hover, one for active) fractures the list into three visual states the user has to learn separately. The legacy `--color-active-session` token still exists for backwards compatibility but is aliased to `--color-rail-hover` so the two states stay in lockstep.

**The chat composer floats on the canvas, not on a shelf.** The composer card uses `--color-surface`, but the strip around the composer (`.chat-composer-dock`) is transparent — the chat canvas shows through. Painting a separate tinted band around the input fractures the page into two surfaces and breaks the volume hierarchy. The composer's milled-chassis shadow (§7.2) is what separates it from the canvas, not a background fill.

**There is no display face in the product.** Every rung is Geist, with Geist Mono for technical signal (§5). Landing's serif (`.lp-h*`, Fraunces) is a marketing register and does not cross into the workbench or docs — a page title here is `text-h1` in Geist.

## 3. Implementation contract

**This document is the single source of truth for the visual system.** When code and `DESIGN.md` disagree, the document defines the _intent_; the file the code reads defines the _current shipped value_. Drift between the two is a bug — close it on the same PR that introduces the change, in either direction.

### 3.1 The global-baseline files

These files must stay aligned with `DESIGN.md` at all times. They are the only places token values live; nothing else should hard-code a hex, a radius, a shadow stack, or a font size:

| File                                         | Role                                                                                                                                                                                                          | Aligned with                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `apps/web/DESIGN.md`                         | Source of truth — _this_ document. Defines every token's role, the rules that govern its use, and the do/don't list.                                                                                          | —                              |
| `apps/web/tailwind.config.ts`                | Exposes the styles.css tokens as Tailwind utilities (`bg-surface`, `rounded-md`, `shadow-elevated`, `text-h2`, etc.). The Tailwind theme **never** introduces a value that isn't in styles.css.               | styles.css → DESIGN.md         |
| `apps/web/AGENTS.md`                         | Points AI agents at `DESIGN.md` so any UI work loads the spec.                                                                                                                                                | DESIGN.md                      |
| `apps/docs/src/styles/global.css`            | The docs site has its own bundle, but its color tokens, radius scale, shadow tokens, and typography scale must mirror the webapp's so the brand reads continuously across `manyfold.ai/docs` and the product. | styles.css → DESIGN.md         |
| `apps/docs/tailwind.config.mjs` (if present) | Mirrors `apps/web/tailwind.config.ts` for the docs Astro build.                                                                                                                                               | tailwind.config.ts → DESIGN.md |

### 3.2 The alignment workflow

**Every change to the visual system goes through this checklist — no exceptions.** Whether you're adjusting a color token, retuning a hover, swapping a shadow recipe, or removing a feature like squircle:

1. **Decide where the change lives first.** Is it a token-level change (color, radius, shadow, type)? Then `DESIGN.md` must be touched. Is it a component-class change (`.chat-composer-*`, `.workbench-*`)? Then verify it still composes with the tokens DESIGN.md guarantees.
2. **Audit every global-baseline file in §3.1.** For each file:
    - **Conflict?** Two files disagree about a value (e.g. `--color-soft` is 230 in styles.css but `DESIGN.md` says "between rail and surface" which means ~237). Unify on whichever side is correct in the new world, and update the other.
    - **Missing?** A token, rule, or component exists in code but isn't documented (or vice versa). Add it to the missing side.
3. **Cross-check webapp ↔ docs.** If you change a color, radius, shadow, or type token, propagate to `apps/docs/src/styles/global.css` (and `tailwind.config.mjs` if it exists). The docs site uses the same visual vocabulary at a different surface tier; drift between them shows up as a brand inconsistency between marketing and product. `--shadow-focus` is enforced: `pnpm governance:check` parses both baselines and fails on a recipe that moved on one side only. Nothing else on this list is checked by a machine — the two files diverge on purpose elsewhere (docs runs its neutral shadow tokens a step heavier for its surface tier), so the rest is on you.
4. **Verify both themes.** Light and dark mode are equal citizens. A change that only looks right in one mode is incomplete.
5. **Run typecheck + lint.** `pnpm check` and `pnpm eslint` should pass on every touched file.
6. **Manual visual verification.** Spin up the dev server (`pnpm dev:web`, `pnpm dev:docs`) and confirm the change in a browser. Type-checking does not validate visual correctness.

If a change is "too small" to bother updating `DESIGN.md`, it almost certainly is also too small to bother making — small visual tweaks accumulate into drift faster than any other category of change.

### 3.3 Token-naming rules

- Never introduce ad-hoc hex values. Add a token first (in styles.css + tailwind.config.ts), name its role here, then use it.
- Theme switching is driven by `[data-theme]` on `<html>`. Every surface must be verified in both themes before shipping.
- Tokens in styles.css must match the role described in this document. If the role changes (e.g. `--color-soft` shifts from "between rail and surface" to "just below rail"), update both the styles.css comment **and** every DESIGN.md sentence that references the token. A search for the token name (`--color-soft`, `--color-info`, etc.) across DESIGN.md must return a self-consistent description.

---

## 4. Color system

### 4.1 Principle: neutral ground, one accent

The whole colour budget is spent on one hue — Iris — and **everything else is neutral**: grounds, rings, shadows. Tinting the ground costs two things that cannot be undone: the accent loses contrast against its own light end, and the surface wears a filter that cannot be washed out.

The neutral axis is **Ash**, shared with landing. It carries a cool bias (B a little above R) that cancels the yellow cast of warm displays without any hue becoming readable — and the size of that bias **tracks lightness rather than being constant**:

| Lightness zone           | B − R | Example                                      |
| ------------------------ | ----- | -------------------------------------------- |
| Near white / near black  | 0–3   | `--color-surface-elevated` 0, `--color-fg` 3 |
| Background tiers         | 2–4   | `--color-main-bg` 2, `--color-app-bg` 4      |
| Mid-greys (the ink ramp) | 9–10  | `--color-muted` 9, `--color-subtle` 10       |

Applying a flat offset everywhere is the mistake to avoid: it neutralises the text while barely touching the ground, and the page reads _warm_. The product keeps its own lightness ladder (it has a rail and a floor to stack — landing does not); what it shares with landing is the hue at every lightness.

### 4.2 The Iris ramp

Ten steps, the same values landing carries as `--lp-iris-*`. Calibrated in OKLCH: hue ≈ 266°, chroma peaking near step 700 (C 0.231) because blue's usable chroma maxes out around L 0.47. The **whole ramp is exposed** — a pricing ring or a focus ring on a dark ground needs step 300, and a step that is not a token is a step someone writes as a bare hex.

| Step | Value         |     | Step | Value        |
| ---- | ------------- | --- | ---- | ------------ |
| 50   | `237 241 255` |     | 500  | `66 107 240` |
| 100  | `219 227 255` |     | 600  | `53 96 235`  |
| 200  | `185 200 253` |     | 700  | `24 66 216`  |
| 300  | `140 165 249` |     | 800  | `24 51 160`  |
| 400  | `93 128 244`  |     | 900  | `21 36 102`  |

The ramp is theme-invariant. Only the aliases move:

| Alias                 | Light        | Dark      | Job                                       |
| --------------------- | ------------ | --------- | ----------------------------------------- |
| `--color-info`        | 600 (4.96:1) | **300**   | brand · active · running · links · focus  |
| `--color-info-strong` | 700          | 200       | pressed, hovered links                    |
| `--color-info-vivid`  | 500          | 400       | **fill only** — bars, marks, large blocks |
| `--color-info-bg`     | 600 @ .10    | 400 @ .16 | chip / badge wash, flattened opaque       |

Dark takes 300 where landing takes 400: the product's brand colour sits on card surfaces (`35 36 40`) far more often than landing's does, and 400 only reaches 4.33:1 there — under AA for text.

### 4.3 Judgment colours

Four hues beside Iris, each with **four tiers** whose contrast floors differ because their jobs differ:

| Tier      | Job                                   | Floor                      |
| --------- | ------------------------------------- | -------------------------- |
| `-fg`     | text and icons                        | ≥ 4.5:1 on the canvas (AA) |
| `-strong` | pressed states, text on its own `-bg` | ≥ 4.5:1 on `-bg`           |
| `-vivid`  | **fills only** — never text           | ≥ 3.0:1 (WCAG 1.4.11)      |
| `-bg`     | low-alpha wash, flattened opaque      | —                          |

The hues are landing's (OKLCH hue and chroma taken from `--lp-*`); the lightness is re-solved to these floors. Every `-fg` is used as text — 93 call sites — so `-fg` clearing AA is not optional.

| Colour  | Hue    | Light `-fg` | `-strong` | `-vivid`  | `-bg` α | Dark `-fg` | `-strong` | `-vivid`  |
| ------- | ------ | ----------- | --------- | --------- | ------- | ---------- | --------- | --------- |
| success | 153.5° | `#068346`   | `#036836` | `#0da55a` | .10     | `#0bab64`  | `#25c576` | `#078d51` |
| warning | 68.9°  | `#a16404`   | `#7f4f02` | `#c7801b` | .10     | `#c38a30`  | `#dda34c` | `#a66f05` |
| error   | 28.0°  | `#d4342c`   | `#b6050d` | `#f9594c` | **.09** | `#f06c63`  | `#fe8d83` | `#d05049` |
| idle    | 279.1° | `#6e7184`   | `#56596c` | `#8c8fa3` | **.13** | `#9194aa`  | `#a9acc3` | `#76798f` |

idle sits at 279° — the Iris family with the saturation drained — so "nothing is happening" reads as the brand colour at rest rather than an unrelated grey. The `-bg` alphas are landing's: red goes muddy at .10 so error takes .09; grey needs more to lift off the canvas so idle takes .13.

**Colour is never the only signal** (§10.6): every status carries a label or an icon as well.

### 4.4 Token tables

Light / dark, as declared in `styles.css`. Tiers are anchored to each other by WCAG ratio — `surface-hover` on `surface` 1.14, `rail-hover` on `rail` 1.11, `soft` on `surface-elevated` 1.16 — so a hover reads the same on every ground (§8.10).

| Token                      | Light                      | Dark                       | Role                                           |
| -------------------------- | -------------------------- | -------------------------- | ---------------------------------------------- |
| **Grounds**                |                            |                            |                                                |
| `--color-app-bg`           | `224 225 228`              | `9 9 11`                   | page floor, under the rail                     |
| `--color-rail`             | `237 238 240`              | `15 15 18`                 | sidebar; recedes from the canvas               |
| `--color-rail-hover`       | `226 227 229`              | `31 32 36`                 | sidebar row hover = `--color-active-session`   |
| `--color-main-bg`          | `249 249 251`              | `22 23 25`                 | the canvas the work sits on (= `--lp-bg-soft`) |
| `--color-surface`          | `252 252 253`              | `35 36 40`                 | cards, composer, popovers (= `--lp-paper`)     |
| `--color-surface-subtle`   | `237 238 240`              | `29 30 34`                 | recessed inside surface: tool blocks, code     |
| `--color-surface-elevated` | `254 254 254`              | `45 46 51`                 | top-most popover                               |
| `--color-surface-hover`    | `236 237 239`              | `51 53 58`                 | ghost button / chip hover on `surface`         |
| `--color-soft`             | `236 237 239`              | `61 63 69`                 | popover-item hover on `surface-elevated`       |
| `--color-soft-hover`       | `229 230 232`              | `73 75 81`                 | one step further                               |
| `--color-divider`          | `228 229 231`              | `60 62 68`                 | hairline rules                                 |
| **Ink**                    |                            |                            |                                                |
| `--color-fg`               | `12 12 15`                 | `231 231 233`              | headings, body                                 |
| `--color-muted`            | `85 87 94`                 | `188 189 194`              | secondary body                                 |
| `--color-subtle`           | `113 115 123`              | `128 130 138`              | meta, captions                                 |
| `--color-placeholder`      | `133 135 143`              | `109 111 118`              | input placeholders                             |
| **Primary button**         |                            |                            |                                                |
| `--color-strong`           | `12 12 15`                 | `231 231 233`              | near-black slate; flips to near-white in dark  |
| `--color-strong-hover`     | `47 48 53`                 | `204 205 209`              | one step toward the canvas                     |
| `--color-strong-fg`        | `255 255 255`              | `14 15 17`                 |                                                |
| **Objects**                |                            |                            |                                                |
| `--color-avatar-bg / -fg`  | `222 223 226` / `35 36 40` | `48 50 55` / `231 231 233` |                                                |
| `--color-icon-bg / -fg`    | `224 225 228` / `66 67 74` | `41 42 47` / `188 189 194` |                                                |
| `--color-disabled-control` | `202 203 207`              | `67 69 75`                 |                                                |

The docs baseline (`apps/docs/src/styles/global.css`) carries the same values as complete `rgb()` (Tailwind 4's `@theme` needs them), plus a few of its own: `--color-ink-soft`, a semi-transparent `--color-divider` so rules can sit on any ground, and dimmer dark-mode `muted` / `subtle` tuned for reading. Those are the deliberate differences; every other value is expected to match, token for token.

## 5. Typography

Two families, each with one job:

| Family       | When                                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Geist`      | All UI text — every heading rung, body, labels, controls. Every page.                                                                                                                                                |
| `Geist Mono` | **Only** technical signal: agent IDs, framework names, runtime status, code, CLI, container names, paths, hex values. Not timestamps, not labels, not body copy — if everything is mono, nothing reads as technical. |

The serif landing sets its headlines in (`Fraunces`, `.lp-h*`) is deliberately **not** used here. A workbench is read for hours at close range and its headings are scanned, not read; the product carries hierarchy with size, tracking, colour and space, in one sans family. The face is still loaded globally by `styles.css` because landing needs it — that is not an invitation.

### Type scale

**Every size in this section is the `default` display mode.** The three modes are an explicit per-mode ramp, not one base scaled by a coefficient — see [Display modes](#display-modes) below for the other two columns.

| Role          | Token / class  | Default size | Use                                                                                                                                                                                |
| ------------- | -------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focal display | `text-display` | 32px         | The one centred focal moment on a working surface — the new-chat greeting, a hero stat number. Not a page title; reserved for a surface that has _nothing else_ competing with it. |
| Page title    | `text-h1`      | 22px         | Workspace / settings page identity                                                                                                                                                 |
| Section title | `text-h2`      | 20px         | Grouped content, major panel title, modal title, stat value                                                                                                                        |
| Card title    | `text-h3`      | 18px         | Small panel and list block titles                                                                                                                                                  |
| Body          | `text-body`    | 16px         | Primary descriptive copy                                                                                                                                                           |
| Chat          | `text-chat`    | 14px         | Chat message body (markdown `prose`) + composer input — the two must stay equal (see [The chat rung](#the-chat-rung))                                                              |
| UI            | `text-ui`      | 14px         | Default button / nav / compact copy                                                                                                                                                |
| Caption       | `text-caption` | 12px         | Metadata, timestamps, secondary labels                                                                                                                                             |
| Code          | `text-code`    | 12px         | Every code surface — inline code, code blocks, the terminal (see [Code sizing](#code-sizing))                                                                                      |

**The product head scale is deliberately compressed for workbench density.** The default ladder is `32 / 22 / 20 / 18 / 16 / 14 / 14 / 12 / 12` (display → code) — a far tighter range than the landing scale, which climbs into the 40–124px hero tiers via the `.lp-*` classes. A working surface (workspace, chat, settings) is read for hours at close range; a 24px-or-larger page title that feels right on a marketing page reads as oversized here, so `text-h1` sits at a restrained 22px and the section/card tiers (h2 20 / h3 18) trail it closely — at workbench density the page identity should be _legible-first_, not loud, with the header's position at the top of the page doing as much hierarchy work as its size. **`text-h1` 22px is the ceiling for an ordinary page title.** Anything larger on a product surface must be a genuine focal moment with nothing else on screen (`text-display`, 32px) — and there is at most one per surface. Never reach for a bespoke `text-[2.75rem]` / `text-3xl` / `text-4xl`: if a title needs to be bigger than `text-h1`, the right move is `text-display`, not an arbitrary size off the scale.

### Display modes

`data-font-size` on `<html>` selects one of three columns: `compact`, `default`, `large`. Each column is **hand-picked per rung**, held as CSS variables in `styles.css`; the Tailwind `fontSize` tokens point at those variables.

| Rung           | compact | default | large |
| -------------- | ------- | ------- | ----- |
| `text-display` | 28      | 32      | 36    |
| `text-h1`      | 20      | 22      | 24    |
| `text-h2`      | 18      | 20      | 22    |
| `text-h3`      | 16      | 18      | 20    |
| `text-body`    | 15      | 16      | 17    |
| `text-chat`    | 13      | 14      | 15    |
| `text-ui`      | 13      | 14      | 15    |
| `text-caption` | 11      | 12      | 13    |
| `text-code`    | 11      | 12      | 13    |

**Why three explicit columns instead of one ratio.** The mode used to be a single root `font-size` (14 / 16 / 18px) with every token in `rem`, so all of them scaled by 0.875 / 1 / 1.125. That produced sizes nobody designed — chat body at 12.25px in compact, `text-h1` at 24.75px in large — and, more importantly, it could not compress the ends, which is exactly where a ramp needs to compress: small text has a legibility floor, large text has diminishing returns. Note in the table that `default → large` adds 2 at the top but only 1 at the bottom, and `compact` likewise gives up only 1 at the bottom. No single coefficient does that.

**Why the values are px, and why the root override stays.** The root `font-size` is still set per mode (14 / 16 / 18px), because Tailwind's spacing and sizing scales are `rem`-based and that is the _density_ half of a "compact" mode — padding, gaps and control heights should tighten with it. The text rungs are therefore expressed in **px**: in `rem` they would scale a second time on top of the root. One consequence to accept knowingly: a px root overrides the reader's browser font-size preference. That predates this scheme; changing it would stop layout from responding to the mode, which is a separate and larger decision.

**`:root` carries a duplicate of the `default` column** as a pre-hydration fallback. `lib/fontSize.tsx` sets the attribute in an effect, so the first paint has no `[data-font-size]` at all and every `var(--text-*)` would otherwise resolve to nothing.

**Markdown headings deliberately have no tokens of their own.** They reuse this ramp one rung down — md `h1` = `--text-h2`, md `h2` = `--text-h3`, md `h3` = `--text-body`, md `h4–h6` = `--text-chat` — which yields 20 / 18 / 16 / 14 at default and stays integer in all three modes. A markdown heading sits _inside_ a 14px message body, so it must be sized relative to that body, not to the page chrome.

**Landing does not participate.** `.lp-*` keeps its own `clamp()` sizes and is deliberately excluded: `data-font-size` is a signed-in application preference, and a first-time visitor to the marketing page has no setting at all.

### The chat rung

**`text-chat` exists to keep one invariant: the composer input and the message it produces render at the same size.** The chat message body is "primary descriptive copy" (would be `text-body`) and the composer is a _preview of the message you're about to send_, so a size mismatch between them reads as a bug — WYSIWYG continuity is the rule every reference tool follows (ChatGPT / Claude web match input to output; terminal Codex / Claude Code share one monospace grid). **Both consumers must move together** — raising one without the other reintroduces the mismatch this token exists to prevent.

`text-chat` and `text-ui` now resolve to the same value at every rung. The token stays separate anyway, for two reasons: the two roles carry different line-heights (message body 1.7 for long-form reading, composer 1.45 for a tight input, compact UI 1.43), and they must be free to diverge later without one dragging the other. Do not collapse the two, and do not read their current equality as license to use `text-ui` for message bodies.

**iOS caveat:** an input under 16px triggers Safari focus-zoom, so below the 640px breakpoint both the composer and `.prose` bump to 16px — together, preserving the invariant. The desktop workbench keeps the ramp value.

### Code sizing

**One rung covers every code surface.** `text-code` sizes inline code, code blocks, the terminal, and any other mono content that _is_ code. Inline and block are deliberately **not** distinguished — `@tailwindcss/typography` does the same at every one of its sizes (`code` and `pre` share a `fontSize` in all four variants), and its `prose-sm` variant independently lands on the same three numbers this system uses at default: body 14, inline code 12, block 12.

The rung takes the value the _inline_ case needs, because only inline carries a hard constraint: it sits inside a line of body text, so it must neither disturb the line box nor read optically larger than the prose around it. Mono has a uniform stroke and a large x-height, so at equal px it looks bigger than Geist; the tinted chip and its padding enlarge it further. The industry ratio of ~0.85–0.875 (GitHub 85%, Bootstrap 87.5%) is what points at 12 against a 14px body. A code block has no such constraint — 12 or 13 both read fine — so satisfying the tight constraint satisfies the loose one.

**Code inside a heading is the one exception: it takes the next rung down** rather than `text-code`, so a heading that is entirely code (`## POST /api/agents/:id/sessions`) still reads as a heading instead of a mis-tagged run of body text. This is expressed as **named rungs, not an em ratio** — the ramp compresses at its ends, so its gaps are not proportional, and a single ratio per heading level would land on fractions outside `default`.

**The terminal mirrors the rungs in JS** (`terminalFontSize` in `TerminalDock.tsx`), because xterm's `fontSize` is a number rather than a CSS value; it refits on change, since the character grid depends on it. Note the split this draws: the file tree is _not_ a code surface — its font is Geist **sans**, making it a UI list — so it tracks `text-ui`.

### Type weight & color

The weight rule is **scoped by family**, not by size.

- **Product surfaces cap at 500. No exception.** Body sits at 400, so a 500 heading, label or `<strong>` already reads as a clear step up without going heavy; at workbench density 600 reads as shouting. Hierarchy is carried by size, tracking, colour and space — never weight. Do not re-pin `font-semibold` on a `text-h*` element.
- **Docs headings are 500 too.** h1–h4 there once shipped at 600; they now sit at the same cap as the webapp.
- **Windows CJK keeps 600 on `<strong>` only.** Microsoft YaHei ships 400 and 700 and nothing between, so a CJK run at 500 resolves to Regular; `<strong>` has no other signal, so `data-cjk-weights="coarse"` pins it to 600 there. Headings are left alone — size and space still carry them.
- **Product _chrome_ headings descend one step in colour** to `--color-muted` rather than pure ink: a page or panel title is structure, not the thing being read. **Headings inside a content flow keep full ink** — markdown headings in a chat message, article headings in docs.
- **Inline code always renders at 400.** Mono has a uniform stroke and a large x-height, so at equal numeric weight it reads bolder than Geist; the prose theme overrides `code` back to 400 even inside `<strong>`.
- **Micro-labels are sentence case at normal tracking.** Kickers, stat labels, table heads, eyebrows, badges — the family that used to run ALL-CAPS at `tracking-[0.18em]`. Caps and wide tracking are one unit rather than two choices: the tracking only ever existed to give capital letterforms air, so it does not survive the caps. Source strings stay authored in sentence case (`Cost`, `Input tokens`), so the label reads the same in the DOM, on screen and to a screen reader.
- **Tracking tightens as size grows:** body 0, h3 −0.01em, h2 −0.015em, h1 −0.02em, display −0.025em. It is declared in the `fontSize` tuples, so do not stack `tracking-tight` on a heading rung — the tuple already carries the right value.

## 6. Shape & radius

### 6.1 The product scale

Three working tiers, and **14 is the ceiling**: no card, panel, popover, dropdown or modal in the product is rounder than 14. It was pulled in over two passes (20/16/12 → 18 → 14) for the same reason each time — on a dense page divided into many cards, larger corners read bubbly. The token scale itself is honest and ascending; the product simply never reaches above `md`.

| Step                    | Class                                               | Px                | Picked when…                                                                                                                                                            |
| ----------------------- | --------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Md**                  | `rounded-md`                                        | **14**            | **The ceiling.** Every card, panel, popover, dropdown, modal, and the chat shell.                                                                                       |
| **Sm**                  | `rounded-sm`                                        | 10                | Every short boxed control — buttons, inputs, segmented options, list rows, menu items, in-card chips — and every element nested inside an Md surface with a 4px gutter. |
| **Xs**                  | `rounded-xs`                                        | 8                 | Micro-glyph tier: inline code chips, count badges, small tags, tiny inputs. Anything that reads as "a glyph, not a surface".                                            |
| **Lg / Xl / 2xl / 3xl** | `rounded-lg` … `rounded-3xl`                        | 20 / 24 / 28 / 32 | Honest, but **unused on product surfaces.** They match landing's hero tiers.                                                                                            |
| **Composer**            | `.chat-composer-card` (inline, not a Tailwind tier) | **18**            | The single surface above the ceiling: the primary input should read as soft and tactile.                                                                                |
| **Pill**                | `rounded-pill`                                      | 9999              | Capsule / circle: identity-surface controls (nav chip, avatar, status dot), icon-only buttons, badges and tags — never a box.                                           |

Landing runs `8 / 12 / 16` under the same three tier names (`--lp-r-*`). **The two scales share `xs` and every tier from `lg` up; they diverge only at `sm` and `md`**, where the product runs two units tighter. That divergence is deliberate: colour and type converge on landing to make one brand, while radius stays apart to mark density — a marketing page is read once and allowed to feel sculptural; a workbench is read for hours.

Icon, logo and avatar tiles are objects, not surfaces — size their radius by the tile (a 20px tile takes 4, a 32px tile takes 6), never at the Md ceiling.

### 6.2 Pill vs. radius

Pill (9999) is for **identity-surface controls** — the nav chip, the avatar, the status dot, the tab strip on a frame bar (§8.13). Everything that is a box takes a tier. The tell is whether the thing is a capsule you'd pick out of a bar, or a panel that holds content.

### 6.3 Concentric nesting

When a smaller surface lives inside a larger one, `outer − padding = inner`. The one combination in the product that binds a child flush is the **popover / menu: Md 14 outer, 4px gutter, Sm 10 rows** — 25 sites, all exact. Cards use ≥ 12px padding, so their children sit away from the edge and the rule is informational there.

| Outer       | Padding | Inner                                             |
| ----------- | ------- | ------------------------------------------------- |
| Md 14       | 4       | Sm 10 — the popover / dropdown contract           |
| Md 14       | 8+      | by size, not subtraction — the child is not flush |
| Sm 10       | 4       | flat — 6 lands below the Xs 8 floor               |
| Composer 18 | 8       | pill chips / flat input row                       |

The popover gutter is `p-1` (rem) while radius is px, and the root font-size moves with the display mode (14/16/18), so only `default` is exact; compact and large sit 0.5px off. Invisible at these radii, and the fix if ever wanted is `p-[4px]`.

### 6.4 Corner curvature — circular only

Every surface uses the circular `border-radius`. The system does not use continuous-curvature corners (squircle / superellipse / `corner-shape`): they are inconsistently supported, and on a page with many small boxes the difference reads as inconsistency rather than refinement.

## 7. Elevation, shadow & surface anatomy

The system has **two surface finishes** (§2). Pick by what the surface _is_, not by how important it is.

### The flat finish — the product default

Cards, panels, tables, popovers, dropdowns, menus, tooltips, and modals — every elevated working surface _except the composer_ — use a **flat** recipe:

1. **A solid fill** — one of the surface tones (`--color-surface` / `--color-surface-elevated`). No inset gleam, no platinum band, no gradient inside the fill.
2. **A single 1px hairline ring** — the ring stop inside `--shadow-card` / `--shadow-elevated` (or `--shadow-ring` / `--shadow-ring-light` on its own). This is an _edge_, not a volume cue: it marks where the surface ends without pretending the surface is sculpted.
3. **An optional soft downward drop** — short stops, tight blur, low alpha. `--shadow-card` grounds a resting card (≈10px reach below); `--shadow-elevated` lifts a floating popover / menu / modal (≈28px reach). A surface that doesn't need to lift — a recessed inset panel, a stat tile — carries only the ring (`--shadow-ring-light`) and no drop.

There is **no inset top highlight and no cool-platinum chamfer band** on a flat surface — removing them is the whole point of this pass. A page split into many cards reads calmer and crisper when each card is a clean matte plane than when each one is individually sculpted with its own gleam and shadow. Separation between a flat surface and the canvas comes, in order of importance, from (a) the surface tone sitting above the canvas tone, (b) the 1px ring, and (c) the optional drop.

### The milled finish — the composer only

The **chat composer** (`.chat-composer-card`) is the one surface that keeps the **"milled chassis"** anatomy — the primary input should read as a tactile, hand-feel control against the flat cards around it. Landing gave this finish up (its cards are paper on paper now; `DESIGN.landing.md` §1.5).

1. **A soft inset top highlight** (the platinum gleam) — full white in light mode, near-white at low alpha in dark, pushed 3–6px from the top _with a small blur_ (`0 3-6px 5-10px -2px inset`). The blur keeps the gleam from terminating in a hard horizontal seam — the lit edge fades into the surface.
2. **A soft inset cool-platinum band** (light mode only) — `rgba(170, 188, 208, 0.35–0.5)` pushed 2–2.5px from the bottom _with a small blur_ (`0 -2px to -2.5px 5-7px -2px inset`). This is the cool sheen reflecting off the chamfered bottom edge — the second half of "lit from above on a metal slab."
3. **A soft inset bottom ink shadow** (the edge tuck) — `rgba(10,12,15,0.05–0.13)` or `rgba(0,0,0,0.12–0.16)` in dark, same offset/blur as the platinum band, layered after it.
4. **A 1px contact line** directly below the element — ink at 0.04–0.07 (light) or black at 0.08–0.12 (dark).
5. **A drop shadow stack**, pushed _downward_ (positive Y) not spread around the element. Short stops, tight blur, low alpha — total reach 9–54px depending on tier. No long-distance trailing stops; long stops at low alpha read as smudge, not lift.
6. **A 1px outer ring** for edge crispness — the milled-edge cut.

This anatomy makes those surfaces feel **lit from above and resting on the chassis**, not floating in fog. The lift is _quiet_ — drop alphas in the 0.04–0.17 range, **hard-capped at 0.17 in dark mode** (§4.2 dark shadow rule). The platinum band is what carries most of the "metal" reading; the drops just keep the element grounded. **Do not apply this recipe to any other product surface.** If a card, popover, or modal looks sculpted or "too 3D," it has wrongly picked up the milled layers — strip them back to the flat finish above. If the _composer_ looks too plasticky, its alphas are over budget; re-read the §4.2 caps.

### 7.1 The shadow scales

**Flat surfaces (the product default)** use just two tokens: `--shadow-card` (a resting card, ≈10px drop reach) and `--shadow-elevated` (a floating popover / menu / modal, ≈28px reach). Both are _1px ring + short downward drop, no inset layers_. Pick `--shadow-card` for something resting on the page and `--shadow-elevated` for something floating above it; a recessed or non-lifting surface (inset panel, stat tile) uses `--shadow-ring-light` — the ring alone, no drop.

The composer's stack is inline on `.chat-composer-card`. Landing's `--lp-shadow-*` scale is specified in `DESIGN.landing.md` §1.5.

### 7.2 Button shadows

**Identity-surface buttons** (the composer's own controls, nav chips, avatar and status pills) are capsules; **working-surface buttons** (the `workbench-button-*` family — settings, dialogs, management pages) are Sm 10 boxes. Both are _flat_: a solid fill, and a 1px ring (`--shadow-ring-light`) on the secondary/danger variants, with no inset gleam. The recipe below is the identity-surface variant; working-surface buttons take the same fills at Sm 10.

| Token | Anatomy | When |
| ----- | ------- | ---- |

Primary's bottom inset is heavier so the fill reads as having a "lip" at the bottom edge — that's what makes the gleam at the top jump out. Both insets carry a small blur so the lit and tucked edges fade into the fill instead of terminating in a hard horizontal line.

### 7.3 What never gets a shadow

- Small status pills, tags, badges — they're flat colored chips. Shadow would make them compete with cards. **Product tags are ringless** — their contrast-budgeted fill is the edge (§8.3 tag family).
- Avatars and ico boxes — they're flat circles with a solid background. Shadow makes them look like buttons.
- Body text, dividers, inline icons.
- Anything inside a card that's already elevated, except the next nested level (composer inside hero panel is OK).

The rule of thumb: if you can press it or hover it, it gets a shadow (button or card); if it just annotates content, it doesn't (pill, tag, badge, avatar).

## 8. Interactive components

### 8.1 Buttons

**Scope:** this section specs the **identity-surface pill buttons** (the same anatomy as it appears in the rail / chat frame). For the product's two-register shape split — where substantial buttons on _working_ surfaces (settings, agent-management, automations, dialogs) are **Sm 10 boxes**, not pills, via the shared `workbench-button-*` family — see §6.2. The fill / hover anatomy below applies to both registers; the corner shape differs (pill on identity surfaces, Sm 10 on working surfaces); the elevation does not — both are flat, a 1px ring and no inset gleam (§7.2).

Two variants, both tactile. **Buttons use flat fills** — the lit-from-above feeling comes entirely from the milled-edge anatomy (§7), not from a vertical background gradient. A gradient _inside_ the fill plus a gleam _on top of_ the fill double-counts the same idea and reads as plasticky.

**Hover rule (binding):** a hover changes the **fill** of a button — never `filter: brightness()`, never the text or icon color. Why: `filter: brightness()` multiplies the whole element including text and icon, so on a dark fill with white text the text reads as having lost contrast. Changing only the fill keeps text/icon contrast intact.

**Hover direction (binding):** the fill on hover moves _toward the page floor_ (the darker end of the Ash ramp) in **light mode**, and _away from it_ (the brighter end) in **dark mode** — i.e. hover always pulls the surface one same-hue step **away from the page floor**, never toward it. Equivalently:

| Theme | Rest fill (vs. background)          | Hover fill                                               | What the user feels                                                                |
| ----- | ----------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Light | Same-as / _lighter-than_ background | One step **darker** (toward `--color-surface-hover`)     | "The page is calm; this row I'm pointing at is settling closer to the page floor." |
| Dark  | Same-as / _darker-than_ background  | One step **lighter** (toward `--color-surface-elevated`) | "The page is dim; this row I'm pointing at is lighting up."                        |

This is the macOS / Linear / Vercel convention and matches user expectations across the industry. The previous rule (which said _light hovers darken and dark hovers darken too_ by stepping toward the elevated tier in both modes) inverted the direction in dark mode and conflicted with how every other major UI handles list-row hover.

What flips between themes is **which side of the ramp is the "headroom" side**, not the rule. The rest fill never needs to _attract_ the eye — it's at rest. The hover fill is the only state that says "I'm being pointed at."

**Primary (`.lp-btn-primary`)**

- Light mode: fill `--color-strong`, white text. Hover fill `--color-strong-hover`. Primary inverts the direction rule because its fill is already at the darkest end of the ramp; the only headroom is upward. Text/icon stay pure white.
- Dark mode: fill `--color-strong` (near-white slate, **not warm cream**), deep-ink text. Hover fill `--color-strong-hover` — one step toward the canvas.
- Shadow: none — product buttons carry a ring, not a drop (§7.3).
- Active / press: `transform: translateY(0.5px)` — a felt 0.5px depression, not a full bounce.

Primary is the **only** class where hover and rest sit on opposite sides of the page floor — the brand-emphasis fill is so saturated/contrastful that it gets its own "press into the page floor" treatment. All other classes follow the binding direction rule above.

**Secondary (`.lp-btn-secondary`)**

- Fill `--color-surface` at rest, `--color-surface-hover` on hover — one step toward the page floor in light, away from it in dark.
- Shadow: none; a `--shadow-ring-light` ring.
- Active: same translateY(0.5px) press.

**Icons inside CTA buttons do not move on hover.** A pill button is a fixed target; sliding the arrow on hover competes with the fill shift and makes the row of CTAs feel jittery. The hover signal is the fill change, not motion.

**Hero CTA sizing (`.lp-hero-ctas .lp-btn`):** height 52px, padding `0 26px`, font 15.5px, gap 10, arrow 16px.
**Default sizing:** padding `14px 24px`, font 14.5px, arrow 14px.
**Compact / nav sizing (`.lp-nav-chip`):** height 34px, padding `0 11px`, font 12.5px.

### 8.2 Cards

A card is a content surface, not a button. **The fill is a flat solid color** — separation lives in the shadow, never in a gradient inside the fill.

**Product cards (the common case) are flat (§7).** Solid `--color-surface` fill, the product card radius **Md 14** (the ceiling — large cards, stat / choice cards, every card sits here), `--shadow-card` (a 1px ring + a soft drop), and `border: 0`. No texture, no inset gleam.

```
Product card, at rest:
  background-color: rgb(var(--color-surface));
  border-radius: 14px;             /* Md — the product card ceiling */
  box-shadow: var(--shadow-card);  /* 1px ring + soft drop, no inset layers */
  border: 0;
```

Most product cards do **not** lift on hover. Only a genuinely clickable card-link reacts, and it does so by stepping its _fill_ one tone toward the headroom side (light → `--color-surface-hover`, §8.10) — not by a `translateY` + shadow swap.

**Important:** when overriding a card's background use `background-color:` longhand, never the `background:` shorthand — the shorthand resets `background-image`, and the habit protects any surface that later gains one.

### 8.3 Pills, tags, badges, status chips

Product tags drop the ring — see the tag family below.

A pill's job is to annotate, not to compete. If the pill needs a shadow, the design is asking it to be a button — make it a button.

#### The product tag family (`.tag`)

Inside the product every tag / badge / status chip is built from **one anatomy and three roles** — the classes live in `styles.css`, the React helpers in `components/Tag.tsx`. Historically each surface invented its own chip (ALL-CAPS mono runtime codes, hardcoded `#ecfdf3` green pills, 4-px `rounded` version chips, four duplicate risk-color maps, a `bg-link/10` `PRIMARY`, three sizes of count bubble); the family replaces all of them.

**The shared anatomy — every tag, no exceptions:**

```
.tag {
    /* pill, text-caption (12px), font-weight 500, Geist sans */
    @apply text-caption rounded-pill inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 font-medium;
    /* + one role class below; the role carries fill and text color.
       No ring, no border, no shadow — the fill IS the edge. */
}
```

Capitalized sans, always: **never ALL-CAPS, never `tracking-wider`, no `text-[10px]`/`text-[9px]` bespoke sizes.** Mono is allowed only when the tag's _content_ is a technical value (§5). One size for the whole product — a tag never gets bigger to look more important.

**Product tags are ringless — the fill carries the contrast contract.** A tag can sit on `--color-surface` (252), the chat canvas (249), the rail (237), or a `--color-soft` hover row (236), so each role's fill is budgeted to hold a **≥12–14 RGB delta against the worst of those parents, in both themes**, instead of leaning on an outline:

- The neutral fill is its own token, **`--color-tag-bg`** — an **ink wash**, `rgb(var(--color-fg) / 0.07)` light / `0.10` dark (the token holds a full color, not an RGB triplet). A wash steps down from _whatever_ parent by a constant ~Δ15, which solves both failure modes an opaque grey has: deep enough for the darkest parent it reads heavy on a bright card, light enough for the card it vanishes on a soft row. In dark the wash is light, so the tag sits _lighter_ than its parents — the away-from-floor direction. Never substitute `bg-soft` for a tag fill.
- The toned fills are likewise **translucent washes of the tone's `-fg` token** — `rgb(var(--color-{tone}) / 0.14)` light, `/ 0.20` dark — not the flattened `-bg` banner tokens: an alpha fill adapts to whatever parent it lands on at constant perceived strength. The opaque `-bg` tokens remain the banner / notice fills (§10.5, §10.6); tags no longer share them.

If a tag ever looks like it's missing an edge, the fix is to retune these fills (or reconsider the parent), never to reintroduce a ring or shadow.

**The three roles:**

| Role                | What it answers                                                                                                                           | Class                                                               | Treatment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**          | "What is this thing doing _right now_?" (Running / Ready / Pending / Failed / Disabled)                                                   | `.tag-{info\|success\|warning\|error\|idle}` + a leading `.tag-dot` | Translucent tone wash (`rgb(var(--color-{tone}) / 0.14)` light / `0.20` dark — no ring), text `-strong` in light / `-fg` in dark (the strong cut is dimmer than fg on dark tints; idle uses `--color-muted`). The **6px `currentColor` dot** is the live-state marker; `animate-ping` overlay allowed for in-flight states (pending, starting, streaming). Rendered via **`StatusTag`** (`tone`, `label`, `pulse`) — tone mapping for raw status strings goes through `statusTone()`, label casing through `statusLabel()`. Tones map to §10.6 semantics, never re-invented per page. |
| **Classification**  | "What _kind_ of thing is this?" (Primary / Managed / Built-in / Custom / Beta / Sandbox / Recommended) — plus **counts** (`tabular-nums`) | `.tag-neutral`                                                      | `--color-tag-bg` ink wash, `text-muted`, no ring. No dot. Rendered inline (`tag tag-neutral`) or via **`Tag`**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Technical value** | A version, port, id, type marker (`v2.1.92`, `:8080`, `ext`, `keep-alive`)                                                                | `.tag-neutral` + `font-mono`                                        | Same neutral chrome; the **family switch** is the technical signal (§5). Content keeps its literal case — mono is never uppercased.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Severity / value tags are toned but dot-less.** A permission risk level (`RiskTag`: low → idle, medium → warning, high → error) or a "Current plan" marker uses the `.tag-{tone}` fill _without_ the dot: the dot means "live state", and a severity or role is a fixed property, not something happening. This is the one sanctioned variation between status and classification.

**What the family kills (do not reintroduce):**

- ALL-CAPS + `tracking-wider` on any tag — §8.12's no-shouting rule, which §5 now binds across every label in the product, not tags alone.
- `font-mono` on a human-readable label (`RUNNING`, `Managed`, `ok`) — mono is content-driven, not decoration.
- Hardcoded status hexes (`#ecfdf3`, `#047857`, `#fff7ed`, `#fff7f5`) and raw Tailwind palette colors (`bg-green-100`) — tones come from the §10.6 tokens only.
- Per-page tone maps. One `statusTone()` / `riskTone` mapping; a page never redefines which hue "failed" is.
- The 4-px `rounded` chip (versions, protocols, `Built-in`) — tags are pills (§6.2 objects), 4px isn't on the radius scale at all.
- Size variants: no `px-2.5 py-1`, no `px-3 py-1`, no `text-mini`/`text-[10px]` bubbles. Count badges are `.tag-neutral tabular-nums` at the standard size.
- Rings, borders, and shadows on a product tag — the divider-ring era is over; the contrast-budgeted fill is the edge.
- The legacy `.status-tag` and `.workbench-pill` classes — both removed; `.tag-neutral` is the single survivor.

A tag is never interactive chrome. The one sanctioned press-target wearing the tag anatomy is the sandbox `SpriteStatusRefresh` control, which _is_ the status it refreshes — it adds only hover opacity, no shadow, no new shape.

**Never construct a tone class as a template string (`` `tag-${tone}` ``).** Tailwind emits `@layer components` rules only when the class name appears _verbatim_ somewhere in the content scan, so a computed class silently ships no CSS (this exact bug shipped `.tag-success` / `.tag-idle` as unstyled text). Always go through the `tagToneClass` map in `Tag.tsx` — its literal values are what keep the five tone classes alive in the build.

### 8.5 Avatars and ico boxes

Circular, flat, solid background. No shadow, no border, no gradient.

```
.lp-pd-agent-avatar, .lp-pd-scene-head .lp-av, .lp-machine .lp-ico, .lp-feat .lp-ico {
  border-radius: 9999px; /* rounded-pill */
  background: rgb(var(--color-avatar-bg));
  /* no shadow */
}
```

### 8.6 Inputs / composer

The composer is a stand-alone **tactile** surface, not a flat textarea — and it is the **one product surface that keeps the milled-chassis finish** (§7). Everything else in the product is flat; the composer stays sculpted so the primary input reads as a hand-feel control. In the webapp it carries its own inline milled `box-shadow` on `.chat-composer-card` at **18px** radius — the one surface above the product's 12 ceiling.

```
.lp-pd-composer {
  background: rgb(var(--color-surface));
  border-radius: 18px; /* the one surface above the Md 14 ceiling */
  padding: 14px 18px;
  box-shadow: /* the composer's own milled stack, inline in styles.css */;
}
```

Composer behavior rules (apply across the product):

- Multiline auto-grow up to ~10 lines / ~40vh, then scroll.
- `Enter` submits; `Shift+Enter` inserts newline. Always ignore `Enter` while an IME composition is in flight (`event.nativeEvent.isComposing`). This applies to every message-sending input (chat composer, inline message edit); long-form prompt editors with an explicit save/create button (Automations prompt, settings textareas) keep `Enter` as newline.
- File / context attachments render as cards above the input: images as a 1:1 thumbnail tile, other files (and context refs) as a flat Sm 10 card with a monochrome type-icon box, filename, and an uppercase type label. The remove control is a circular button pinned to the card's top-right corner.
- `/` and `@` popovers anchor to the caret and follow the §8.7 popover contract — flat `--shadow-elevated`, Md 14 panel, Sm 10 rows.
- Token / model / cost affordances live in the composer footer at `text-caption`, only when the value matters to the user.

### 8.7 Menus / popovers / dropdowns

Every popover / menu / dropdown in the product follows the **same outer-inner contract**, regardless of trigger (composer chevron, sidebar overflow, context-menu, settings filter, automations picker, etc.). **The contract lives in exactly one place — the `.popover-panel` marker class** (item gap, separator, separator-reset). Every menu surface carries `.popover-panel` and adds only its own positioning / width / blur as utilities; no menu re-implements the spacing rules under a private class name. The composer's `.chat-composer-*-menu` surfaces are `.popover-panel` consumers, not a second system.

| Element                         | Token / value                                                                                                                                                                   | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Outer panel radius**          | `rounded-md` (12px)                                                                                                                                                             | Md is the right tier for a popover-class surface inside the product (workbench density, §6.1). Larger radii read as "modal" not "menu."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Outer panel padding**         | 4px — `p-1`                                                                                                                                                                     | One concentric step: outer 14 − padding 4 = inner 10. The 4px gutter is wide enough to read as breathing room and narrow enough that the popover feels efficient.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Outer panel fill**            | `--color-surface-elevated` (with optional `/95` + `backdrop-blur` for translucent variants)                                                                                     | Lightest working tone — popovers sit above the canvas.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Outer panel shadow**          | `--shadow-elevated`                                                                                                                                                             | Flat (§7): a 1px ring + a soft downward drop. **No inset gleam or platinum band** — a popover is a floating matte panel, not a sculpted slab.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Item radius**                 | `rounded-sm` (10px)                                                                                                                                                             | Concentric: outer 14 − 4 gutter = inner 10. Sm reads as a clearly-rounded affordance at row density; never drop a popover item below Sm 10.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Item box metrics**            | `gap-2.5 px-2.5 py-1.5 text-ui` — never a fixed `h-*`                                                                                                                           | This is the canonical row geometry, set by the account/settings dropdown (`sidebarMenuItemClass`). Padding-driven height (not `h-8`/`h-9`/`h-10`) keeps single-line and two-line rows on the same rhythm, and `gap-2.5` is the icon↔label gap whether or not the row has a leading icon. Every menu/dropdown item in the product matches these numbers — composer permission/model/agent/action menus, session context menu, workspace pickers, settings filters, automations picker, channel/provider selects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Item rest fill**              | `transparent`                                                                                                                                                                   | Class **L** list-item — no resting fill.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Item hover fill**             | `--color-soft` (`hover:bg-soft`)                                                                                                                                                | A same-hue tint one step darker than the panel. Class **L** semantics from §8.10.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Item active / selected fill** | `--color-soft` (often with `--shadow-ring-light` for the "selected" tell)                                                                                                       | Same hue as hover; the ring is what differentiates rest+hover from active.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Item gap between siblings**   | 2px — applied automatically by `.popover-panel > * + * { margin-top: 2px }`                                                                                                     | 2px is the floor: tight enough that items still read as one discrete list, wide enough that a hovered row's rounded-sm fill doesn't bleed into the next. Don't override with `space-y-px` / `space-y-1`, and don't add a flex `gap-*` on the panel (it would stack with this margin and double the gap) — the spacing contract lives only on `.popover-panel`. **The 2px only ever shows up between two adjacent _items_** — see the separator row for what happens at a group boundary or the panel top.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Group separator**             | `.popover-separator` — `bg-divider/70 mx-1 my-1 h-px` (a 1px solid-fill hairline, **inset 4px on each side** via `mx-1`, with a **symmetric 4px** top+bottom margin via `my-1`) | A solid `h-px` block (not a `border-t`) inset from the panel edges, so the line floats inside the 4px gutter rather than spanning edge-to-edge — this reads as a softer group break at popover density. A separator owns the whole gap around itself and **resets the 2px item chain**: the item directly below a separator gets `margin-top: 0` (`.popover-panel > .popover-separator + * { margin-top: 0 }`), so it isn't pushed down by 4px + 2px = 6px. Equivalently: when the thing above an item is a separator (or the panel's top edge), the item carries **no** extra 2px — the 2px row-gap is reserved for item-on-item only. The first child never gets a top margin (the panel's own 4px padding handles the top edge). **The separator fill is `--color-divider`, which in dark mode (`58 63 70`) sits +16 above `--color-surface-elevated` (the panel fill) on purpose** — the two were once the same value (`42 46 52` vs `42 47 54`) and the hairline disappeared inside every menu. A divider painted on the elevated tier must stay clearly lighter than it; don't pull it back toward the surface value. |
| **Item text color (rest)**      | `--color-fg` or `--color-muted`                                                                                                                                                 | Muted-on-rest is the common pattern for secondary rows; muted → fg on hover is the one exception in §8.10 where text color may change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

A worked example:

```
.popover-panel {
  background: rgb(var(--color-surface-elevated));
  border-radius: 14px;               /* Md — rounded-md */
  padding: 4px;                      /* p-1 */
  box-shadow: var(--shadow-elevated);/* flat: 1px ring + soft drop, no inset */
}
.popover-panel > * + * { margin-top: 2px; }  /* 2-px gap — item-on-item only */

.popover-separator {                 /* group boundary: inset solid hairline + symmetric 4px */
  height: 1px;                       /* h-px — a solid fill block, not a border */
  background: rgb(var(--color-divider) / 0.7);
  margin: 4px 4px;                   /* my-1 (owns the gap) + mx-1 (inset from panel edges) */
}
.popover-panel > .popover-separator + * {
  margin-top: 0;                     /* item below a separator: no extra 2px */
}

.popover-item {                      /* canonical row: gap-2.5 px-2.5 py-1.5 text-ui */
  display: flex;
  align-items: center;
  gap: 0.625rem;                     /* gap-2.5 — icon ↔ label */
  background: transparent;
  color: rgb(var(--color-muted));    /* rest is muted; → fg on hover (§8.10 exception) */
  border-radius: 10px;               /* Sm — rounded-sm */
  padding: 0.375rem 0.625rem;        /* py-1.5 px-2.5 — never a fixed height */
  transition: background-color 150ms ease;
}
.popover-item:hover {
  background: rgb(var(--color-soft));
  color: rgb(var(--color-fg));
}
.popover-item[aria-selected='true'] {
  background: rgb(var(--color-soft));
  box-shadow: var(--shadow-ring-light);
}
```

**On `--color-soft` and hover contrast.** `--color-soft` is tuned to sit ~5 units darker than `--color-rail` (light mode) and brighter than `--color-surface` so a hovered list-row inside a popover reads as "lit" without diving into the dark slab that a deeper token would produce. Earlier values pulled `--color-soft` ~20 units below `--color-surface-elevated`, which read as "selected" the moment the cursor entered the row — too loud for a quiet acknowledgement. If a hover state inside a popover feels too dark in light mode, the right fix is to lighten `--color-soft`, never to introduce a new hover token.

**Form selects are popovers too — never a native `<select>`.** The OS-rendered dropdown menu can't follow any of this contract (no `.popover-panel` surface, no Sm-10 rows, no check-selection, and the trigger fights the §6.1 control-radius rule), so a native `<select>` is banned in product UI. Every dropdown-select is the shared **`WorkbenchSelect`** component (`components/WorkbenchSelect.tsx`): the trigger is a standard short boxed control (Sm 10, `bg-surface` + `--shadow-ring-light`, `focus-visible:shadow-focus`, a **static** `--color-subtle` chevron per the chevron rule below; `size='sm'` gives the compact h-8 variant for inline filters, `mono` for technical values); the menu is a `.popover-panel` per this table (Md 14, `bg-surface-elevated` + `--shadow-elevated`, canonical `px-2.5 py-1.5` rows) with the §8.12 **popover-tier** selection language — the chosen row wears a trailing `--color-link` check + `text-fg font-medium`, and `bg-soft` is reserved for hover. Option groups (the old `<optgroup>`) render as quiet `text-caption text-placeholder` heading rows. The old `.workbench-select` CSS class (a styled native select with a background-image chevron) is removed; if you find yourself typing `<select`, reach for `WorkbenchSelect` instead.

**Disclosure chevrons: the overlay family never rotates, the inline family rotates 90°.** Two different controls both wear a chevron and they follow opposite rules, because a rotation is only worth spending when it is _directionally truthful_. An **overlay** trigger (select, dropdown, filter, popover menu) keeps a **static** `⌄` and no `transition-transform` — here the chevron is a _type mark_ ("this control drops a list"), not a state indicator. Flipping it to `⌃` while the menu is open points _away_ from the panel sitting right below it, which reads as "the list is above" — a false directional claim, and a redundant one: the open state already arrives through louder signals (the panel itself, and for an inline-joined panel the trigger's `rounded-t-*` corner). **The trigger carries no open-state treatment of its own.** A panel appearing flush against it is overwhelming feedback already; the focus ring in particular is _not_ an open-state signal — it is `focus-visible` per §8.9, so opening by mouse leaves the trigger visually untouched, which is correct. Do not add a ring, fill, or border change on `aria-expanded` to compensate. An **inline (accordion)** trigger keeps the rotation but turns **90°** — `-rotate-90` collapsed (pointing right), unrotated when expanded (pointing down) — because the content really does grow downward in the flow, so the arrow tracks its growth axis; and because an accordion trigger deliberately carries **no selected/active fill** (`transparent` at rest, `bg-soft` on hover only — a disclosure toggle is not a selectable option, and the class-L `active` fill would falsely read as "this row is selected"), which leaves the chevron as the only state marker on the row itself. A screen can also hold several accordions open at once and you scan the chevrons to find them, whereas an overlay panel is transient and exclusive, so there is nothing to scan. **Never point an overlay trigger's rest state right (`›`).** The right chevron is already spoken for by the `label … current-value ›` submenu row and by drill-in / navigate affordances, so a select that rests at `›` claims to be one of those. Static sites: `WorkbenchSelect`, the composer's chip menus (permissions / model / agent), the credentials-dialog provider dropdown, the language picker (`PreferenceControls`), the settings provider filter, the workspace-file path picker. 90° sites: the rail's section-collapse headers (`AGENTS` and friends), the sidebar agent-session rows, the concurrency keep-alive tag, the AgentNew framework / runtime pickers. **Icon _mirroring_ is a different thing and keeps its 180°** — `SidebarToggleIcon` flipping to show which way the rail will move, and every `direction === 'rtl'` mirror, are not disclosure chevrons and this rule does not touch them. Nor does it touch **action-direction arrows**: a button carrying an explicit verb whose arrow points where the action will move things — `Expand all` / `Collapse all` in the runtimes and channels lists, the terminal dock's minimize / restore — may legitimately swap `⌄` for `⌃`, because the label carries the meaning and the arrow agrees with it. This rule governs only a chevron left standing alone as a control's open/closed state.

**Menus portal to `<body>` — never `position: absolute` inside a clipping ancestor.** A dropdown menu rendered `absolute` inside its trigger's container gets clipped the moment any ancestor establishes an overflow context — the canonical failure was selects inside `ProductDialog` (its body is `overflow-y-auto`, the panel `overflow-hidden`), where the open menu was cut off at the dialog body's edge and slid under the footer. The composer chip menus hit the same wall from the other direction: their `absolute bottom-full` panels grew upward into a chat column that is itself a stack of `overflow-hidden` boxes, so opening the terminal dock (a flex sibling of `<main>`) shrank the column and sliced the top off the model panel — and because the new-chat empty state centers the composer with flexbox, the cut-off part could not even be scrolled to. Note what the panels' own `calc(100vh - …)` height caps could not fix: the viewport was still tall, it was the _clipping container_ that had gone short. The contract: the open menu is portaled to `document.body` as a `fixed` panel at `z-[110]` (above the dialog overlay's `z-[100]`), anchored to the trigger via the shared **`useAnchoredMenuPosition`** hook (`hooks/useAnchoredMenuPosition.ts`) — it optionally matches the trigger's width (`matchAnchorWidth`), caps `max-height` to the space that actually exists on the chosen side (≤288px, with `overflow-y-auto` inside), and stays invisible until first measure so nothing flashes at (0, 0). **`placement` is a preference, not a lock:** the hook flips to the opposite side when the preferred one is both too small for the panel _and_ smaller than the other side, and reports the side it settled on through `onPlacement` — for a surface whose interior has to follow the flip (a bottom-anchored submenu, an arrow), read that instead of assuming the requested side. **The panel also stays glued to its anchor through _any_ ancestor re-layout,** not just scroll and window resize: the hook puts a `ResizeObserver` on the anchor's ancestor chain, because an anchor can be moved with neither event firing and no API reports "an element moved" (dragging the terminal dock taller re-laid out the chat column while the `fixed` panel sat at its open-time coordinates, visibly detaching from its chip). `update()` compares the recomputed position against the applied one and bails before `setState`, so tracking costs one measurement per layout change rather than a re-render — and the panel re-clamps its height and flips side mid-drag as the space runs out. Because a portaled menu still bubbles React events through the dialog, it also carries `stopPropagation` on `wheel`/`touchmove` so `ProductDialog`'s background-scroll guard doesn't eat the menu's own scrolling, and outside-click handlers must check the menu ref _and_ the trigger ref (the menu is no longer a DOM descendant of the trigger). `WorkbenchSelect`, the credentials-dialog provider dropdown, and the composer's four chip menus are the reference implementations. The composer ones all go through one shared wrapper — **`ComposerMenu`** (`components/chat/ComposerMenu.tsx`), which owns the portal, the `fixed` panel, the hook wiring and the `data-placement` attribute, so `Composer.tsx` only supplies `open` / `anchorRef` / `panelRef` / `align` / the panel's class: `+` actions, permissions, model, agent switcher. Their CSS keeps only width, fill and blur — **no `absolute`, no `bottom-[calc(100%+…)]`, no `left-0` / `right-0`** (side alignment is the `align` prop, position is inline style from the hook). Any new menu that can appear inside a dialog, drawer, or scroll panel follows the same recipe instead of reaching for `absolute top-full`.

**Tooltips are not popovers.** A one-line `role='tooltip'` hover label (ShortcutTooltip) is a small text affordance, not a menu — it uses **Xs 8** (`rounded-xs`): it reads as a floating micro-label, a glyph-tier object, not a surface you work on. It carries `--shadow-ring-light` (a flat ring, no drop). Its `<kbd>` shortcut glyph is also **Xs 8**. **Timing is hover-intent, not hover-instant:** the label fades in only after the pointer has rested on the trigger for **0.5 s**, disappears immediately on pointer-out, and shows immediately on keyboard focus — a tooltip is a patient explainer, not chrome that flickers on every mouse pass. The 0.5 s wait is a **JS timer** (`setTimeout` on pointer-enter, cancelled on leave), _not_ a CSS `transition-delay`: the CSS transition clock is tied to the rendering pipeline, so frame throttling (energy saver, occlusion, load) silently stretches a long `transition-delay` past its nominal value, while a JS timer on a visible focused page fires on time. Only the short 100 ms opacity fade stays in CSS. **Native `title` attributes are banned in product UI.** The OS-rendered tooltip can't follow any of this contract (foreign surface, foreign type, OS-controlled timing), so every hover label goes through the shared **`ShortcutTooltip`** (`components/ShortcutTooltip.tsx`) — including truncated-text reveals (pass the wrapper the truncation-critical layout classes via its `className` prop) and icon-only button labels. The only `title=` allowed on a DOM node is the accessibility-required `<iframe title>` (and `<svg><title>`), which are not hover affordances; if you find yourself typing `title=` on a `<button>`, `<span>`, or `<div>`, reach for `ShortcutTooltip` instead. A _multi-line_ info popover that happens to use `role='tooltip'` but carries a structured body (MessageMetaFooter's usage / model panel) is a popover-class surface — give it **Md 14** + flat `--shadow-elevated`, per this contract.

**Dialog-style popovers** (e.g. SchedulePicker's inputs-in-a-floating-panel) keep the 14/4 outer contract but don't carry `rounded-sm` items because their contents are inputs, not rows.

**The composer model-config panel (`FrameworkModelConfigMenu`) is a full `.popover-panel`, no row-metric exception.** It's the Claude Code / Codex / Gemini model-settings panel reached from the composer model chip. Earlier it carried a bespoke dense interior (`min-h-7…12`, `text-[0.9rem]`, `px-2 py-1`) and flat inlined lists of model / effort / intelligence options on the main panel. It has been brought fully onto the standard:

- **Branch rows split by interaction type: pure-selection pops out, a management area expands inline.** The main panel is a short stack of identical `label … current-value ›` rows. They are NOT all the same interaction — match the disclosure to what the row actually does:
    - **Pure-selection rows** (`Model` / `Effort` / `Intelligence` / `Speed`) are "pick one and leave." They open a second-level `.popover-panel` **pop-out submenu**. **Open/close is click-only — never hover-to-open.** Clicking the branch toggles its submenu; clicking a different branch switches to it (one `submenu` state per framework panel, so opening one closes the previous); selecting an option closes the submenu (and usually the whole panel via `onRequestClose`); clicking outside or `Esc` closes the whole panel (the model menu's existing `handlePointerDown` / `handleKeyDown`). Hover-to-open was removed because these submenus pop out _to the left_ and contain clickable rows/buttons — hover-open then `onMouseLeave`-close produced the classic diagonal-travel mis-close (the cursor leaves the trigger before reaching the submenu) and "ghost menu on mouse-passing." The long option list lives in the submenu with its own `max-height` + `overflow-y-auto`. These submenus **anchor on the same side the parent panel opened toward, and grow away from the composer** — an anti-cutoff rule. Default: the panel opens upward from the composer (near the viewport bottom), so the submenu **bottom-anchors** (`bottom: -0.125rem`) and grows _upward_, staying inside the space the panel already occupies; a downward-growing submenu spilled off-screen when the panel sat low (a real bug we hit). When the panel itself flips below its chip (`data-placement='bottom'` — a short chat column, e.g. the terminal dock open), the submenu **top-anchors** (`top: -0.125rem; bottom: auto`) and grows _downward_ into the space that made the panel flip; bottom-anchoring there would run a long option list off the _top_ edge instead. **Rule: a submenu's growth direction is derived from the parent panel's resolved placement, never hard-coded** — which is what `onPlacement` on `useAnchoredMenuPosition` exists for. One more consequence of the parent being a height-capped scroll container: an open submenu pops out _sideways_, and `overflow-y: auto` forces `overflow-x` to `auto` too, so the panel would clip its own pop-out whether or not it is scrolling. `.chat-composer-model-menu:has(.chat-composer-model-submenu)` drops the panel's scroll back to `overflow: visible` while a submenu is open — the first level is short enough to live without one, and the submenu carries its own `max-height` + scroll for the long lists.
    - **The `Source` area is a management area** — switch source + read health + run a verify action — not a pick-one list. It does **not** pop a submenu; it renders **inline in the first-level panel**: a `Model source` title row, the `ModelSourceSwitch` segmented control, and `.chat-composer-source-panel` carrying the selected source's health card + its `Test connection` / `Check now` action. It is **always open — no disclosure toggle, and therefore no chevron.** (It was a chevron accordion earlier. If it becomes collapsible again, the trigger takes the inline-family **90°** chevron per the chevron rule above, with no selected/active fill — see that rule.) This is the deliberate fix for the "does clicking a menu item close the menu?" conflict: a pop-out menu is supposed to select-and-close, but a verify button needs to stay put to show its result — irreconcilable in one menu. Pulling the management area inline removes the conflict (there's no menu to close), and sidesteps the pop-out's diagonal-hover and off-screen-cutoff failure modes too. **Rule: if a "submenu" mixes selection with persistent actions/status, it's a management area — expand it inline, don't pop it out. Reserve pop-out submenus for pure pick-one-and-leave lists.**
    - **Accordion de-duplication** — a general rule, no longer exercised here now that `Source` is always open: when a row _does_ collapse, its trailing summary (e.g. `Manyfold · 6 models`) must be **hidden** the moment the detail below appears, leaving the row with only its label + chevron. Header-summary and expanded-detail must never display the same fact at the same time; the collapsed summary exists _because_ the detail is hidden, so it disappears the moment the detail appears.
    - Even a single-setting framework (Gemini, only `Model`) keeps the pop-out branch so the pure-selection rows read identically across frameworks.
- **Status/health is collapsed into the row it belongs to, never floated at the panel top.** Earlier the panel top carried a free-floating status dot (`10 tested` / `Test required`), a `Test provider` button, and a separate `Runtime local not verified` notice — three "verify"-flavored controls with no clear relationship. Now: the header is just the title; the `Source` branch row shows `Manyfold · 10 models` (source name + health) as its trailing value with a small dot (`SourceHealthBadge`); and the full health detail + the **Test connection / Check now** action live _inside_ the inline Source panel, under whichever source is selected. One source = one place to see its health and re-verify it. The dot carries state by color, the label spells it out (non-color signal, §4.2).
- **The selected source inside the inline Source panel is an _expanded card_, not a row with loose text under it.** When a source is selected, its title-row + description + action button share **one `bg-soft` + `--shadow-ring-light` rounded container** (`.chat-composer-model-source-card`), with the description and button inset _inside_ that container. This is the §6.3 concentric move applied for grouping: the shared fill is what makes "name, what-it-is, and re-verify button" read as one belonging-together unit. The earlier version left the description and button as flat siblings _below_ the selected row, at the same indent as the next source — so they floated, ungrouped, and looked like they belonged to no one. Unselected sources stay as plain flat `.chat-composer-model-option` rows; the 2px popover item-gap separates them from the card. **Rule: when a selected list item reveals secondary detail/actions, wrap the whole group in the selection fill — don't let the detail leak out below the highlight.**
- **Canonical row metrics everywhere.** Every option row — main panel and submenu — uses the base `.chat-composer-model-option` (`gap-2.5 px-2.5 py-1.5 text-ui`). No `text-[0.9rem]`, no `min-h-*` overrides. Two-line rows (a model with a provider-detail line) keep the stacked copy but on the same padding.
- **Fonts match the settings menu.** Row labels and panel/section titles are `font-medium`; trailing values (the `… current-value` on a branch row, including the source health badge) are `text-caption` weight-normal — lighter than the label, exactly like the settings menu's `Language … English` / `Theme … Light` rows. No `font-semibold` anywhere in the menu.

- **A read-only summary is a label:value footnote, not a filled block.** When the runtime-local source is active, the main panel shows a read-only summary of the agent's own config (`Config` — the framework's merged config/auth string; `CLI` version; `Checked` time). The earlier versions tried to make this a _card_ (first `bg-soft`, then `bg-surface-subtle`) — but **any filled, rounded box inside this menu reads as a pressable row**, no matter how light the fill. The fix was to drop the box entirely: the summary is now a **no-fill `<dl>` label:value grid**, sitting under a `.popover-separator`, sharing the panel's standard `px-2.5` inset so it lines up with every row above it. Left column = `text-placeholder` labels at a fixed width; right column = `text-muted` values (mono for the CLI version). It reads as the panel's quiet footnote — clearly _information_, impossible to mistake for a control, because it has no affordance geometry at all. The errors row uses `text-warning`. **Rule: a non-interactive read-out doesn't get a fill or a radius — give it a separator + a label:value grid on the shared inset; reserve filled boxes for things you can press.** (`bg-soft` remains correct one layer up, on the genuinely-selected source card inside the Source submenu.)

The only filled, content-shape variation left is the two-line model rows (label + provider-detail), on standard padding. Treat this panel as the reference for "a config-style menu built entirely from the standard parts": **selection is always a branch-to-submenu; status always rides on the row it describes; a selected item that reveals detail wraps the group in the selection fill; a read-only read-out is a separator + label:value grid with no fill; nothing technical floats free at the top.** The flat model list shown for _non-config_ agents is likewise an ordinary `.popover-panel` list on the canonical row.

### 8.9 Hover, focus, active

| State          | Treatment                                                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hover (button) | Change the fill — see §8.10 for the binding rule by class. Never `filter: brightness()` (it strips text contrast). No scale, no bounce, no icon translate. Text/icon color does **not** change unless the rule for that class says so.                                                       |
| Hover (field)  | Step the **ring**, not the fill: `--shadow-ring-light` → `--shadow-ring-hover`. The fill stays put — see the field-hover rule below.                                                                                                                                                         |
| Focus          | Visible focus state on every interactive element, bound to **`focus-visible`** and carried by `--shadow-focus` — see the focus-ring rule below. Never `outline: none` without a replacement.                                                                                                 |
| Active (press) | `transform: translateY(0.5px)` on buttons. No transform on cards.                                                                                                                                                                                                                            |
| Disabled       | `opacity: 0.45` + `cursor: not-allowed` + `box-shadow: none` (drop the ring so the button reads flat, not "active but greyed"). `pointer-events: none` blocks hover state from rendering. The text/icon should stay legible at 0.45 — if it's not, the rest fill is too light to begin with. |

**Every control acknowledges the pointer — but a press-target steps its fill and a text field steps its ring.** Silence on hover is a bug, not restraint: a boxed control that does nothing under the cursor reads as disabled or decorative. The split is by what the control _is_, not how it looks.

A **select trigger is a press-target** — it opens something when clicked — so it takes the §8.10 fill step anchored to its parent tier: `--color-surface-hover` on `--color-surface`. It does **not** also step its ring; per §8.10, hover changes the fill and text/icon color stays put. This is the same treatment its siblings already carry (`.workbench-btn`, the credentials provider trigger, the create-agent framework / runtime pickers), and `WorkbenchSelect` is the shared component every product dropdown routes through, so this one rule covers most of them.

A **text field is not a press-target.** Its affordance is the editable edge, so the edge is what answers the pointer: `--shadow-ring-light` → `--shadow-ring-hover`, fill unchanged. **Use the state token, not `--shadow-ring`** — at 0.12 against the 0.09 resting hairline that structural token is so close that the hover renders as no change at all, which is the bug this rule exists to fix. `--shadow-ring-hover` (0.24 light / 0.20 dark) is sized so the step is unmistakable at a glance while staying far below the focus ring's saturated core, keeping the three states legible as an ordered ladder: hairline → stronger hairline → blue core + halo. Two reasons. Filling a text field on hover makes it read as a button for as long as the cursor sits on it, which fights the one thing the control is trying to say. And keeping hover on the same property as focus means the focus ring reads as _that same edge getting louder_ — one continuous edge story instead of a fill effect and a ring effect stacking. (The landing form already does exactly this.)`.) A **bare / in-content trigger** with no box takes neither: per §8.10's inline-disclosure exception it moves color only, and when its label already sits at `--color-fg` the chevron is what steps, not the label.

Ordering matters when hover and focus share `box-shadow`: `focus-visible` must win over `hover` so a focused field doesn't drop back to the hover ring when the pointer rests on it. Tailwind emits `focus-visible` after `hover`, so the default order is already correct — do not hand-write a `:hover` rule after the focus rule.

**A control without a box still gets a ring — put it on the control, or on the wrapper, but never nowhere.** `focus:outline-none` with no replacement strands keyboard users, and it is the one focus bug that is invisible to everyone who tests with a mouse. Two sanctioned shapes:

- **Unboxed control that owns its own row** (the `bare` `WorkbenchSelect`): keep `--shadow-focus` on the element and give it **Xs 8** plus a net-zero pad — `py-0.5 -my-0.5`. The padding stops an ~20px-tall target from wearing a corner near half its height (§6.1's failed-pill rule), and the negative margin hands the space back so the surrounding row does not grow. `box-shadow` never participates in layout, so no horizontal compensation is needed; just confirm no ancestor clips overflow.
- **Seamless in-place editor** (a transparent `text-h1` title input, a full-bleed code textarea, a radio card whose `<input>` is `sr-only`): the control has no edge of its own to light up, so the ring goes on the **wrapper** — but the wrapper asks about a _descendant's_ `focus-visible`, written `has-[:focus-visible]:shadow-focus`. **Not `focus-within`.** A wrapper-level `focus-within` reduces every descendant to generic focus and loses the element-specific UA heuristic this section relies on: clicking a radio card would ring it, while clicking a text input should ring it as a mode indicator. `:has(:focus-visible)` preserves that distinction. `WorkspacePathField`'s `field` class and the create-agent framework card (`frameworkLogoButtonClass`) are the reference implementations. Use `peer-focus-visible` instead when the control is a _preceding sibling_ of the element being ringed; `peer` and `group` cannot style an ancestor, which is why these two need `:has()`. (`:has()` is Chrome 105+ / Safari 15.4+ / Firefox 121+, and already ships here — `.chat-composer-model-menu:has(…)`.) The wrapper is the thing the user perceives as "the field"; ringing the bare `<input>` inside it would draw a box where the design deliberately removed one. `.chat-composer-card:focus-within` still binds the older way and paints a hand-rolled stack rather than `--shadow-focus` — it is not the shape to copy.

- **Full-bleed field inside a clipping parent** (the skill editor filling a `.settings-card`, which carries `overflow-hidden`): an outset ring would be cut off at the card edge, and `focus-within` on the card is wrong because the card also holds a toolbar — tabbing to a toolbar button would light up the whole card. Use **`--shadow-focus-inset`**, the same core + halo drawn inward. Reach for it only when an outset ring would genuinely be clipped; outset stays the default everywhere else.

**Text fields are the low-severity case, not the exception.** For an `<input>` or `<textarea>` the caret already satisfies "focus is visible" (WCAG 2.4.7 accepts the text cursor as the indicator), so a missing ring there is polish, not a barrier. It is a **`<button>`** styled `outline-none` with no replacement that strands keyboard users outright — nothing on the control changes and there is no caret to fall back on. Rank fixes accordingly: unringed buttons first.

What is **not** sanctioned is the option those shapes exist to prevent: a control with `focus:outline-none` and no treatment anywhere — on itself, on its wrapper, or inset.

**Compensating the ring's breathing room.** A ring needs a little space or it sits on the glyphs, but adding padding to a seamless field would shift its text out of alignment with everything below it. Pay for the padding with a matching negative margin — `px-1.5 -mx-1.5`, `py-0.5 -my-0.5` — so the text stays exactly where it was and only the ring extends outward. Two cautions: skip the vertical pair on a field with an explicit height (`h-[…]`), where `box-sizing: border-box` absorbs the padding and the negative margin would shift the layout instead of cancelling; and `box-shadow` never affects layout, so no compensation is needed for the ring itself — only for the padding you added to make room for it.

**The focus ring is `focus-visible`, never `focus` — and the ring is a core + halo, not a slab.** Two separate rules, both binding.

**Bind to `focus-visible`.** A focus ring is the keyboard user's cursor; spending it on a mouse click is spending it where it carries no information. A `:focus` binding leaves a saturated ring parked on a select trigger or a segmented button long after the click that caused it, which is the "why is this thing outlined" reading. **You do not need to hand-write the button/input distinction** — `:focus-visible`'s UA heuristic already draws it: an element that takes keyboard input (`input`, `textarea`, `contenteditable`) matches on _mouse_ click too, because the user is about to type; `button`, `a`, `select` triggers and `div[tabindex]` do not. So a text field keeps its ring on click — correctly, since that ring is a **mode indicator** ("your keystrokes land here"), not a focus indicator — while a button stays clean until someone Tabs to it. One pseudo-class gets both behaviours; an `if` over element types gets it wrong.

**Shape the ring as a 1px core + a low-alpha halo** (`--shadow-focus`), not `0 0 0 2px` at full opacity. The ring shares the `box-shadow` property with `--shadow-ring-light`, so a 2px opaque ring _replaces_ the resting hairline and the control jumps 1px→2px and 9%-grey→100%-blue in one frame: two simultaneous jumps read as a different control, not as the same control entering a state. The core stays fully opaque so the indicator itself holds its own contrast (4.02:1 on paper — WCAG 1.4.11 asks 3:1); dropping the core to a low alpha to "soften" it would fail that. Softness comes from the halo instead, so the ring gains **volume rather than thickness**. The halo alpha is tuned per theme (0.18 light / 0.26 dark) — a low-alpha light value over a near-black canvas gets eaten by the same perceptual compression the hover tokens are tuned around. Any control that shows the ring also needs `box-shadow` in its transition list (`transition-shadow`, or `transition-[color,background-color,box-shadow]` when it also changes fill) — `transition-colors` does **not** cover `box-shadow`, and an untransitioned ring pops in on frame zero.

### 8.10 Button taxonomy and the unified hover rule

Every interactive press-target in the product falls into one of **five button classes**. The system enforces a single mental model: **a button's hover treatment is determined by its class, never by feel or context**. If two adjacent buttons feel like they need different hover treatments, one of them is the wrong class.

The binding rule across all five classes:

> **Hover changes the fill by exactly one step in the same hue family. Text and icon color stay put.** The only exception is the _ghost_ class, which has no rest fill and therefore must reveal one on hover — see G below.

This rule eliminates the temptation to "brighten the icon on hover" or "darken the text on hover," which previously produced a different hover for every button in the app.

#### The five classes

| Class                         | Shape                                                              | Rest fill                                           | Rest text/icon                  | Hover fill                                                                                                                                                                                                   | Use                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P** Primary tactile         | Pill (identity) / **Sm 10** (working) — §6.2                       | `--color-strong`                                    | white / deep ink                | `--color-strong-hover` — one step toward the canvas in both modes                                                                                                                                            | The one main action on a surface. Only one per row. **Primary inverts the direction rule** — see §8.1 note.                                                                                                                         |
| **S** Secondary tactile       | Pill (identity) / **Sm 10** (working) — §6.2                       | `--color-surface`                                   | `--color-fg`                    | `--color-surface-hover` — one step toward the page floor                                                                                                                                                     | The companion to a primary, or a stand-alone moderate action.                                                                                                                                                                       |
| **G** Ghost icon / ghost text | Circle (icon — always) / **Sm 10** (text); tiny inline text → pill | `transparent`                                       | `--color-muted`                 | Same-hue token anchored to the row's parent: `--color-surface-hover` on `--color-surface`; `--color-rail-hover` on `--color-rail`; `--color-soft` on `--color-surface-elevated`                              | Compact rail icons, menu trigger chevrons, tab switchers, in-row affordances. Reveal a fill on hover; text/icon color stays `--color-muted`.                                                                                        |
| **L** Inline list item        | Md radius row                                                      | `transparent`                                       | `--color-fg` or `--color-muted` | Background-dependent: `--color-soft` inside a popover (`--color-surface-elevated`); `--color-rail-hover` inside the sidebar rail (`--color-rail`); `--color-surface-hover` inside a card (`--color-surface`) | Menu rows, list-row hit-targets inside popovers and the rail. Always full-row, never a separate icon-button. **Pick the hover token whose value sits ~14–17 units away from the row's _parent_ background, not the global canvas.** |
| **D** Danger                  | Pill (identity) / **Sm 10** (working) — §6.2; icon-only → circle   | `transparent` (ghost) or `--color-surface` (filled) | `--color-workflow-ship`         | `--color-danger-bg` (light) / `--color-danger-bg` (dark — slightly higher alpha)                                                                                                                             | Destructive actions only — delete, sign out, remove, force-stop. Never used for non-destructive emphasis.                                                                                                                           |

**Why exactly five and not more:** every product button you can name in this app maps to one of these. Toolbar chevrons → **G**. Send button → **P**. "Show all" link → **G**. Composer "+" → **G**. Menu item → **L**. Delete agent → **D**. Sidebar new chat (with text) → **S**. Sidebar collapse → **G**. If you're tempted to invent a sixth class, you're almost certainly reaching for a primary-like emphasis on a non-primary action, which is the wrong move.

**The one exception — inline text link / disclosure triangle inside flowing content.** Anchors (`<a>` styled `text-link`) and inline disclosure rows that sit inside a paragraph or message body (the kind that say "Process logs ▾" and toggle a child block) follow typographic anchor convention: text color only, no hover background. Adding a fill behind a 14px line of in-content text reads as a UI box landing inside prose, which breaks reading flow. This exception applies _only_ to text that sits inline within copy. Any text button outside a flow context (e.g. a settings link in a side rail, a "Manage" affordance next to a heading, a CTA in a card) is a class **G** ghost-text button and gets the standard G hover.

#### The hover-fill-only rule, restated

For every class:

- **Hover changes only the fill.** Text/icon color is unchanged.
- **The fill moves by one same-hue step, _away from the page floor_.** In **light mode**, away-from-floor means _darker_ (toward `--color-surface-hover`) — hover pulls the surface down toward the page floor. In **dark mode**, away-from-floor means _lighter_ (toward `--color-surface-elevated`) — hover lights the surface up. **Primary is the one exception** because its rest fill already sits at the extreme end of the ramp (ink in light, near-white in dark); hover then moves toward the opposite end for visible headroom (see §8.1).
- **No ink-tint hovers (`hover:bg-black/[0.05]`).** This pattern is the residue of the warm-paper era and produces a different perceived shade on every surface it sits on. Always reach for `--color-surface-hover` / `--color-soft-hover` / `--color-soft` instead — those tokens carry the same-hue contract by construction.
- **No "icon-darkens" hovers (`hover:text-fg` alone).** A color-only hover on a transparent button gives a weak signal and forces the eye to verify the change. Reveal a fill instead; the icon color stays as `--color-muted`.
- **Industry convention this matches.** macOS Big Sur+ list rows, Linear's row hovers, Vercel dashboard rows, Notion blocks — all use the same direction (light = hover darker, dark = hover lighter). Inverting it in either theme reads as "wrong" to muscle memory, even when users can't articulate why.

#### The decision table for "what hover do I use?"

When in doubt:

1. **Is this the single main action on this surface?** → Class **P**. `hover:bg-strong-hover`.
2. **Does this button have a rest fill that distinguishes it from the canvas?** → Class **S**. `hover:bg-surface-hover`.
3. **Is this a compact icon-only or text-only button with no rest fill?** → Class **G**. Pick the hover token by **what background it sits on**: `hover:bg-surface-hover` on a card or composer (`bg-surface`); `hover:bg-rail-hover` on the sidebar rail (`bg-rail`).
4. **Is this a row inside a menu, popover, or list?** → Class **L**. Pick by background: `hover:bg-soft` inside a popover (`bg-surface-elevated`); `hover:bg-rail-hover` inside the sidebar rail (`bg-rail`); `hover:bg-surface-hover` inside a card (`bg-surface`).
5. **Does this action destroy or sign-out?** → Class **D**. `hover:bg-danger-bg` (or `hover:bg-danger-hover` if rest is already `--color-danger-bg`).

**The picking rule, restated as one sentence:** _match the hover token to the row's parent surface, not to the conceptual button class alone._ `bg-rail` parents get `hover:bg-rail-hover`; `bg-surface` parents get `hover:bg-surface-hover`; `bg-surface-elevated` parents get `hover:bg-soft`. All three are visually equivalent (≈12–19 RGB delta in the same hue — the numeric spread widened when the ramp moved toward white, where an identical step buys less perceived contrast), so the choice is mechanical once you know the parent. One parent has no hover token of its own: a ghost button resting directly on the chat canvas (`bg-main`) borrows the user-bubble pair — `hover:bg-surface-subtle` in light, `dark:hover:bg-surface` (see the inline message-action row in the §6.2 shape table).

**Toggle buttons: "open" is a state, not a promotion to primary.** A button whose job is to show that a panel or mode is currently on (the chat-header panel toggles for the runtime viewer / file tree / preview / background tasks) marks its active state with the **selected fill** — `bg-surface-hover` + `text-fg` in light, the same token in dark — never `bg-strong`. An inverted ink fill on a toggle claims primary-action weight for what is merely "this view is open," and on the near-white header it becomes the heaviest object on the page. This is the same family as the §8.13 tab convention (selection = filled chip, not inversion). `bg-strong` stays reserved for class P: the one true action on the surface.

#### The icon-only G button (`.btn-icon-ghost`)

This is the rail-collapse button, the composer "+" button, the chevrons, the close-X. Anatomy:

```
.btn-icon-ghost {
  background: transparent;
  color: var(--color-muted);
  border-radius: 9999px; ← always a circle: rounded-pill clamps a square 32–40px box to a perfect circle (§6.2). Never rounded-md on an icon-only button.
  width: 32–40px; height: 32–40px;
  transition: background-color 150ms ease;
}
.btn-icon-ghost:hover {
  background: rgb(var(--color-surface-hover));   ← one same-hue step from the canvas
  color: var(--color-muted);                     ← unchanged
}
.btn-icon-ghost[data-active='true'] {
  background: rgb(var(--color-surface));
  color: var(--color-fg);
  box-shadow: var(--shadow-ring-light);
}
```

The icon color staying `--color-muted` on hover is intentional. The fill reveal is the hover signal. If the icon also brightens, you're double-counting the signal — and on a transparent rest button, the brightened icon against a faintly-tinted fill reads jittery.

For an _active_ (selected) state of a G button — e.g. the currently-open agent in the rail — the fill steps up to `--color-surface` and the icon goes `--color-fg`. Active is the only state where the icon color changes; hover never changes it.

#### The L list-item button (`.btn-list-item`)

This is the menu row, the popover option, the sidebar nav entry. Anatomy:

```
.btn-list-item {
  background: transparent;
  color: var(--color-fg);            ← or --color-muted for secondary items
  border-radius: 12px; ← rounded-md
  padding: 8–10px horizontal, 6–10px vertical;
  transition: background-color 150ms ease;
}
.btn-list-item:hover {
  background: rgb(var(--color-soft));   ← softer than surface-hover; rows are not chips
  color: var(--color-fg);                ← muted items darken to fg on hover (the one exception)
}
.btn-list-item[data-active='true'] {
  background: rgb(var(--color-soft));
  color: var(--color-fg);
  box-shadow: var(--shadow-ring-light);
}
```

The list-item is the only class where icon/text color _may_ change on hover — `--color-muted` → `--color-fg`. The reason: a list row's hover background is intentionally faint (`--color-soft`, not `surface-hover`), because rows are full-width and a strong fill on every hover would feel like the list is flashing. The text darkening compensates for the quieter fill.

`--color-soft` is tuned to sit ~17 units below `--color-surface-elevated` (light) / ~16 units above (dark) — the popover-tier delta. A row-hover should feel like a same-hue whisper of the surrounding chrome. If a popover-item hover starts to read as a "selected" state on first cursor entry, retune `--color-soft`, don't introduce a new hover variable. For row hovers on `--color-rail` or `--color-surface`, use `--color-rail-hover` / `--color-surface-hover` respectively — those are tuned to the same perceived delta against their own background.

#### What this kills

The following patterns are now anti-patterns and should be removed wherever they appear:

- `hover:bg-black/[0.03]` / `[0.035]` / `[0.04]` / `[0.05]` / `[0.06]` on any button. Replace with the right class token.
- **`hover:bg-soft` on a `bg-rail` parent** (the sidebar agent rail). `--color-soft` is anchored to `--color-surface-elevated`; on `--color-rail` it ends up only ~2 units darker than rest, which reads as no hover at all. Use `hover:bg-rail-hover` on `bg-rail` parents.
- **`hover:bg-soft` on a `bg-surface` parent** (composer card). For the same reason — soft is too close to surface; use `hover:bg-surface-hover`.
- `hover:text-fg` without an accompanying fill change on a non-list button. Add the fill, or convert to class **L** if it really is a list row.
- `hover:bg-white` (and `bg-white/70`, `bg-white/78`). The `white` literal predates the token palette. Use `bg-surface` / `bg-surface-hover` instead.
- `hover:opacity-*` as a hover signal on a button. Reserve opacity for transient enter/leave reveals, never as the hover state itself.
- Hover treatments that change icon color but not fill (e.g. only `hover:text-fg` on a transparent icon button). The fill must always carry the signal.

### 8.12 State tags, selection, and the "set default" pattern

A list row can carry up to three different signals, and they were historically conflated into one indistinct mess of tags — all-caps mono `SELECTED` chips, `Managed`/`Built-in`/`Custom` chips that _also_ carried a shadow, a saturated `bg-link` `Current default` pill, and a `Set default` button styled so much like the selected-row fill that the two were indistinguishable. The fix is to recognise that these are **three separate roles** and give each exactly one treatment. Never invent a fourth.

| Role               | What it answers                                                                              | Treatment                                                                                                                                                                                                                                             | Never                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Selection**      | "Is _this_ the row I picked?"                                                                | A trailing **`CheckIcon`** in `--color-link`. Whether the row _also_ wears the §8.10 active fill depends on the surface tier — see the fill-ownership rule below. No text.                                                                            | A `SELECTED` text chip. The check + active fill already say it; a word on top triple-counts.                                                                         |
| **Classification** | "What _kind_ of thing is this row?" (Managed / Built-in / Custom provider; a protocol label) | A single **quiet tag**: flat `bg-soft`, `inset 0 0 0 1px var(--color-divider)` ring, `text-muted`, `text-caption`, **Capitalized sans**, **no shadow, no uppercase, no mono**. This is the §8.3 pill rule applied to a metadata tag.                  | A shadow (§8.3 — tags never get one), ALL-CAPS, or `font-mono`. Mono is reserved for technical signal (§5); a human-readable category label is not technical signal. |
| **Active value**   | "Which row is the current default / the live value?"                                         | A trailing `--color-link` text label naming the role + a `CheckIcon` (e.g. `Current default ✓`). "Currently the default" and "currently selected" share the same mark, but a default list needs the **word** too — see the disambiguation rule below. | A filled `bg-link text-white` pill. A saturated fill makes a status read-out compete with real primary buttons.                                                      |

**The check is the single selection language across the whole product** — but a bare check is only unambiguous when the surface _already_ reads as a picker. Provider dropdown, model-default list, any "pick one of N rows" surface: the chosen row gets a trailing `--color-link` check. A user who learns it once reads it instantly elsewhere. This replaces every bespoke `SELECTED` / `bg-link` tag.

**Fill ownership splits by surface tier: in a popover, `bg-soft` belongs to hover; in a static list, it belongs to selection.** Both tiers keep the check — only the background changes hands. The reason is that the two surfaces rank their two facts in opposite orders. A **popover menu** is transient and pointer-driven: it exists for the seconds your cursor is inside it, and the question it must answer instantly is _"which row am I about to commit to?"_ — so **the pointer must be louder than the selection**. A **static list** (provider cards, the model row-list, any pick-one list living in the page) is persistent and scanned: you arrive at it to read off the current value, so **the selection must be louder than the pointer**. Giving both tiers one treatment necessarily starves one of them — and the failure was concrete: because `bg-soft` was _both_ the selected fill and the hover fill, a menu's selected row had **no hover response at all** (it already wore the fill, and nothing overrode it), while a hovered unselected row rendered nearly identically to the selected one. The pointer, the more urgent fact, lost.

So: **popover rows** (`WorkbenchSelect`, the composer model / permission menus, the credentials provider dropdown, the language pickers, the sidebar filter menu, the workspace path picker) mark selection with the check + `text-fg font-medium` and leave `bg-soft` to `hover:`. **Static rows** keep the §8.10 active fill (`bg-soft` + `--shadow-ring-light`) alongside the check. This is not a second selection language — the check is still the only selection mark, and `font-medium` is the §4.2 non-color companion signal. It is one rule about who owns the background. Note that a popover row therefore **must** carry a check: with the fill reassigned to hover, removing the check leaves selection unmarked entirely.

**Disambiguation rule — a check needs a context that says "this is a chooser."** A lone check icon can read as _selected_, _verified_, _enabled_, or _available_ depending on the surface. It is self-explanatory only when the surrounding chrome already frames the list as a single-choice picker (a dropdown the user just opened by clicking "Change", a radio group). On a **flat card embedded in a form** — where the same list could plausibly be a read-only capability list — the bare check misfires: users read "Supported models · 5/5 ✓" as "these 5 are supported," not "pick the default." Two coordinated fixes, both required, neither alone sufficient:

1. **The card title must name the _action/role_, not the _capability_.** Title the card after what choosing does — `Default model` ("Used when this agent runs") — not after the set it contains (`Supported models`). The supported/available count moves to the subtitle so the capability info isn't lost. A title that describes the rows' _category_ invites a passive read; a title that describes the _decision_ invites an active one.
2. **The active row pairs the check with the role word** (`Current default ✓` in `--color-link`), so the check's meaning is spelled out exactly once, on the one row that carries it. This is the §4.2 non-color-signal rule applied to selection: the color+icon say "this one," the word says "…is the default."

Where the surface is _already_ an unmistakable picker (the provider `Change` dropdown), the bare check + active fill is enough and the word is omitted — adding it there would be noise. **The test: if you can imagine a user reading the list as read-only, add the role word; if the surface only exists to make a choice, the check alone suffices.**

**"Set default" is not a per-row button.** The old design put a `Set default` outline button on _every_ non-active row, so the list was a column of near-identical buttons and the eye couldn't find the one that mattered. The rule: **in a pick-one list, the row itself is the control.** The whole row is the click target (class **L** hit-target, §8.10); selecting it moves the default there. The active row shows the role word + check (`Current default ✓`); inactive rows show nothing but reveal the standard class-L hover fill. There is no repeated verb on every row — "click a row to make it the default" is the affordance, the same as every other selection list in the product, and the named-active-row + action-titled card (the disambiguation rule above) is what tells the user the list is a chooser. A disabled row (can't be chosen yet) shows a quiet classification-style tag stating _why_ (`Needs test`, `Unsupported`) instead of the check — that tag is information, not a control, so it never looks pressable.

**One control per fact — never two widgets for one value.** The "Default model" picker is the canonical case: the model-provider dialog once had _two_ controls writing the same `model` field — a `Default model` `<select>` inside the Claude mapping card **and** the full `Default model` row-list below it. Two widgets bound to one piece of state is a single-source-of-truth violation: changing one silently moves the other, and the duplicated "Default model" label reads as two different settings. The rule: **when a value already has a rich picker (the row-list with availability counts, disabled reasons, and `Current default ✓`), that is the only control for it — don't add a second, weaker `<select>` for the same field.** A framework-specific _companion_ setting that belongs _to_ the default model (Claude Code's reasoning **Effort**) sits **directly below the picker list** as a labelled footer row, injected via a slot — close to the model it modifies, and kept out of the header so the header stays just "title + Test provider" identically across frameworks. Codex passes no slot and shows no footer row — the shared `AgentModelsCard` carries the per-framework difference as an optional `footerAccessory`, never an internal `if framework === …`. This keeps Claude and Codex on one component while each shows only the controls it owns.

**A scope/mode switch belongs one level up, not inside the surface it switches.** The **Model source** toggle (Manyfold platform config vs. the agent's own Local CLI config) was briefly placed inside the _Model provider_ editing dialog — but that dialog's job is "fill in the Manyfold provider + model mapping," and a `Local config` choice means "ignore everything in this dialog." A control that says "don't use this surface" sitting _inside_ that surface is self-referential and inverts the hierarchy (it gates whether the Provider/mapping/default sections below it even apply, yet rendered as a peer _below_ the Provider row). The switch now lives on the agent's **Model provider tab** (the read/config surface, `AgentDetails`) as the `Model source` row — flipping it persists immediately and re-renders the tab; the dialog stays single-purpose. **Rule: a mode/scope selector that determines whether a configuration surface applies lives in the parent that owns that surface, not within it.**

**Frameless grouping inside a modal.** Sections _inside_ a dialog (the modal is already an elevated Md 14 surface) are grouped by a **`text-ui text-fg font-medium` title + whitespace**, not by wrapping each one in its own `bg-surface shadow-card`. Stacking filled+shadowed cards inside an already-elevated modal produces surface-on-surface-on-surface and the "too many frames" reading (§2 _one material, two volumes_). The only element that keeps a visible boundary is a genuine **pick-one row-list**, which gets a _light_ `rounded-md border border-divider/60 + divide-y` container (so the selection picker reads as a discrete chooser per the rule above) — never the heavier `shadow-card` treatment. Inline inputs/selects keep their own `shadow-ring` (they need a pressable edge); everything else relies on the group title and the body's vertical rhythm.

**Label ladder inside a filled card.** A multi-section card on a working surface (create-agent, settings panels) has exactly four label tiers — do not collapse two into the same style, and do not invent a fifth. **Card title → `text-h3` (`CardHeader`)**: the panel's identity; `text-h3` already bakes weight 500, so no `font-medium`. Titling a card `text-ui font-medium` is the collapse bug — it renders identically to a field label and to an option-row title, so the frame's own header reads as just another row (the create-agent "which one is the title" failure). **Option-row title → `text-ui font-medium text-fg`**: the picked/pickable row inside a chooser. **Field label → `.workbench-field-label`** (`text-ui text-muted font-medium`): sits directly above _exactly one_ control (`Framework`, `Model provider`, `Name`, `Fable`, `Workspace`). **Group label → `.workbench-group-label`** (`text-caption text-subtle font-medium`, sentence case): heads a set of ≥2 sibling blocks — a list of option rows or a matrix of sub-fields (`Create new`, `Or reuse existing`, `Claude model mapping`). The whole ladder is `18 → 14-fg → 14-muted → 12-subtle` — each tier differs from its neighbour in size _or_ role, never in color alone.

**Assign the label style by _role_, not nesting depth** — the split is single-control (field label) vs group-of-siblings (group label). A single-control sub-field keeps the sentence-case field label even when it lives three levels deep (the model-mapping selects are `Fable / Opus / Sonnet / Haiku`, not eyebrows); a group header stays a group label even when it heads full-size option rows below it. **Do not use `.workbench-kicker` (all-caps) as an in-card group header.** The all-caps kicker is for short standalone _section/page eyebrows_ (`Command`, `Repositories`, settings section stamps) where one or two words carry it; over multi-word phrases inside a card it reads as shouting and fights the sentence-case rows around it (§8.12 no-shouting rule, applied to cards). Inside a card, group headers are the quiet sentence-case `.workbench-group-label`; it reads as a header (not the info-footnote it shares a size with) by position — it sits _above_ its group with a gap, while a footnote sits below with an info glyph — and by its `font-medium` weight.

**One reusable tag style.** Both the classification tag and the disabled-reason tag are the **`.tag tag-neutral`** classification tag from the §8.3 product tag family — flat `--color-tag-bg` fill + `text-muted` + `text-caption`, Capitalized sans, no ring, no shadow. A tag that reports a _problem_ (`Unsupported`, `Needs test`) steps up to the toned, dot-less variant (`.tag-warning` / `.tag-error`) instead of a bespoke text-color override. Everything else about the tag is identical so the product reads as one system. (The old standalone `.status-tag` class is removed — see §8.3 for the full family.)

**Why no uppercase, no mono on tags.** ALL-CAPS reads as shouting at workbench density, and `Managed` / `Built-in` / `Custom` are plain English categories, not agent IDs or model names — mono there dilutes the "mono === technical signal" contract (§5) until nothing reads as technical. Sentence/Capitalized case in Geist sans is the quiet register a metadata tag should sit in.

### 8.13 Tabs & segmented navigation

A **tab navigation** — the docs top-nav (`Guides / API reference / Changelog`), a settings tab switcher, an appearance toggle, a type-filter row, or an agent-detail rail — is a _pick-one_ control whose options either sit side by side on a shared bar or stack in a narrow vertical rail beside the content panel. Vertical rails are reserved for content-dense detail workspaces where the panel takes the full remaining width; below the desktop breakpoint they collapse back to a horizontal strip. Selection is always carried by a **filled active chip** (never an underline, never a colored label alone): the chosen option is a solid chip, the others are `--color-muted` (≈60% ink) text on a transparent chip that reveal the same-tier hover fill (§8.9) on hover. What differs — and it splits exactly along the §6.2 register line — is whether that fill carries a **1px ring**.

| Register                 | Surfaces                                                             | Active tab                                                                                                                                                                                                                            | Rest                                                 |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Identity / frame**     | Landing nav, the **docs header**, marketing bars                     | **Fill only — no ring, no border, no shadow.** A pill filled one tone _above_ the bar (`--color-surface` over the `--color-main`/rail header), label full-ink. The tonal step is the entire signal.                                   | Transparent chip, `--color-muted` text               |
| **Working / management** | Settings tabs, agent-detail tabs, the appearance toggle, filter rows | **Fill + `--shadow-ring-light` ring** — the §8.10 selected tell. `bg-soft`/`--color-surface` segment, often inside a recessed `--color-surface-subtle` **track** (Md 14 container, Sm 10 segments — the §6.2 / §6.3 concentric pair). | Transparent (or track-bg) chip, `--color-muted` text |

**Why the ring splits by register, not a flat "always/never".** On an **identity/frame bar** the strip must read as one soft, branded switch; a per-tab ring boxes each option into a separate button and fractures the strip, and the frame bar has no competing chrome for the fill to fight, so the tonal step alone is an unambiguous "you are here" (this is the docs-header pattern — a ring there was removed as redundant). On a **working surface** the tab sits amid many other ringed flat-finish objects (inputs, cards, list rows), and a bare fill with no ring reads as a transient hover rather than a persistent selection — so the ring earns its place as the persistence tell, exactly as it does for the §8.10 selected row. Same instinct as §6.2's pill-vs-box split: the _surface register_, not the component, decides the chrome.

**Tab vs. list-row selection.** Both are pick-one, but orientation alone does not define the control. A **tab navigation** swaps an adjacent content panel, keeps tab semantics, and marks the active option with fill (+ ring only on working surfaces); it never adds a trailing check. A **list** selects a value or object (provider/model pickers, popover items) and marks it with a trailing `--color-link` check, plus fill + ring **only on the static tier** per the fill-ownership rule above (§8.10 / §8.12). The test is behavioral: **switches an adjacent panel → tab; chooses a value/object → list.**

Shape follows §6.2 (pill on identity/frame bars, Sm 10 segments on working surfaces); fill/hover tones follow the §8.9 direction rule. Vertical working rails use full-width, left-aligned segments with only a quiet divider between navigation and panel—no enclosing card or extra surface. The identity/frame treatment is mirrored in `apps/docs/src/styles/global.css` (`.docs-nav-link` / `.docs-nav-link-active`) so the marketing docs and the product read as one system (§3.1).

### 8.11 Modals & dialogs

A modal is a **trapping overlay** — it blocks the canvas until the user acts. The system uses modals sparingly (§10.5: modal is severity-4, the last resort), so when one appears it must read as a deliberate, weighty surface: the canvas dims, the page recedes, and the dialog sits on its own elevated layer. **Product modals wear the flat finish** (§7): solid `--color-surface` fill, a 1px ring, and `--shadow-elevated` (a soft drop), with **no inset gleam or platinum band** — the backdrop dim, not a sculpted surface, is what gives the dialog its weight.

**Two finishes, two volumes.** Modals follow both the finish split (§7) and the radius split (§6.1):

| Surface                                       | Outer radius                                 | Finish                                                                       | Backdrop blur                                                | Inner radii available                                                                                                                       | Corner screws |
| --------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **Product modal** (workspace, settings, auth) | Md **14** (`workbench-panel` → `rounded-md`) | **Flat** — solid fill + 1px ring + `--shadow-elevated`, no gleam, no texture | 8–10px + ink overlay at 0.32–0.40 (light) / 0.55–0.62 (dark) | Md 14 (sections), Sm 10 (rows, chips, **buttons**, **form controls — inputs/selects/textareas**), Pill / circle (status, icon-only buttons) | No            |

Product modals match the product card ceiling — Md 14 — and never go above it.

**Product modals top out at Md 14**, like every other product surface; only the chat composer (18) sits above it.

#### Backdrop

The backdrop has two jobs: (1) dim the canvas hard enough that the eye snaps to the dialog, and (2) blur enough that any text behind it becomes unreadable so it doesn't compete for attention. A weak backdrop (alpha < 0.30, blur < 6px) leaves the page text legible, which makes the modal feel "floating on top of work" instead of "the work paused."

```
.modal-backdrop {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0, 0, 0, 0.36);     /* light mode: ink at 0.36–0.44 */
  /* dark mode: rgba(0, 0, 0, 0.60–0.68) */
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  display: flex; align-items: center; justify-content: center;
  padding: 24px 16px;
  overflow-y: auto;
  animation: modal-fade 180ms ease;
}
```

The backdrop fill is **black/ink, not a tinted hue** — modals dim the page uniformly, they don't push the canvas toward a color. Tinted backdrops (cool platinum at 0.3, info-blue at 0.2) were tried and rejected: they read as "this dialog has a meaning" when the meaning should come from the dialog content, not the canvas treatment.

Backdrop dismiss: clicking the backdrop closes the modal _unless_ the dialog has unsaved destructive input (e.g. a half-filled form where data loss matters). For most product modals, backdrop-click + Esc both close. The signup-gate modal is one of these. For destructive confirmations (delete agent, sign out), only Esc + an explicit Cancel button close — the backdrop is non-dismissive.

#### Dialog surface

A modal is a **card at one tier above the canvas**. A **product modal** uses the flat finish (§7): solid `--color-surface` fill + a 1px ring + `--shadow-elevated`'s soft drop — nothing inset. Landing modals are specified in `DESIGN.landing.md`.

| Tier         | Use                                                                         | Width (max) | Padding | Shadow              |
| ------------ | --------------------------------------------------------------------------- | ----------- | ------- | ------------------- |
| **Sm modal** | Confirmation, sign-out, single-action prompt                                | 420px       | 24px    | `--shadow-elevated` |
| **Md modal** | Edit a single thing — rename, single-field form, simple picker              | 520px       | 28px    | `--shadow-elevated` |
| **Lg modal** | Multi-field form, multi-section content (signup gate, checkout, multi-step) | 560–620px   | 32px    | `--shadow-elevated` |

Product modals use one flat token (`--shadow-elevated`) at every tier — the lift doesn't grow with size because a flat panel reads as floating from its drop + ring regardless of footprint. All tiers use the same outer radius for their volume (Md 14) — modal width changes, not corner curvature. The dialog max-width never exceeds 720px; beyond that, the work belongs on a page route, not a trapping overlay.

The dialog fill is the standard elevated surface — `--color-surface`. **Never** the recessed app-bg tone, and never the popover/hover tone (`--color-surface-elevated`) — it would conflict with input fills nested inside.

```
.modal-surface {
  position: relative;
  width: 100%;
  max-width: 560px;                    /* per tier */
  background-color: rgb(var(--color-surface));
  border-radius: 12px; /* Md — the product ceiling */
  padding: 32px;                       /* breathing room — modal is hero density */
  box-shadow: var(--shadow-elevated);
  /* A PRODUCT modal is flat instead:
       background-color: rgb(var(--color-surface));
       border-radius: 14px;
       box-shadow: var(--shadow-elevated);   1px ring + soft drop, no inset */
}
```

#### Header anatomy

A modal has three header parts, in order:

1. **Eyebrow chip** (optional) — a small pill that gives the modal its category ("Manyfold Beta · Invite-only", "Confirm sign-out"). A flat soft chip — `--color-surface-subtle` fill, no ring. Eyebrows are not required on every modal — skip them when the title alone reads cleanly.
2. **Title** — `text-h2` size (1.5rem / 24px) at `--color-muted`, weight 500, letter-spacing -0.015em. One line preferred; two lines acceptable.
3. **Subtitle** (optional) — `text-body` (15–16px) at `--color-muted`, line-height 1.5. Up to two lines of clarifying context.

The header takes a single block of vertical rhythm (gap-2 / 8px between eyebrow→title, title→subtitle). It is **not** visually separated from the body by a divider — modal bodies are short enough that one continuous reading flow works better than fractured sections.

#### Close affordance

Every modal has a close button in the **top-right corner of the dialog**, 16px inset from both edges. It is a class **G** ghost icon button (§8.10) — pill, transparent rest, `--color-muted` icon, `--color-surface-hover` on hover.

```
.modal-close {
  position: absolute; top: 16px; right: 16px;
  width: 32px; height: 32px;
  border-radius: 999px;
  background: transparent;
  color: var(--color-muted);
  display: inline-flex; align-items: center; justify-content: center;
  transition: background-color 150ms ease;
}
.modal-close:hover {
  color: var(--color-muted);
}
.modal-close svg { width: 16px; height: 16px; }
```

The close button never carries a label, never gets a shadow, and is the only chrome at the top of the dialog. Its existence is the user's reassurance that the modal is dismissible — never hide it under "Esc only" semantics, even for non-destructive modals. The right way to enforce intentionality is a confirmation step, not a missing X.

#### Body density

Modal body is **forms or text**, never a dense data grid. The vertical rhythm inside a modal body matches a settings card:

- Between unrelated field groups: 20–24px gap.
- Between a label and its input: 8px gap.
- Between an input and its help text: 6px gap.
- Around a section heading inside the body (rare — most modals only have one section): 16px top, 12px bottom.

If a modal needs more than three field groups, it's almost certainly the wrong surface — promote to a page route. The exception is the gated-signup pattern (email + use-case + tool selection), where three groups is the natural shape of the work.

#### Form components inside a modal

Inputs, radios, and chips inside a modal use the same anatomy as their everywhere-else versions, with one binding rule:

> **Radio groups and tool selectors inside a modal use the chip-card pattern, never a discrete dot.**

A floating radio dot (small circle + label) is the right pattern when one option lives in a settings row beside many other settings. Inside a modal where the user is picking from 4–6 mutually-exclusive options _as the main task_, a chip-card — a soft-paper pill or rounded-md card that fills with the active state — gives the eye a much larger hit-target and reads as "this is one of N parallel choices." The radio dot pattern fractures the visual scan into label-reading; the chip-card pattern lets the eye match shapes.

Anatomy:

```
.modal-chip-card {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px;
  min-height: 44px;                    /* generous hit target */
  border-radius: 12px; /* rounded-md */
  /* Rest fill = paper (same as the modal background); the card sits flush
     with its container at rest and only reveals a hover via the direction
     rule from §8.10. Earlier passes used the soft tier as rest and
     the elevated tier as hover — that inverts the direction (rest darker,
     hover lighter) on light mode and conflicts with macOS / Linear list
     row convention. */
  background: rgb(var(--color-surface));
  box-shadow: var(--shadow-ring-light);
  color: var(--color-muted);
  font-size: 14px; font-weight: 500;
  cursor: pointer;
  transition: background-color 150ms ease, box-shadow 150ms ease, color 150ms ease;
}
.modal-chip-card:hover {
  background: rgb(var(--color-surface-hover)); /* light: one step darker, toward page floor */
  box-shadow: var(--shadow-ring-hover);
}
html[data-theme='dark'] .modal-chip-card:hover {
  background: rgb(var(--color-surface-elevated)); /* dark: one step lighter, away from page floor */
}
.modal-chip-card[data-active='true'],
.modal-chip-card[aria-pressed='true'] {
  background: var(--color-info-bg);       /* same-hue tinted fill from the status spectrum */
  box-shadow: inset 0 0 0 1.5px var(--color-info);
  color: rgb(var(--color-fg));
}
```

The chip-card uses `--color-info` (the brand / "selected" accent) for the active state in both light and dark modes. **A native `<input type='radio'>` lives inside the label for keyboard / screen-reader semantics but is visually hidden** (`opacity:0; position:absolute`). The chip itself is the visual radio.

Multi-select tool chips use the **small pill chip** pattern (§8.3) for compact density — they wrap into a flex row. Single-select use-case picks use the `.modal-chip-card` pattern above for taller, label-forward selection. This split is intentional: it makes the _grain of the choice_ (one-of-N vs. any-of-N) visible without reading the legend.

Inputs follow §8.6. Buttons follow §8.10 — primary + secondary in the action row, primary always on the right (the trailing-affordance position the eye lands on last).

#### Action row

Modal actions live at the bottom-right of the dialog body. Layout:

```
.modal-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  padding-top: 8px;
}
```

**The action row is part of one continuous surface — not a separated footer.** Like the header (which carries no divider beneath it), the action row carries **no divider above it and no tinted/recessed background band**. A modal body is short enough to read as a single flow; painting the buttons onto their own tinted shelf with a `border-t` fractures the dialog into two surfaces and breaks its single-surface reading. The buttons sit on the same fill as the body, separated only by the 8px `padding-top` above them.

**Primary right, secondary left.** Primary is the affirmative — "Submit", "Request access", "Save". Secondary is "Cancel" / "Back". Never put the destructive action as primary; destructive uses class **D** (`--color-error`) and sits to the left so the affirmative right is always the safe move.

For a success-state modal (one terminal action — "Close" or "Open dashboard"), the single primary button is centered (`justify-content: center`).

#### Motion

Modal enter:

- Backdrop: opacity 0 → 1 over 180ms ease.
- Dialog: opacity 0 → 1 + `translateY(8px) scale(0.98)` → `translateY(0) scale(1)` over 220ms with a soft-overshoot cubic-bezier (`cubic-bezier(0.16, 0.84, 0.44, 1)`).

Modal exit: reverse, 150ms ease.

Reduced motion (`prefers-reduced-motion: reduce`): drop both transitions to 0 — the modal appears and disappears with no movement, only fade.

#### Focus management

When a modal opens:

1. The first focusable element inside it receives focus after ~60ms (after the enter animation has begun, so the focus ring doesn't appear before the dialog).
2. Tab/Shift+Tab traps inside the dialog — the focus ring never escapes to backdrop or page chrome.
3. Esc closes the modal (unless destructive confirmation — see backdrop note above).
4. When the modal closes, focus returns to the element that triggered it (the CTA button, the row affordance, etc.).
5. Body scroll is locked via `document.body.style.overflow = 'hidden'` while the modal is open, restored on close.

#### Acceptance for any new modal

A new modal is aligned with the system if:

- Backdrop = ink at 0.36–0.44 (light) / 0.60–0.68 (dark) + 8–14px blur. No tinted backdrops.
- Outer radius = **Md 14** — the product ceiling; never above.
- **Product surface = flat:** `--color-surface` fill + a 1px ring + `--shadow-elevated` (soft drop), with **no inset gleam and no platinum band**.
- Width = 420 / 520 / 560 (Sm / Md / Lg). Max 720, beyond which it's a page.
- Padding = 24 / 28 / 32. No `padding > 36px` on a modal.
- Header has at most three parts (eyebrow / title / subtitle) and no divider beneath.
- Action row sits on the same paper fill as the body — no divider above it, no tinted/recessed footer band. Only an 8px `padding-top` separates it from the body.
- Close button = top-right, class **G**, pill, `--color-muted` icon.
- Form: radio-as-chip-card for one-of-N; small pill chips for any-of-N; inputs per §8.6; actions per §8.10 with primary on the right.
- Motion = 180/220ms enter, 150ms exit; honors reduced-motion.
- Focus trap + body-scroll lock + Esc-close + focus-return on dismiss.
- Verified in both themes.

### 8.12 Motion

- Default transition: **150–220ms, ease**. 150 for hover state shifts; 200–220 for card lifts and gradient changes.
- Respect `prefers-reduced-motion: reduce`: drop transition durations to 0 and replace any non-trivial movement (the hero scene fade-in, dot pulses, caret blinks) with an opacity change or no animation at all.
- No blinking badges, pulsing CTAs, or attention traps. The `--color-info` dot pulse on `data-state='active'` agents and the live-dot pulse in the canvas header are the only sanctioned "alive" indicators. All go static under reduced-motion.
- **Rail content transition (workspace ⇄ settings).** Because the workspace rail and the settings rail share the same background color and width, crossing that route boundary keeps the rail _frame_ fixed and slides only its content. It is a **baton pass, not a cross-fade**: the leaving content is fully faded by the 50% mark — _before_ the entering content begins to appear — so the two label sets never overlap. Both panes ride one continuous same-direction sweep (~28px; old accelerates out, new decelerates into place) over 300ms, reading as a single silky swipe (mirrored on the way back). Implemented with the View Transitions API on `.rail-vt-pane` (the content wrapper, never the `bg-rail` surface), scoped to `lg+` where both layouts keep a persistent rail; the root/main layer swaps instantly during the transition (no UA cross-fade) so no body text dissolves over itself either. Below `lg` it degrades to the default crossfade. Honors `prefers-reduced-motion: reduce` with an opacity-only sequenced fade (same no-overlap baton pass, zero movement). 300ms exceeds the 220ms ceiling above by design — a directional content sweep needs the extra travel time to read as smooth rather than a snap. See `.rail-vt-pane` + the `::view-transition-*(mf-rail-pane)` rules in `styles.css` and `lib/railTransition.ts`.

## 9. Layout

### 9.1 Container widths

| Use                    | Width      | Class                                                                                                           |
| ---------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| Workspace pages        | 1024px max | `.workbench-page` (`max-w-5xl`)                                                                                 |
| Wide workspace pages   | 1152px max | `.workbench-page-wide` (`max-w-6xl`)                                                                            |
| Narrow workspace pages | 896px max  | `.workbench-page-narrow` (`max-w-4xl`)                                                                          |
| Settings detail pages  | 768px max  | `.settings-page` (`max-w-3xl`) — every settings content/detail pane caps here for one consistent reading column |
| Forms                  | ~640px max | `.workbench-page-form`                                                                                          |

### 9.2 Vertical rhythm

| Surface                   | Section / page padding                               |
| ------------------------- | ---------------------------------------------------- |
| Workspace page            | 24–32px (`py-7 py-8` in `.workbench-page*`)          |
| Card internal padding     | 32–40px on landing cards; 16–24px on workspace cards |
| Composer internal padding | 14–18px                                              |
| Control height            | 36–40px default; 52px for hero CTAs                  |

**Anti-patterns inside the workspace:** section gap > 48px, panel padding > 32px, page padding > 40px, control height > 44px. These read as "marketing site" and don't belong in the chat / settings surfaces.

**On landing:** hero scale is exactly the right move. The 112px section padding and 52px CTA _should_ feel large.

### 9.3 App shell (workspace)

- Persistent left rail, 18–19rem wide on desktop. Mobile collapses to a drawer.
- Rail uses `bg-rail`; main canvas uses `bg-main`. **The canvas is one same-hue step darker than the rail** (§2 _The workbench surface ramp_) — the contrast is what carries the chrome/canvas distinction, not a stripe or border.
- The outer page (behind both rail and canvas) uses `bg-app`, one notch darker than the rail — the deepest tone in the product. It rarely shows through, but anchors the ramp.
- Primary "new" action near the top of the rail.
- Active rail items use `bg-rail-hover` (the same fill as hover, §2), not a colored bar.

### 9.4 Chat canvas (workspace)

- The canvas itself is `bg-main` — the near-white working stage (§2). No gradient, no radial wash; flat fill.
- The chat header **shares the canvas tone** (`bg-main`) with a `border-divider` bottom. The header is part of the canvas, not a separate elevated band — adding a lighter fill here would fracture the chat into "shelf + body" the same way a tinted composer dock would (§2). Identity (agent name, runtime status, secondary actions) comes from typography and pill chips, not from a background step.
- Message list occupies the body without per-message borders. **User message bubbles are the one place the two themes take opposite directions**: `bg-surface-subtle` in light (a δ-11 chip _below_ the near-white canvas, the same step ChatGPT and Claude use on a white thread) and `bg-surface` in dark (a lift _above_ the canvas). The bubble is ringless, so the fill is the only thing marking its edge — it must never land within a few units of the canvas. Assistant replies stay bare text on the canvas, which makes this bubble the only signal separating the two roles.
- Composer anchors the bottom with its own milled shadow stack. The composer _card_ uses `bg-surface`; the strip around it is transparent so the chat canvas reads continuously below the input — no separate background band.
- **Right-dock panels are the canvas, not furniture on it.** Every auxiliary panel docked beside the chat — workspace file tree, file preview, runtime session viewer, background tasks, and the terminal dock below — shares one recipe: container `bg-main` (the canvas tone), a 1px `border-divider` on its docked edge, and a resize handle that is **invisible at rest** (transparent fill, grabber revealed on `group-hover` / `group-focus-visible`). The whole workspace reads as one sheet of paper with hairline seams; only the content _inside_ a panel lifts or recesses (cards on `bg-surface` + ring, inputs and code on `bg-surface-subtle`). Two traps already hit: a panel mounted on the AppShell root sits on the `bg-app` floor, so its handle must paint `bg-main` explicitly or a floor-toned gap shows through (BackgroundTasksPanel); and the shared `@pierre/trees` background must be opaque and match its host panel (it is painted on sticky overlays and truncate fade masks) — `main-bg` in the chat panels, overridden back to `surface` where a tree lives inside a settings-card (skill editor).
- **A conversation keeps its reading position across the trip out and back** (`lib/chatScrollMemory.ts`), scoped to account + agent + session. Agent settings is a _sibling route_, so leaving unmounts the message list entirely and returning mounts a fresh one — without this, every return dropped the reader at the newest message and silently lost the place they were reading (#725). What is remembered is a **message id plus its pixel offset from the top of the viewport, or the explicit state "at the bottom"** — never a raw `scrollTop`, which cannot tell "pinned to the newest message" from "near it" and stops meaning anything the moment an older page prepends or a stream grows a block. "At the bottom" restores as _following_ the bottom, so a conversation left live stays live. The store is bounded (40 conversations, 14 days) and every value read back is treated as untrusted input.

### 9.5 Full-screen areas and their exits

Settings, Customize and agent settings are not pages sitting inside the shell — each one **replaces** the rail with its own. Same width key (`nca.web.sidebar.width`, 200 min / 304 default / 480 max), same `bg-rail` fill, so crossing in and out moves only the rail's _contents_ and never its edge (§9.3). An area that takes over the rail owes the reader a way out, and there are exactly **two** exit altitudes. Don't collapse them into one control, and don't move either to the other's altitude.

| Altitude           | Means                                            | Changes with the page?                 | Component                                                               |
| ------------------ | ------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------- |
| Rail top           | Leave the whole area → back to the conversation  | **Never**                              | `AreaBackLink`                                                          |
| Content column top | Leave this sub-page → back to the section's list | Appears / disappears with the sub-page | `Breadcrumb` (a plain `← Back to X` only as the entity-failed fallback) |

**The rail's exit is a fixed slot, so it says one fixed thing.** Sections inside an area are siblings, not levels — `/agents/:id/settings/skills` and `/agents/:id/settings` are the same page with a different pane, and the rail's own highlight already answers "where am I". Turning the exit into "up to the area's home" while you're in a sub-section makes the reader work out which level they're on before they can use the one control whose entire purpose is not having to. "Up one" is also already taken: section switches push history, the area exit replaces it, so the browser's back button walks the sections.

**A second exit is only earned when the rail's highlight stops describing the screen.** Drilling from a section's list into one record (a channel, a connection) is that case — the highlight still reads `Channels` while the pane shows one channel. Because that control comes and goes with the sub-page, it cannot live in the persistent rail; it sits at the top of the content column, next to the thing it exits.

**The exit names its destination, not its origin — and only when the name carries information.** Agent names are auto-generated (`adventurous-mayfly-2095`): at the rail's 200px minimum, truncation eats the digits that are the only thing telling two agents apart, and the destination is a place the reader left seconds ago. So the label is a constant (`Back to chat`, or `Back to workspace` when no conversation is stored) and the full name lives in the `ShortcutTooltip`. Put a name back in the label only if names become something the owner chose.

**Whatever computes the destination computes the label.** One read, one place — a label sourced separately from the navigation target will eventually name somewhere the click doesn't go. `lastChatLocation` is a single global slot, overwritten by whichever conversation was visited last, so an agent-scoped area must check the stored `agentId` against the agent on screen before following it (otherwise B's settings send you to A).

**Weight:** the exit is the quietest control in the rail — `text-caption`, one tier below the nav items (§5), on `--color-muted`. It stays on muted rather than dropping to subtle because at 12px subtle falls under 4.5:1 against `bg-rail`. The identity block beneath it (agent mark + name + status) is the rail's visual anchor.

## 10. Operational surfaces

This is what separates an agent workspace from a generic chat app: the UI must make _the work itself_ visible without breaking the calm.

### 10.1 Tool calls

A tool call is the most common operational object inline in chat.

- **Collapsed:** one line. `font-mono` tool name + first argument, plus a quiet status chip on the right (`Running…` / `Done` / `Failed`).
- **Expanded:** reveals input arguments + output. Output uses `font-mono` inside a `bg-surface-subtle` block. Long output truncates at ~20 lines with a "Show all" affordance.
- **Failed:** status chip uses `--color-error` (the "needs attention" accent). Body stays neutral. Expanding shows stderr in `font-mono` with `bg-error-bg`.

### 10.2 Streaming and progress

- Thin caret at end of streaming text (`.lp-pd-step-caret`).
- Long-running tool calls show `Running…` + elapsed time at `text-caption` + `font-mono`. Update at most once per second.
- Multi-step runs ("Reading 3 files…") show one status line at the top of the in-progress message, never one line per step.
- Loading copy stays calm: `Loading…`, `Creating…`, `Streaming…`. Never `Please wait` or exclamation marks.

### 10.3 Diffs and patches

- Inline `font-mono` inside `bg-surface-subtle`. `+` lines tinted `bg-info-bg`, `-` lines `bg-danger-bg` (subtle backgrounds, not saturated).
- Long diffs collapse to per-file summary with line counts.

### 10.4 Logs

- Inline `font-mono` inside `bg-surface-subtle`, capped at ~20 lines.
- "Show all" opens a side panel or full-page route, never a trapping modal.

### 10.5 Errors

Severity routing, ordered:

1. **Inline (tool call output)** — failure belongs to a specific step.
2. **Message-level banner** — agent message as a whole failed (`bg-error-bg` + `--color-error` icon).
3. **Page header banner** — session itself is degraded (runtime evicted, auth expired); persistent until resolved.
4. **Modal** — only when user action is required before they can continue.

Never use a toast for an agent error.

### 10.6 Status accent mapping

The five status hues have fixed semantics. Do not reuse them for other states. Each token has three forms — `-fg` (solid color for dots, icons, text), `-bg` (low-alpha tint for banners and badges), `-strong` (saturated fill for pressed / one-shot inline highlights).

| Accent                    | Token             | Meaning                                              | Light `-fg` | Dark `-fg` |
| ------------------------- | ----------------- | ---------------------------------------------------- | ----------- | ---------- |
| **Info / active / brand** | `--color-info`    | Running / streaming / brand / informational notice   | `#3560eb`   | `#8ca5f9`  |
| **Success**               | `--color-success` | Confirmed / completed / shipped                      | `#068346`   | `#0bab64`  |
| **Warning**               | `--color-warning` | Queued / paused / pending review / "needs attention" | `#a16404`   | `#c38a30`  |
| **Error**                 | `--color-error`   | Failed / destructive / blocked                       | `#d4342c`   | `#f06c63`  |
| **Idle**                  | `--color-idle`    | Idle / disabled / quiet / not-yet-started            | `#6e7184`   | `#9194aa`  |

Status accents are **paired** consistently. Within a single rendered element use the **same hue** for fg/bg/strong — never mix info-fg with success-bg. Across the product, a given state maps to exactly one hue:

- A "running" dot is `--color-info-vivid`; a "running" banner is `--color-info-bg` + a `--color-info` icon.
- A "succeeded" check is `--color-success`; a "succeeded" toast is `--color-success-bg` + a `--color-success` icon.
- A failed tool call's chip uses `--color-error-vivid` for the dot + `--color-error-bg` for the chip, with `--color-error-strong` text.
- A progress bar or chart mark takes `-vivid`; the number beside it takes `-fg`. Never put text on `-vivid`.

**Adjacency separation.** When two statuses can appear in the same dense list (e.g. an agent rail showing five runs in different states at once), the hue gap between adjacent rows must remain perceptible. The five hues are chosen so this holds even at the smallest 6px dot size.

If a state doesn't fit one of these five, it stays neutral (`--color-muted` or `--color-subtle`).

### 10.7 Empty states

An empty region is a moment of orientation, not decoration. The user arriving at one silently asks three questions, in order: **what would appear here, why is it empty right now, and what (if anything) should I do about it.** Every empty state answers those three questions in plain sentences — and nothing else. The historical failure mode was answering none of them: a big card whose only content was an aphorism (`ALL QUIET` / "Nothing is holding this sandbox awake right now") reads as a machine mood, not an explanation, and forces the user to reverse-engineer the product's internals to understand their own screen.

#### The four kinds of empty — cause decides the copy and the affordance

Before styling anything, classify _why_ the region is empty. The cause — not the surface — determines what the state says and whether it carries an action. Never present one kind in another kind's clothing.

| Kind             | Cause                                                                         | The message's job                                                                                     | Action                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **First-use**    | The user hasn't created this kind of thing yet                                | Name the thing and what having one gets you: "No channels yet. Bridge an agent into a chat platform." | **Yes — exactly one creation action.** This is the only kind that gets a button.                                                                              |
| **No-results**   | A search / filter matched nothing                                             | State the miss, ideally echoing the query: "No matches for `mcp`."                                    | At most a quiet "Clear filters" ghost action. **Never a create CTA** — "create one" next to a failed search reads as "create something matching your search." |
| **No-selection** | A master-detail layout with nothing picked                                    | Point at the list: "Select a connection to see its details."                                          | None — the list _is_ the action.                                                                                                                              |
| **All-clear**    | The absence is a good state (no running tasks, no errors, no pending reviews) | State the positive fact in the user's terms: "No tasks running."                                      | None. Optionally one quiet link to history/logs. Never dress a good state as a gap to be filled.                                                              |

Two impostors are **not** empty states and never use this section's treatments:

- **A failed load is an error, not emptiness.** If the fetch errored, route through §10.5 (banner with `--color-error` accent). Rendering "No agents yet" over a failed request is the worst lie a UI can tell — the user believes their data is gone.
- **Loading is loading.** Show a skeleton or a `Loading…` line (§10.2) until the answer is known; never flash the empty state before data arrives, and never let "Loading…" wear the empty-state panel.

#### The two visual tiers — container decides the structure

| Tier      | Where                                                                                           | Anatomy                                                                                                                                                                                                                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stack** | The empty region is a whole panel, tab, table body, or list body — anywhere taller than ~3 rows | Centered vertical stack: optional icon (one outline glyph, `h-7 w-7`, `--color-muted` — repeats the _object_, never the emotion; no illustrations, no oversized glyphs) → title `text-ui text-fg font-medium`, one line → body `text-caption text-muted mt-1`, ≤2 lines → optional action per the table above (`workbench-button-*`, Sm 10 — §6.2). Vertical padding `py-10`–`py-12`. |
| **Line**  | Micro contexts — a sidebar list, a dropdown's option area, a tool-output block, a preview pane  | One sentence, `text-caption text-muted` (drop to `text-subtle` for tertiary contexts like search-miss in a sidebar), in-flow with the list's own padding. No icon, no title, no action. Tool-output placeholders keep mono (`(no content)`) because the _content_ they stand in for is technical (§5).                                                                                |

**The dashed outline is a promise of content — first-use only.** A stack-tier **first-use** state (and only first-use) may wrap itself in a placeholder frame: `border border-dashed border-divider rounded-md` (Md 14), **no fill, no shadow**. The dashed ring reads as "a surface that hasn't materialized yet — your action fills it," which is exactly and only true of first-use. All-clear, no-selection, and no-results get **no container at all**: nothing is missing, so nothing gets outlined. This is the semantic split that makes the visual language legible — a user who sees dashes learns "I can fill this"; a user who sees quiet centered text learns "this is fine."

**An empty state is never a raised card.** Do not give it `bg-surface` + `--shadow-card` (the legacy `.workbench-empty` recipe, now retired): a filled, elevated card whose only content is a sentence promotes the _absence_ of content to the same rank as content, and inside an already-carded section it produces card-in-card. The empty message sits directly on whatever background the missing content would have sat on.

#### Copy rules

- **Title names the fact; body adds the one useful sentence.** "No connections yet." + "Link GitHub, Cloudflare or Composio so agents authenticate automatically." The body never restates the title, never describes internal machinery (leases, sprites, envelopes), and stays ≤2 lines at the container's width.
- **Sentence case, real sentences, periods.** Never ALL-CAPS, never `tracking-*` letterspacing on an empty-state message — `.workbench-kicker` is a _section label_ and is banned inside an empty state (the `ALL QUIET` bug: a machine-status stamp where an explanation should be). §8.12's no-shouting rule applies product-wide.
- **"yet" is first-use vocabulary.** "No agents yet" implies your action will change it; on an all-clear state the same word wrongly implies a gap ("No failures yet" reads as _expecting_ failures). All-clear states say what _is_: "No tasks running."
- Calm register per §10.2 — no exclamation marks, no "Nothing to see here!" theatrics, no apologizing.
- All copy through `t()` (`@manyfold/i18n`), like every other user-facing string.

#### The shared component

Every empty state renders through **`EmptyState`** (`components/EmptyState.tsx`) — the per-file `EmptyHint` / `EmptyContent` clones are retired the same way `.status-tag` fell to the tag family (§8.3):

```tsx
<EmptyState
    kind='first-use' // 'first-use' | 'no-results' | 'no-selection' | 'all-clear'
    tier='stack' // 'stack' | 'line'
    icon={ChannelIcon} // stack only, optional
    title={t('web.channels.emptyTitle')} // stack only
    body={t('web.channels.emptyBody')}
    action={{ label: t('web.channels.create'), onClick }} // enforced: first-use only
/>
```

The component owns the tier anatomy, the first-use-only dashed frame and action slot, and the type/color tokens — a call site chooses _kind_ and _tier_ and supplies words, nothing visual.

#### Worked example — the sandbox Activity panel

Before (the canonical failure): `workbench-empty` card + `workbench-kicker` reading `ALL QUIET` + "Nothing is holding this sandbox awake right now." — a raised card, a shouted machine mood, and a body that requires knowing the lease model.

After (**all-clear**, stack tier, no frame, no action):

> **No activity** _(text-ui text-fg font-medium)_
> Nothing is running or scheduled, so the sandbox will pause on its own. _(text-caption text-muted)_

Same information, answered in the user's terms: what this panel shows (activity), why it's empty (nothing running), and what happens next (auto-pause) — with no button, because a good state asks nothing of the user.

### 10.8 Loading states — the sheen system

Every wait in the product speaks one motion vocabulary: a pale band sweeping the ground on a shared clock. The treatment generalizes the chat working label (`.chat-shiny-text`, now an alias of `.sheen-text`) — the one loading visual the product already did well — into a full system. Five rules govern everything:

1. **Structure first, chrome stays real.** A skeleton mirrors the exact layout it stands in for: page headers, toolbars, panel titles, and static buttons render real; only _content_ ghosts. Data arrival causes zero layout shift. Ghost count matches the real expectation (cached count, or 3–6) — never an endless fake list.
2. **One sweep, one clock.** Ghost blocks and sheen text share `--sheen-period` (2.4s: the band travels ~58% of the period, then rests a beat). Mount a region's ghosts together so they share one phase — the sheen must read as a single light source passing over the panel, not per-block glitter.
3. **Grey is placeholder, blue is activity.** Ghosts and spinners stay hueless (`--ghost-bg` is an ink wash) — waiting is absence, not a state. Info blue belongs only to live-activity signals: the refresh hairline, streaming carets, running dots (§10.6). Never tint a skeleton.
4. **The 150 / 300 / 140 gate.** A request that resolves inside 150ms shows no indicator at all. Once an indicator appears, it stays a minimum 300ms even if data lands earlier. Content then delivers as a pure 140ms fade (`.loading-fade-in`) — no movement, no scale. The gate has exactly one implementation: `useLoadingGate` (`components/useLoadingGate.ts`). The only exception is chat streaming, which is immediate.
5. **One region, one owner.** A region shows at most one loading indicator at a time — no spinner inside a skeleton, no `Loading…` beside a spinner, no skeleton under a hairline.
6. **The ground never changes brightness while loading.** `html` / `body` paint `--color-main-bg`, the same canvas boot fills with — not `--color-app-bg`. The chassis is a frame colour: since the neutral axis inverted it sits 24 levels below the canvas in light mode and 14 above it in dark, so painting the pre-mount viewport with it made every cold load flash grey and then light up. Every top-level surface paints its own ground anyway (`AppShell` the chassis, the other eleven the canvas), so this layer is only ever seen in the gap between stylesheet and first paint — and its one job is to already be the colour that gap resolves to.

#### The primitives

All loading UI is built from these — never hand-roll a variant. Components live in `components/Loading.tsx`; classes and tokens in `styles.css`.

| Primitive        | Component / class                             | Use                                                                                                                                                                                                                                                                                                   |
| ---------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ghost skeleton   | `<Ghost variant />` / `.ghost`                | Structure placeholder for first loads. Variants pin height + radius to what they replace: `cap` 10px / `line` 13px / `title` 18px text bars (Xs 8 radius), `circle` (pill), `tile` / `block` (Sm 10). Width from the call site, stepped per row so the region reads as ragged text, not a brick wall. |
| Sheen text       | `<SheenText />` / `.sheen-text`               | Line-tier loading verb for micro contexts (dropdown option areas, sidebar sub-lists, popovers): `Loading models…` — verb + object + ellipsis character (never ASCII `...`). The §10.7 Line-tier counterpart for loading.                                                                              |
| Spinner          | `<Spinner size />` / `.loading-spin`          | Control-tier waits only: 22%-track ring + 90° arc, 1.5px stroke, `currentColor`, 0.9s linear. Sizes 12 (inline) / 16 (buttons, default) / 20 (panel corner). Never in the middle of a content region.                                                                                                 |
| Hairline         | `<HairlineProgress />` / `.hairline-progress` | Refresh over existing content: stale content stays fully readable, a 2px info segment sweeps the region's top edge. Position absolutely so it never shifts layout. Never blank a populated region back to skeleton.                                                                                   |
| Button pending   | (per-site, P5 pattern)                        | `disabled` + `aria-busy`, `<Spinner size={16} className='mr-2' />`, label switches to the action verb's progressive form (`Saving…`, `Installing…`) — never `Loading…` on a button.                                                                                                                   |
| Boot             | `<BootScreen />`                              | App start only — the one wait with no chrome to keep real. The BrandMark breathes its fold open 3.4° and back on the shared clock, centred on `bg-main`, glyph 56px wide. No skeleton (it would have to guess the incoming layout), no text, no spinner, no progress.                                 |
| Streaming (chat) | §10.2 vocabulary                              | Caret, `Running…` shiny mono line + elapsed, StatusTag pulse — unchanged; already conforms.                                                                                                                                                                                                           |

Tokens: `--ghost-bg` (fg at 6% light / 8% dark), `--ghost-sheen` (white at 55% light / 5% dark), `--sheen-period` (2.4s). Ghosts are decorative — mark the containing region `aria-busy='true'` instead of labelling each block.

#### Boot is the only chrome-less wait

Rule 1 says chrome stays real, which presumes chrome exists. Exactly one wait precedes it: app start, while the session resolves and the first route chunk lands. A skeleton there would have to guess the incoming layout and guesses wrong for every surface — the pop-in when the real chrome arrives reads as a bug. So boot makes no structural promise at all and shows the brand mark instead, breathing rather than sweeping: the mark _is_ a folded strip, so its wait animates the fold (all four creases rock open together, panel length fixed like a real folding rule). It is still the same clock and still hueless, so it belongs to this system rather than being a splash screen.

`BootScreen` owns all three of app start's moments — the top-level `Suspense` fallback, `ProtectedRoute` before the session answers, and auth config loading — so boot reads as one continuous state instead of blank → skeleton → chrome. It is gated like everything else, so a warm boot shows nothing. **Never** use it for a session navigation: once chrome is mounted the wait belongs to `GhostPageContent` inside the layout's own boundary, and a full-screen mark mid-session reads as the app restarting. That is why `App.tsx` warms the three layout chunks on idle once signed in — an unwarmed layout chunk would suspend to this boundary. Its breath duration is the one place `--sheen-period` is duplicated as a literal, because SMIL cannot read a custom property; change both together.

#### The decision ladder

Two questions pick the primitive: _is there stale content on screen?_ and _is the region's shape predictable?_

| Situation                                           | Treatment                                                       |
| --------------------------------------------------- | --------------------------------------------------------------- |
| App start (no chrome yet)                           | `BootScreen` — breathing mark, no structure                     |
| Route lazy-load inside a mounted layout             | `GhostPageContent` in the layout's `Suspense` — chrome stays    |
| Route lazy-load / page first load                   | Page skeleton — chrome real, content ghosts                     |
| Panel / list / table first load                     | Region skeleton mirroring the real rows/cards/columns           |
| Refetch over existing content (filter, poll)        | Keep stale content readable + hairline. Never back to skeleton. |
| Micro context (dropdown, popover, sidebar sub-list) | One `SheenText` line                                            |
| Control submit / inline action                      | Spinner in place / button-pending pattern                       |
| Agent activity (streaming, tool runs)               | §10.2 vocabulary — the only place info blue pulses live         |

#### Ghost twins live beside their components

A skeleton is the real component's shadow, and drift between them is a bug closed on the same PR (§3.2 applies). The ghost twin exports from the same file as the component it mirrors (`CatalogCardGhost` in `CatalogCard.tsx`), sharing the container classes so layout changes propagate automatically; only content slots are hand-mirrored. Skeletons anchor _structural outline_ (container, grid, row composition) — visual-tier changes (color, weight, spacing nudges, hover) cost the skeleton nothing.

#### Never

- Never stack indicators (rule 5), and never let `Loading…` wear a filled card (`workbench-note`) or the empty state's clothing (§10.7).
- Never render an empty list/table while its data is in flight — that window belongs to the skeleton.
- Never color a ghost, bounce/scale arriving content, or animate rows in one by one.
- Under `prefers-reduced-motion`: sweeps, hairline, and text sheen go static (the ghost keeps its flat wash); the sub-20px spinner keeps rotating, slower (1.6s) — it is essential state feedback.

## 11. Reference implementations

Working components, by pattern, for both new development and AI agents writing UI:

| Pattern                 | File                                                                                 | Notes                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product tag family      | `src/components/Tag.tsx` (`StatusTag` / `Tag` / `RiskTag`) + `.tag*` in `styles.css` | One anatomy, three roles (§8.3): status (tinted + dot), classification (neutral), technical (neutral + mono)                                                                                                                                          |
| Portaled product menu   | `src/components/chat/ComposerMenu.tsx` + `src/hooks/useAnchoredMenuPosition.ts`      | The §8.7 portal contract: `fixed` panel on `<body>` at `z-[110]`, anchor-tracked (side flip, height clamp, ancestor `ResizeObserver`). `WorkbenchSelect.tsx` is the width-matching select variant; never `absolute` inside a scroll/overflow ancestor |
| Persistent rail         | `src/components/AppShell.tsx`                                                        | bg-rail, no shadow, hover/selected via bg-rail-hover (§8.10); selected rows use bg-active-session (= rail-hover)                                                                                                                                      |
| Chat canvas             | `src/pages/AgentChat.tsx`                                                            | bg-main, light header, composer Sm shadow                                                                                                                                                                                                             |
| Settings surface        | `src/components/SettingsLayout.tsx`                                                  | bg-settings-bg, sticky light header, pill nav                                                                                                                                                                                                         |
| Area exit (2 altitudes) | `src/components/AreaBackLink.tsx` + `src/components/Breadcrumb.tsx`                  | §9.5: rail top = leave the area, constant label, never section-dependent; content-column top = leave the sub-page, `Breadcrumb`. Destination and label come from one read at the call site                                                            |
| Empty state             | `src/components/EmptyState.tsx`                                                      | One component, four kinds × two tiers (§10.7): dashed frame + action for first-use only; quiet stack / one-liner for everything else                                                                                                                  |
| Loading states          | `src/components/Loading.tsx` + `useLoadingGate.ts`                                   | The sheen system (§10.8): Ghost / SheenText / Spinner / HairlineProgress on one `--sheen-period` clock, gated 150/300/140; ghost twins live beside their components (`CatalogCardGhost`)                                                              |
| App boot                | `src/components/BootScreen.tsx`                                                      | The chrome-less wait (§10.8): BrandMark breathing its fold on the shared clock, glyph 56px, SMIL so the loop costs no JS; app start only, never a session navigation                                                                                  |
| Workbench page widths   | `src/styles.css` `.workbench-page*`                                                  | Canonical containers                                                                                                                                                                                                                                  |

## 12. Applying this system to a new page

A new surface is aligned with the system if all of the following are true:

- All colors come from tokens. No ad-hoc hex.
- Geist sans for everything. Geist Mono only for technical signal. No third display family anywhere — emphasis is carried by color, not by a font swap.
- Headings (h2+, card titles) use `--color-muted`, not pure ink.
- Cards / panels / popovers / modals use Md 14 (the product ceiling) or smaller (Sm 10 / Xs 8); only the chat composer is rounder (18). Never reach for a `rounded-lg`+ utility on a product surface — those tiers are honest hero values (20/24/28/32) reserved for landing and will visibly over-round a product card (§6.1). No `corner-shape` / squircle anywhere (§6.4).
- Badges, tags, chips, avatars, status dots are pill / circle. Buttons follow the §6.2 register: pill on identity surfaces (rail / chat), Sm 10 on working surfaces; icon-only buttons are always circular.
- Concentric nesting holds where there's tight inset framing: the binding case is the menu (14 − 4 = 10). Cards cap at 14 and use generous padding, so the rule there is informational.
- **Flat surfaces** (cards, panels, tables, popovers, dropdowns, tooltips, modals): solid fill + a 1px ring + an optional soft drop (`--shadow-card` resting / `--shadow-elevated` floating) — **no inset gleam, no platinum band**. No shadow on pills/badges/avatars, product tags are ringless contrast-budgeted fills (§8.3), avatars are bare fills. **The composer** keeps the full §7 anatomy.
- A clickable card hovers by stepping its fill one tone (no translate, no shadow swap). Hover on buttons = fill change _away from the page floor_ (light = darker, dark = lighter — see §8.1 / §8.10); **never** `filter: brightness()`, **never** a hover that changes text/icon color (the one exception: class **L** list rows, see §8.10). Every button maps to exactly one of the five classes P/S/G/L/D in §8.10. Press = translateY(0.5px).
- Focus is visible on every interactive element.
- Every accent-color state also carries a non-color signal.
- Verified in both light and dark mode.
- No section gap > 48px, panel padding > 32px, control height > 44px **inside the product**. Landing is exempt.

## 13. Do / Don't

**Do**

- **Keep the global-baseline files aligned with this document on every visual change.** Before shipping any token, radius, shadow, or type tweak, audit `apps/web/src/styles.css`, `apps/web/tailwind.config.ts`, `apps/docs/src/styles/global.css`, `apps/docs/tailwind.config.mjs` (if present), and this `DESIGN.md` together. Conflict → unify. Missing on one side → add it. See §3.1 / §3.2.
- Inside the product, keep the **workbench surface ramp** in order: floor (`bg-app`) → rail (`bg-rail`) → chat canvas (`bg-main`) → composer / popovers / cards (`bg-surface`). In light mode that ramp runs upward in lightness; in dark mode the rail and canvas keep the same roles with the canvas lifted above the rail. See §2.
- Use the product radius scale (8 / 10 / 14, §6.1) — **14 is the ceiling** for every card, panel, popover, dropdown and modal; only the chat composer sits above it, at 18.
- Keep cards, panels, popovers, dropdowns, tooltips, and modals **flat** — solid fill, a 1px ring, an optional soft drop. The milled inset gleam + platinum chamfer is reserved for the chat composer.
- Treat the landing as the loudest expression of the system, not as a different system.
- On the composer, make the surface look lit from above — via a soft _blurred_ inset gleam plus the cool-platinum chamfer band, not a hard 1px line. Everywhere else, keep the surface matte.
- Use `background-color:` longhand (not the `background:` shorthand) when overriding a card's fill, so the texture stack isn't wiped.
- Keep button and card fills flat. Lift lives in `box-shadow`, not in a background gradient inside the fill.
- Use accent colors for state, never for decoration.
- Classify every empty region by cause (first-use / no-results / no-selection / all-clear, §10.7) before styling it — the cause decides the copy and whether a CTA exists; render it through the shared `EmptyState` component.
- Use `--color-muted` for non-hero headings.
- Use `background-color` changes — not `filter: brightness()` — for button hovers, so text/icon contrast stays intact.
- Product tags carry no ring at all (§8.3) — the fill alone holds the edge on every ground it lands on.
- Keep accent gradients symmetric about the vertical centerline (e.g. CTA card glow at `50% 0%` / `50% 100%`, never asymmetric corner washes).
- Verify both themes.

**Don't**

- **Don't ship a visual change that touches only one of the global-baseline files.** A new token in styles.css without a matching DESIGN.md entry, a tightened hover in DESIGN.md that styles.css hasn't picked up, a webapp color update that didn't propagate to docs — all three are bugs. Audit §3.1's table before merging.
- Don't invert the workbench surface ramp. The rail is chrome and must stay recessed relative to the canvas; the canvas is the stage. If you paint the rail brighter than the canvas, the chrome reads as "the working area" and the chat reads as "background" — the opposite of what should be true.
- Don't rely on fill alone to lift a card off the near-white canvas. There are only a few units of headroom up there; a surface that drops its ring or shadow will read as flush with the page no matter how you tune the fill. This is the inverse of the old failure mode, where fill did all the work and rings were decorative.
- Don't paint a tinted band around the composer (e.g. `bg-surface` on `.chat-composer-dock`). The composer card already lifts off the canvas via its shadow; adding a backdrop fractures the chat into a "shelf" + "input" instead of a single canvas with an input floating on it.
- Don't put shadows on pills / badges / avatars — a product tag gets only its contrast-budgeted fill (§8.3), an avatar gets a bare fill.
- Don't combine a top-edge hairline with a full ring — the top will read thinner than the other three sides.
- Don't bring landing's serif into the product — not on a page title, not on the new-chat greeting. Every product rung is Geist (§5).
- Don't trail long-distance shadow stops below an element — they read as smudge, not lift. Cap drop reach at ~54px on the largest tier.
- Don't terminate the inset top gleam or bottom edge tuck with `0` blur — hard horizontal seams read as chrome. Use a 5–7px blur so the lit edge fades into the fill.
- Don't paint a vertical gradient into a button or card fill on top of the inset gleam — it double-counts "lit from above" and reads plasticky.
- Don't reach for `filter: brightness()` on a button hover. On dark fills with light text it strips text contrast; on light fills it has no headroom. Change the fill color instead.
- **Don't invert the hover direction by theme.** In **light mode**, hover _darkens_ the fill (toward the page floor). In **dark mode**, hover _lightens_ the fill (away from it). The mistake is stepping toward the elevated tier in both modes.
- **Don't pick a chip/card rest fill that's _darker_ than its container.** A chip at rest should sit flush with or slightly above its container (rest = container or `--color-surface`; hover moves one step away from the page floor).
- Don't invent a sixth button class. Every button maps to P / S / G / L / D from §8.10. If a button feels like it needs a different hover, it's in the wrong class — re-classify it, don't write a new hover.
- **Don't let a full-screen area's rail exit change meaning by section, and don't move a sub-page's exit up into the rail** (§9.5). The rail slot is a constant — "leave this area"; a drill-down's way out belongs at the top of the content column, where it can appear and disappear with the sub-page. Related: don't source that exit's label separately from its navigation target, and don't let an agent-scoped area follow the global `lastChatLocation` without checking its `agentId` first.
- Don't use `hover:bg-black/[0.0n]` ink-tint hovers. They produce a different perceived shade on every surface and are leftover from the warm-paper era. Use `--color-surface-hover`, `--color-soft-hover`, or `--color-soft` per §8.10.
- Don't change icon color alone on hover (`hover:text-fg` without a fill change). The fill must carry the signal; icon color is reserved for the active/selected state.
- Don't introduce warm-cream / warm-paper colours (`#f6f1e6`, `#fdfaef`, `#faf5ea`), and don't tint the ground toward the accent. The neutral axis is Ash — paper feel comes from lightness and narrow steps, never from hue.
- Don't introduce a hover tint in a different hue family than the canvas (e.g. a warm cream hover on an Ash surface). Hover tints stay in the same hue family.
- Don't swap a primary button's fill to the brand accent on hover — accent means _state_, not "this button is being hovered."
- Don't translate icons (arrow, chevron) inside a CTA button on hover.
- Don't use pure black (`#000`) or pure white (`#fff`) for surface or text.
- Don't hard-code hex values. Add a token first (LED blue is the only documented exception).
- Don't pill a substantial button on a working surface (settings / agent-mgmt / automations / dialogs) — those are Sm 10 (§6.2). Pills are for identity surfaces (rail / chat), icon-only buttons, tiny ghost text buttons, and objects. And don't give a working-surface button Md 14 — that's the failed-pill bug (§6.1).
- **Don't give a card, panel, popover, or modal a radius above 14.** 14 is the product ceiling; the chat composer (18) is the only surface allowed rounder, and only because it's the milled tactile input. A 16/18/20 card reads bubbly on a dense, multi-card page (§6.1).
- **Don't put the milled inset gleam or cool-platinum chamfer on a product card, popover, dropdown, tooltip, or modal.** They are flat (§7) — solid fill + 1px ring + optional drop. The milled finish is the chat composer only. A "too 3D" / "too plasticky" working surface is almost always one that wrongly kept the inset layers.
- Don't invert the palette in dark mode. Dark mode is a dimmed Ash room.
- Don't reuse a workflow accent for branding or hover.
- Don't render an empty state as a raised card, crown it with an ALL-CAPS `.workbench-kicker`, or dress a failed load / loading state as emptiness (§10.7). The dashed placeholder frame belongs to first-use only; a good state ("no tasks running") gets quiet text and no CTA.

## 14. Agent prompt recipes

Short, defer to section numbers so they stay current as the system evolves.

### Landing surface

Out of scope here — landing has its own register and its own recipes in `DESIGN.landing.md` §10.

### Workspace home / empty state

```
Design a workspace home empty state per §9.3 app shell. One text-display question, one paragraph, one primary + one secondary action, three operational shortcut cards (flat Md 14 cards — `--shadow-card`, no inset gleam, no texture). Compact density per §9.2. Geist throughout (§5). Accent colors map per §10.6.
```

### Chat canvas

```
Design the chat canvas per §9.4 and §10 operational surfaces. Persistent left rail (§9.3), light header, message list, composer with its milled inline shadow at 18px (§8.6 — the one product surface that keeps the milled finish and the one above the 14 radius ceiling). Tool calls (§10.1), streaming (§10.2), diffs (§10.3), logs (§10.4), errors (§10.5) follow §10. Framework names in Geist Mono (§5).
```

### Settings surface

```
Design a settings page per §9 and §10. Sticky light header, pill/tab navigation (§8.3), flat content cards and popovers (Md 14, the product ceiling) per §7 — solid fill + 1px ring + soft drop, no inset gleam. Same neutral palette as chat surfaces (§4.1). Must feel adjacent to chat, not like a separate admin product.
```

### New elevated component

```
Design a new elevated component. Pick its radius tier per §6.1 (Md 14 for any card / panel / popover / modal — the product ceiling / Sm 10 control or small banner / Xs 8 micro-glyph; the composer's 18 is the lone exception). Default to the FLAT finish (§7): solid fill + a 1px ring + --shadow-card (resting) or --shadow-elevated (floating) — no inset gleam, no chamfer band. Only the chat composer gets the milled anatomy. If pressable, shape it per the §6.2 register (pill on identity surfaces, Sm 10 on working surfaces; icon-only → circle). Hover: a clickable product card steps its fill; a button changes fill (§8.9, never filter:brightness). Both themes verified.
```

## 15. Acceptance checklist

A proposal is aligned with this system if:

- Color: only tokens from §4, no ad-hoc hex.
- Typography: Geist on every rung; Mono only for technical signal; no serif anywhere in the product.
- Radius: Md 14 (the ceiling) / Sm 10 / Xs 8 / Pill via `border-radius` inside the product, with the composer (18) the lone exception; landing keeps the full 8 → 32 scale (§6.1). No `corner-shape` / squircle (§6.4).
- Shadow: flat surfaces use `--shadow-card` (resting) or `--shadow-elevated` (floating); the composer keeps its own milled stack. None on pills / badges / avatars / tags.
- Flat surfaces (cards, popovers, dropdowns, tooltips, modals) carry **no** inset gleam or chamfer band — solid fill + ring + optional drop only. On the composer, the inset gleam + cool-platinum chamfer band + bottom edge tuck all carry a small blur (no hard horizontal seams).
- Fills are flat. No vertical background gradient inside a button or card.
- Concentric nesting holds where there's visible inset framing.
- Every product button is flat (solid fill + a 1px ring, no inset gleam). All follow the §6.2 shape register (pill on identity surfaces, Sm 10 on working surfaces; icon-only circular). Hover changes the fill (not `filter`, not text/icon color). Icons inside the button do not translate. Press translates 0.5px. Primary fill is _not_ swapped to brand color on hover.
- Cards override fill with `background-color:` longhand, not `background:` shorthand.
- A clickable card hovers by stepping its fill one tone (no translate, no shadow swap).
- Heading hierarchy uses `--color-muted` (not pure ink) for everything below hero h1.
- Every accent state has a non-color signal.
- Focus is visible on every interactive element.
- Reduced-motion users get a static experience.
- No warm-cream / warm-paper hex values introduced.
- Verified in light _and_ dark mode.
- No anti-patterns from §9.2 inside the workspace surfaces.
- Full-screen areas (§9.5): the rail exit reads the same in every section, a drill-down's exit sits at the top of the content column, and the exit's label comes from the same read as its destination.
