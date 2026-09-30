// Human list output: a header row, then aligned columns. A cell's width is
// its text's; its style (a kleur color) goes on after the padding, so escape
// codes never count. Scripts read --json, never this.
export type TableCell =
    | string
    | readonly [text: string, style: (text: string) => string]

type CodeRange = readonly [first: number, last: number]

// Combining marks, zero-width spaces and joiners, variation selectors.
const ZERO_WIDTH: readonly CodeRange[] = [
    [0x300, 0x36f],
    [0x200b, 0x200f],
    [0xfe00, 0xfe0f]
]

// Hangul Jamo, CJK and Yi, Hangul syllables, CJK compatibility, fullwidth
// forms, emoji, and the supplementary ideograph planes.
const DOUBLE_WIDTH: readonly CodeRange[] = [
    [0x1100, 0x115f],
    [0x2e80, 0xa4cf],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe30, 0xfe4f],
    [0xff00, 0xff60],
    [0xffe0, 0xffe6],
    [0x1f300, 0x1faff],
    [0x20000, 0x3fffd]
]

const inRanges = (code: number, ranges: readonly CodeRange[]): boolean =>
    ranges.some(([first, last]) => code >= first && code <= last)

export const displayWidth = (text: string): number => {
    let width = 0
    for (const char of text) {
        const code = char.codePointAt(0)!
        width += inRanges(code, ZERO_WIDTH)
            ? 0
            : inRanges(code, DOUBLE_WIDTH)
              ? 2
              : 1
    }
    return width
}

const textOf = (cell: TableCell): string =>
    typeof cell === 'string' ? cell : cell[0]

// Lines, the header first, so a caller can put a detail line after a row.
export const formatTable = (
    headers: readonly string[],
    rows: ReadonlyArray<readonly TableCell[]>
): string[] => {
    const widths = headers.map((header, column) =>
        Math.max(
            displayWidth(header),
            ...rows.map((row) => displayWidth(textOf(row[column] ?? '')))
        )
    )
    const render = (cells: readonly TableCell[]): string =>
        cells
            .map((cell, column) => {
                const text = textOf(cell)
                const styled = typeof cell === 'string' ? text : cell[1](text)
                return column === cells.length - 1
                    ? styled
                    : styled +
                          ' '.repeat(widths[column]! - displayWidth(text))
            })
            .join('  ')
            .trimEnd()
    return [render(headers), ...rows.map(render)]
}
