# `@manyfold/tokens`

The single place a design value is decided.

## Why it exists

The same colour used to be written down in up to five places, in three
different syntaxes, with nothing comparing them. They had stopped agreeing:
16 colours differed between the webapp and the docs site, five between the
product and the emails, and the docs ink ramp was copied one rung out of
step under a comment claiming it mirrored the landing scale.

None of that was carelessness. Two apps genuinely need different spellings
of one colour — `apps/web` is on Tailwind 3 and reads tokens through
`rgb(var(--x) / a)`, so a colour must be a bare triplet, while `apps/docs`
is on Tailwind 4 whose `@theme` needs a complete value, and the landing
register is hand-written CSS in hex. Maintaining three spellings by hand is
the mechanism, not the mistake.

## What it owns

| Module              | Owns                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `palette.ts`        | The Iris brand ramp and the Ash neutral curve. **Both registers point at these steps** — this is what makes landing and the product one brand rather than two that happen to match today |
| `product-colors.ts` | Every `--color-*` (56), plus per-consumer overrides with stated reasons                                                                                                                  |
| `landing-colors.ts` | Every `--lp-*` colour (43). Fieldwork's 32 are excluded — landing-only                                                                                                                   |
| `scale.ts`          | Radius scales, font stacks, display-register parameters                                                                                                                                  |
| `typography.ts`     | Type ramps, tracking, line-heights, the weight cap                                                                                                                                       |
| `shadow.ts`         | Shadow recipes, and a normaliser that sees through the two house styles                                                                                                                  |
| `email.ts`          | The email palette, derived from the product tokens                                                                                                                                       |

## Commands

```bash
pnpm tokens:check   # every consumer must agree with the package
pnpm tokens:drift   # divergences held on purpose, with reasons
```

`tokens:check` covers 346 values. It fails when a stylesheet value differs
from the package, when a stylesheet carries a token the package does not
declare, when the package declares one a stylesheet lacks, and — for
`tailwind.config.ts`, which imports the values and therefore cannot
disagree — when the import is replaced by literals.

## Two rules worth stating

**Never edit a value in a stylesheet.** Change it here; the gate will tell
you which baselines fell out of line. A stylesheet still owns its
selectors, layers and rules — just not the numbers.

**An override needs a reason.** Where two consumers are meant to differ, say
why in the `reason` field. An override without one is how the baselines
drifted apart in the first place, and `drift: true` marks the ones believed
accidental so the list can only shrink.

## What it does not own yet

- `apps/admin` and its stylesheet
- Fieldwork's 32 landing-only tokens
- Physically generating the declarations into the stylesheets. The package is
  the authoritative _statement_ of every value and the gate makes it
  binding, but the stylesheets still carry their own copies. Collapsing them
  into generated blocks means reshuffling `--color-*` declarations that
  interleave with `--shadow-*` / `--text-*` and 356 lines of comment — its
  own change, with its own review.

The design intent behind these values lives in `apps/web/DESIGN.md` (product
register) and `apps/web/DESIGN.landing.md` (landing). This package holds the
numbers; those documents hold the reasoning. See `DESIGN.md` §3.1.
