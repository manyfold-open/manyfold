---
---

No user-visible change: three loose ends left by the landing rebuild, each of
which only becomes a failure downstream of this repository's CI.

`.landing-root` redeclared the product's `--shadow-focus`. Nothing under that
root consumes the token — the FAQ control carries its own underline treatment
and no landing surface uses the ring — so the override was dead, and a second
declaration of a token whose whole point is one recipe per theme is the kind of
dead that later reads as intent. A landing focus ring, if one is ever wanted,
belongs in the register's own `--lp-*` namespace.

Nineteen `web.landing.meter*` keys plus `worksWithExternal` lost their last
reference when the metering section became observability; they are removed from
all eleven catalogs. `meterMonthToDate` is still rendered and stays.

The flux comment, and the changeset that repeats its sentence, both described a
wire as a band of constant value using a word a payment vendor also owns. They
say `band` now, which is what the sentence meant, and it keeps a vendor name out
of an append-only changelog.
