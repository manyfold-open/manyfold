/* Fieldwork — the ASCII field engine (DESIGN.landing.md §3).
   Pure math + string building, no DOM: everything here is deterministic in
   (shape, ramp, cols, rows, t) so it can be golden-tested in plain Node. */

export type FieldShape =
    | 'ripple'
    | 'clouds'
    | 'torus'
    | 'sphere'
    | 'fold'
    | 'drift'

export type InkRamp = 'binary' | 'halftone' | 'wave'

const TAU = Math.PI * 2

/* One loop. Anything longer stops reading as motion, anything shorter starts
   reading as an animation instead of a field breathing (§3.4 L6). */
export const LOOP_MS = 12000

/* Cell aspect h/w. Geist Mono advances 0.6em, the field sets line-height .92
   and tracking .06em, so a cell is 1.36× taller than it is wide. Every shape
   corrects for it — without this a circle renders as an ellipse. */
export const CELL_ASPECT = 1.36

/* Eight glyphs = eight ink levels (§3.2). The ink comes from the glyph's own
   coverage, not from alpha, which is what gives a field light, volume and an
   edge. Each ramp MUST be ordered by real ink coverage, never by meaning. */
export const RAMPS: Record<InkRamp, readonly string[]> = {
    binary: [' ', '·', ':', '+', '1', '0', '8', '@'],
    halftone: [' ', '·', ':', 'o', '0', 'O', '8', '@'],
    wave: [' ', '·', ':', '-', '~', '+', '#', '@']
}

/* Ink level → ink plate. Levels 1–2 print on the light plate, 3–4 on the mid
   plate, 5–7 on the deep one; the three are overprinted like press
   separations so troughs, crests and specks each get their own layer. */
export const PLATE: readonly number[] = [0, 1, 1, 2, 2, 3, 3, 3]

const INK_LEVELS = RAMPS.binary.length - 1

/* Ripple ring wavenumbers have a hard ceiling: one cell holds one glyph, so a
   ring spacing under ~3 cells aliases into noise. On a ~22-cell radius k=5
   puts a ring every 4.4 cells, which is this grid's detail limit. The first
   pass used 8.5 and the whole field turned to snow. */
export const RIPPLE_MAX_WAVENUMBER = 5

/* [x, y, amplitude, wavenumber, time frequency]. The time frequency must stay
   an INTEGER — that is what makes t=1 identical to t=0 (§3.4 L6). */
const RIPPLE_SOURCES: readonly (readonly number[])[] = [
    [0, 0, 1, RIPPLE_MAX_WAVENUMBER, 3],
    [0.52, -0.32, 0.2, 7.5, -2],
    [-0.58, 0.4, 0.14, 3.5, 1]
]

/* Spectral synthesis: [kx, ky, amplitude, phase, integer time frequency].
   Integer kx makes the field tile horizontally, integer time frequency makes
   it loop, and the sum of six harmonics reads as organic cloud density. */
const CLOUD_HARMONICS: readonly (readonly number[])[] = [
    [1, 1, 0.5, 0, 1],
    [2, 1, 0.27, 1.7, -1],
    [3, 2, 0.18, 3.1, 2],
    [5, 2, 0.12, 0.6, -2],
    [8, 3, 0.075, 2.2, 3],
    [13, 4, 0.05, 4.4, -3]
]

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

const sstep = (a: number, b: number, v: number): number => {
    const t = clamp01((v - a) / (b - a))
    return t * t * (3 - 2 * t)
}

/* Coordinate hash. Glyph choice inside one ink level is allowed to be random,
   but it has to be a function of the cell — re-rolling per frame turns the
   field into static (§3.4 L2). */
export const hash2 = (x: number, y: number): number => {
    let h = (x | 0) * 374761393 + (y | 0) * 668265263
    h = (h ^ (h >> 13)) * 1274126177
    return ((h ^ (h >> 16)) >>> 0) / 4294967295
}

const vnoise = (x: number, y: number): number => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    const u = xf * xf * (3 - 2 * xf)
    const v = yf * yf * (3 - 2 * yf)
    const a = hash2(xi, yi)
    const b = hash2(xi + 1, yi)
    const c = hash2(xi, yi + 1)
    const d = hash2(xi + 1, yi + 1)
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v
}

/* Cloud density at normalised (x, y) and loop position t. Exported because
   the halftone painter drives its dot size from the same field, so the
   atmosphere and the subject share one weather system. */
