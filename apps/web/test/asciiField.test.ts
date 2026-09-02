import test from 'node:test'
import assert from 'node:assert/strict'
import {
    CELL_ASPECT,
    LOOP_MS,
    PLATE,
    RAMPS,
    RIPPLE_MAX_WAVENUMBER,
    renderPlates,
    sigilCells,
    type FieldShape,
    type InkRamp
} from '../src/components/field/fields'

const SHAPES: FieldShape[] = [
    'ripple',
    'clouds',
    'torus',
    'sphere',
    'fold',
    'drift'
]
const INK_RAMPS: InkRamp[] = ['binary', 'halftone', 'wave']

test('every ink ramp is eight glyphs ordered from empty', () => {
    for (const ramp of INK_RAMPS) {
        const glyphs = RAMPS[ramp]
        assert.equal(glyphs.length, 8, `${ramp} must have 8 ink levels`)
        assert.equal(glyphs[0], ' ', `${ramp} level 0 must be empty`)
        assert.equal(
            new Set(glyphs).size,
            8,
            `${ramp} repeats a glyph, so two ink levels are indistinguishable`
        )
    }
})

test('plate assignment partitions the ink levels and never regresses', () => {
    assert.equal(PLATE.length, RAMPS.binary.length)
    assert.equal(PLATE[0], 0, 'the empty level prints on no plate')
    for (let level = 1; level < PLATE.length; level++) {
        assert.ok(
            PLATE[level] >= 1 && PLATE[level] <= 3,
            `level ${level} must print on one of the three plates`
        )
        assert.ok(
            PLATE[level] >= PLATE[level - 1],
            'a darker ink level may never move to a lighter plate'
        )
    }
})

/* DESIGN.landing.md §3.4 L6. Every time term is sin(2π(… − n·t)) with an
   integer n, so the last frame of a loop equals the first one exactly. This
   is the test that keeps the seam invisible: adding a fractional time
   frequency to any shape fails here rather than in someone's eyes. */
test('every shape loops seamlessly: t=1 renders identically to t=0', () => {
    for (const shape of SHAPES) {
        const first = renderPlates({ shape, cols: 40, rows: 18, t: 0 })
        const last = renderPlates({ shape, cols: 40, rows: 18, t: 1 })
        assert.deepEqual(last, first, `${shape} jumps at the loop seam`)
    }
})

test('rendering is deterministic', () => {
    for (const shape of SHAPES) {
        const a = renderPlates({ shape, cols: 32, rows: 14, t: 0.37 })
        const b = renderPlates({ shape, cols: 32, rows: 14, t: 0.37 })
        assert.deepEqual(a, b)
    }
})

test('each plate is a full cols x rows block', () => {
    const cols = 26
    const rows = 11
    for (const shape of SHAPES) {
        for (const plate of renderPlates({ shape, cols, rows, t: 0.5 })) {
            const lines = plate.split('\n')
            assert.equal(lines.pop(), '', 'plate must end with a newline')
            assert.equal(lines.length, rows)
            for (const line of lines) assert.equal(line.length, cols)
        }
    }
})

test('the three plates never ink the same cell twice', () => {
    const cols = 30
    const rows = 13
    for (const shape of SHAPES) {
        const [light, mid, deep] = renderPlates({
            shape,
            cols,
            rows,
            t: 0.21
        })
        for (let i = 0; i < light.length; i++) {
            const inked = [light[i], mid[i], deep[i]].filter(
                (c) => c !== ' ' && c !== '\n'
            )
            assert.ok(
                inked.length <= 1,
                `${shape} overprints cell ${i} on ${inked.length} plates`
            )
        }
    }
})

test('a field uses more than two ink levels', () => {
    /* The whole point of the glyph ramp (§3.2): a field printed with one or
       two glyphs is a sheet of noise, not an image. */
    for (const shape of SHAPES) {
        const plates = renderPlates({
            shape,
            cols: 48,
            rows: 20,
            t: 0.33
        })
        const used = new Set(plates.join('').replace(/[ \n]/g, ''))
        assert.ok(
            used.size >= 3,
            `${shape} only reached ${used.size} ink level(s): ${[...used].join('')}`
        )
    }
})

