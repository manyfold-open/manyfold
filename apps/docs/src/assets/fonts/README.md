# Vendored faces for the generated social cards

Only `[...slug].png.ts` and its four sibling routes read these. Nothing here is
served to a browser — the site's own web fonts come from `@fontsource*` through
`global.css`.

## `fraunces-card.ttf`

The landing register's display face at the one instance the spec pins
(`DESIGN.landing.md` §2.3): **wght 300, SOFT 50, WONK 0**, plus `opsz 60`,
which is what `font-optical-sizing: auto` resolves to at the card's 76px title
(76px = 57pt).

It has to be a static instance, and it has to be a `.ttf`:

- **satori takes the default instance of a variable font.** Fraunces defaults to
  `opsz 9, wght 900, SOFT 0, WONK 1` — a heavy, sharp-terminalled face with the
  alternate glyphs turned on. That is a different typeface, not a heavier one.
  There is no way to set an axis through satori's font API.
- **satori reads ttf, otf and woff only**, never woff2, which is the only format
  `@fontsource-variable/fraunces` ships.

Regenerate it from the installed package (`fontTools >= 4.60`, needs `brotli`
for the woff2 side):

```python
from fontTools.ttLib import TTFont
from fontTools.ttLib.woff2 import decompress
from fontTools.varLib import instancer

src = 'node_modules/@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2'
decompress(src, '/tmp/fraunces-var.ttf')
font = instancer.instantiateVariableFont(
    TTFont('/tmp/fraunces-var.ttf'),
    {'wght': 300, 'SOFT': 50, 'WONK': 0, 'opsz': 60},
    inplace=False,
    updateFontNames=False,
)
for nid, val in ((1, 'Fraunces Card'), (2, 'Regular'), (4, 'Fraunces Card'),
                 (6, 'FrauncesCard-Regular'), (16, 'Fraunces Card'), (17, 'Regular')):
    font['name'].setName(val, nid, 3, 1, 0x409)
    font['name'].setName(val, nid, 1, 0, 0)
font.save('apps/docs/src/assets/fonts/fraunces-card.ttf')
```

`updateFontNames=True` fails here: it wants a STAT axis value for every pinned
axis and the family has no named instance at `opsz 60`.

The source subset is latin only (245 glyphs, 35KB), which is all the cards need
— the generated cards are English-only, see the header of `[...slug].png.ts`.

**Licence:** Fraunces is SIL Open Font License 1.1, © The Fraunces Project
Authors (https://github.com/undercasetype/Fraunces). The full text ships with
the source package at `node_modules/@fontsource-variable/fraunces/LICENSE`.
Instancing is a permitted modification; the OFL reserved-name rule is why the
instance is called `Fraunces Card` rather than `Fraunces`.