export const cloudAt = (x: number, y: number, t: number): number => {
    let v = 0
    for (const [kx, ky, amp, phase, freq] of CLOUD_HARMONICS) {
        v +=
            amp *
            Math.sin(TAU * (kx * x + freq * t) + phase) *
            Math.cos(TAU * (ky * (y - 0.5) * 0.62) + phase * 1.3)
    }
    return v
}

type Sampler = (index: number) => number

/* Centre-origin coordinates, aspect corrected, short axis reaching ±1. */
const coords = (
    cols: number,
    rows: number
): ((i: number) => [number, number]) => {
    const cx = (cols - 1) / 2
    const cy = (rows - 1) / 2
    const r = Math.min(cols / 2, (rows * CELL_ASPECT) / 2)
    return (i) => [
        ((i % cols) - cx) / r,
        ((((i / cols) | 0) - cy) * CELL_ASPECT) / r
    ]
}

const ripple = (cols: number, rows: number, t: number): Sampler => {
    const at = coords(cols, rows)
    const phase = TAU * t
    return (i) => {
        const [x, y] = at(i)
        const r0 = Math.sqrt(x * x + y * y)
        const disc = sstep(1.2, 0.15, r0)
        if (disc <= 0) return 0
        let w = 0
        for (const [sx, sy, amp, k, freq] of RIPPLE_SOURCES) {
            const dx = x - sx
            const dy = y - sy
            const r = Math.sqrt(dx * dx + dy * dy)
            const env = (1 - 0.42 * r) * (1 - Math.exp(-r * 4.5))
            w += amp * env * Math.sin(TAU * (k * r - freq * t))
        }
        let v = disc * (0.16 + 0.84 * clamp01(0.5 + w * 0.8))
        /* The splash core is white, and white on paper means no ink — so the
           foam SUBTRACTS. Sampling the noise along (cos 2πt, sin 2πt) keeps
           the turbulence periodic without needing an integer-frequency term. */
        const foam = sstep(0.32, 0.04, r0)
        if (foam > 0) {
            const nz = vnoise(
                x * 7.5 + Math.cos(phase) * 1.6,
                y * 7.5 + Math.sin(phase) * 1.6
            )
            v *= 1 - foam * 0.72
            if (nz > 0.6) v = Math.max(v, foam * (0.42 + (nz - 0.6) * 1.65))
        }
        /* Droplets ride the surface, so they are anchored to the cell and
           never blink. */
        if (disc > 0.34 && hash2(i % cols, (i / cols) | 0) > 0.982) v = 1
        return v
    }
}

const clouds =
    (cols: number, rows: number, t: number): Sampler =>
    (i) => {
        const x = (i % cols) / cols
        const y = ((i / cols) | 0) / rows
        const body = sstep(-0.02, 0.4, cloudAt(x, y, t))
        return clamp01(body * 0.94 + 0.13 * sstep(0, 1, y))
    }

const torus = (cols: number, rows: number, t: number): Sampler => {
    const lum = new Float32Array(cols * rows)
    const depth = new Float32Array(cols * rows)
    const r1 = 1
    const r2 = 2
    const k2 = 5
    const k1 = Math.min(cols * 0.5, rows * 0.92)
    /* Both rotations complete exactly one turn over the loop. */
    const a = 1.02 + TAU * t
    const b = 0.52 + TAU * t
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const cb = Math.cos(b)
    const sb = Math.sin(b)
    for (let th = 0; th < TAU; th += 0.05) {
        const ct = Math.cos(th)
        const st = Math.sin(th)
        for (let ph = 0; ph < TAU; ph += 0.013) {
            const cp = Math.cos(ph)
            const sp = Math.sin(ph)
            const rx = r2 + r1 * ct
            const ry = r1 * st
            const x = rx * (cb * cp + sa * sb * sp) - ry * ca * sb
            const y = rx * (sb * cp - sa * cb * sp) + ry * ca * cb
            const z = k2 + ca * rx * sp + ry * sa
            const ooz = 1 / z
            const xp = (cols >> 1) + Math.round(k1 * ooz * x)
            const yp = (rows >> 1) - Math.round((k1 * ooz * y) / CELL_ASPECT)
            if (xp < 0 || xp >= cols || yp < 0 || yp >= rows) continue
            const l =
                cp * ct * sb -
                ca * ct * sp -
                sa * st +
                cb * (ca * st - ct * sa * sp)
            const i = yp * cols + xp
            if (ooz > depth[i]) {
                depth[i] = ooz
                lum[i] = l
            }
        }
    }
    return (i) => clamp01(lum[i] / 1.3)
}