test('the loop length stays inside the motion budget', () => {
    /* §3.4 L6: shorter than 8s reads as an animation, longer than 24s stops
       reading as motion at all. */
    assert.ok(LOOP_MS >= 8000 && LOOP_MS <= 24000)
})

test('ripple ring frequency stays inside the grid resolution limit', () => {
    /* One cell holds one glyph, so rings closer than ~3 cells alias into
       noise. Raising this constant is how the first pass turned to snow. */
    assert.ok(RIPPLE_MAX_WAVENUMBER <= 5)
})

test('the sphere renders round, not elliptical', () => {
    /* Guards CELL_ASPECT: drop the correction and the inked mass squashes. */
    const cols = 60
    const rows = 26
    const plates = renderPlates({ shape: 'sphere', cols, rows, t: 0 })
    const flat = plates.map((p) => p.split('\n').slice(0, rows))
    let minX = cols
    let maxX = -1
    let minY = rows
    let maxY = -1
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const inked = flat.some((lines) => lines[y][x] !== ' ')
            if (!inked) continue
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
        }
    }
    const width = maxX - minX + 1
    const height = (maxY - minY + 1) * CELL_ASPECT
    assert.ok(
        Math.abs(width / height - 1) < 0.16,
        `sphere bounding box is ${width}×${height.toFixed(1)} visual units`
    )
})

test('develop only ever lowers the ink, never raises it', () => {
    const opts = { shape: 'torus' as FieldShape, cols: 40, rows: 18, t: 0.25 }
    const ink = (plates: string[]): number =>
        plates.join('').replace(/[ \n]/g, '').length
    assert.ok(
        ink(renderPlates({ ...opts, develop: true })) < ink(renderPlates(opts)),
        'the loading pulse must fade the field in, not overexpose it'
    )
})

/* A small readable frame, kept as a golden so a stray constant change shows
   up as a diff rather than as a vague "it looks different". Regenerate it
   deliberately, never to make a red test pass. */
test('golden frame — ripple / wave / 24x10 / t=0.25', () => {
    assert.deepEqual(
        renderPlates({
            shape: 'ripple',
            ramp: 'wave',
            cols: 24,
            rows: 10,
            t: 0.25
        }),
        [
            '         ·    ·         \n' +
                '       · :····:··       \n' +
                '      ·:·  ··   :·      \n' +
                '     ··· : ·· · ···     \n' +
                '     ·:··  :·  ··:·     \n' +
                '     ·:··  ·:  ··:·     \n' +
                '     ··· · ·: : ···     \n' +
                '      ·:· :··:  :·      \n' +
                '       ··:····:··       \n' +
                '         ·    ·         \n',
            '                        \n' +
                '                        \n' +
                '         ~-  -~         \n' +
                '        ~      ~        \n' +
                '          ~             \n' +
                '          ~  ~          \n' +
                '        ~      ~        \n' +
                '         ~    ~         \n' +
                '                        \n' +
                '                        \n',
            '                        \n' +
                '                        \n' +
                '                        \n' +
                '          #  +          \n' +
                '         #   +#         \n' +
                '         #    #         \n' +
                '          +  +          \n' +
                '                        \n' +
                '                        \n' +
                '                        \n'
        ]
    )
})

test('sigil is deterministic, mirrored, and seed-specific', () => {
    const size = 9
    const a = sigilCells('release-notes', size)
    assert.equal(a.length, size * size)
    assert.deepEqual(a, sigilCells('release-notes', size))
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            assert.equal(
                a[y * size + x],
                a[y * size + (size - 1 - x)],
                'sigils must be left-right mirrored'
            )
        }
    }
    assert.notDeepEqual(a, sigilCells('inbox-triage', size))
    assert.ok(
        a.some((v) => v > 0),
        'a sigil may not come out blank'
    )
})