const sphere = (cols: number, rows: number, t: number): Sampler => {
    const at = coords(cols, rows)
    const lx = -0.4
    const ly = -0.55
    const lz = 0.73
    return (i) => {
        const [x, y] = at(i)
        const d = (x * x + y * y) / 0.9
        if (d > 1) return 0
        const z = Math.sqrt(1 - d)
        const lam = clamp01(-(x * lx + y * ly) + z * lz)
        const band = 0.74 + 0.26 * Math.sin(6 * Math.atan2(x, z) - TAU * t)
        return clamp01(lam * band * (1 - Math.pow(d, 5) * 0.5))
    }
}

const fold =
    (cols: number, rows: number, t: number): Sampler =>
    (i) => {
        const x = (i % cols) / cols
        const y = ((i / cols) | 0) / rows
        const a =
            Math.sin(TAU * (x - t)) * 0.23 +
            Math.sin(TAU * (2 * x + 2 * t)) * 0.09
        const b = Math.sin(TAU * (x + t) + 1.9) * 0.18
        const b1 = sstep(0.17, 0, Math.abs(y - (0.5 + a)))
        const b2 = sstep(0.11, 0, Math.abs(y - (0.5 + b)))
        return clamp01(
            (b1 + b2 * 0.8) * sstep(0, 0.14, Math.min(x, 1 - x)) * 0.95
        )
    }

const drift =
    (cols: number, rows: number, t: number): Sampler =>
    (i) => {
        const x = (i % cols) / cols
        const y = ((i / cols) | 0) / rows
        let v =
            0.5 * Math.sin(TAU * (2 * x + t) + 0.4) * Math.cos(TAU * 1.5 * y)
        v +=
            0.3 *
            Math.sin(TAU * (5 * x - 2 * t) + 2.1) *
            Math.cos(TAU * 2.5 * y + 1)
        v += 0.2 * Math.sin(TAU * (9 * x + 3 * t) + 3.7)
        return clamp01(
            sstep(-0.1, 0.5, v) * sstep(0.55, 0.05, Math.abs(y - 0.5)) * 0.8
        )
    }

const SHAPES: Record<
    FieldShape,
    (cols: number, rows: number, t: number) => Sampler
> = { ripple, clouds, torus, sphere, fold, drift }

export interface PlateOptions {
    shape: FieldShape
    ramp?: InkRamp
    cols: number
    rows: number
    /* Loop position in [0, 1). t=1 renders identically to t=0. */
    t: number
    /* Loading state: pulses the whole field's ink up and down three times per
       loop, so the subject "develops" instead of spinning. */
    develop?: boolean
}

/* The three ink plates, light → deep. Each is a full cols×rows block where
   cells belonging to the other plates are spaces, so the three overprint
   into one image. Returning strings (not DOM) is what keeps a frame down to
   three textContent writes. */
export const renderPlates = ({
    shape,
    ramp = 'binary',
    cols,
    rows,
    t,
    develop = false
}: PlateOptions): [string, string, string] => {
    const sample = SHAPES[shape](cols, rows, t)
    const glyphs = RAMPS[ramp]
    const gain = develop ? 0.34 + 0.66 * (0.5 + 0.5 * Math.sin(TAU * t * 3)) : 1
    let light = ''
    let mid = ''
    let deep = ''
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const raw = Math.round(sample(y * cols + x) * gain * INK_LEVELS)
            const level = raw < 0 ? 0 : raw > INK_LEVELS ? INK_LEVELS : raw
            const glyph = glyphs[level]
            const plate = PLATE[level]
            light += plate === 1 ? glyph : ' '
            mid += plate === 2 ? glyph : ' '
            deep += plate === 3 ? glyph : ' '
        }
        light += '\n'
        mid += '\n'
        deep += '\n'
    }
    return [light, mid, deep]
}

/* Deterministic 9×9 identity mark, mirrored left-to-right. Three ink levels,
   same alphabet of density the fields use. Returns a flat row-major array of
   opacities so the caller can render it however it likes. */
export const sigilCells = (seed: string, size = 9): number[] => {
    let s = 0
    for (let i = 0; i < seed.length; i++) {
        s = (s * 31 + seed.charCodeAt(i)) >>> 0
    }
    const cells: number[] = []
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const mirrored = Math.min(x, size - 1 - x)
            const v = hash2(mirrored + (s % 97), y + ((s >> 7) % 89))
            cells.push(v > 0.6 ? 1 : v > 0.46 ? 0.62 : v > 0.34 ? 0.3 : 0)
        }
    }
    return cells
}
