/**
 * Shared outbound-text helpers for channel providers.
 *
 * `chunkText` splits a message to fit a platform's per-message character limit
 * without ever cutting through a Markdown code fence: when a fenced block spans
 * a boundary the fence is closed on the current chunk and reopened (with the same
 * marker + info string) on the next. Outside fences it prefers to break on a
 * blank line, then any newline, then a space — matching the previous per-provider
 * behaviour.
 *
 * `wrapMarkdownTables` wraps GitHub-style pipe tables in a ```text``` fence so
 * platforms that don't render Markdown tables (Discord, Telegram, Matrix) show
 * them monospaced and aligned instead of as noisy pipe soup.
 */

const OPEN_FENCE_RE = /^(`{3,}|~{3,})(.*)$/
const CLOSE_FENCE_RE = /^(`{3,}|~{3,})\s*$/

interface Segment {
    kind: 'text' | 'fence'
    body: string
    open?: string
    marker?: string
}

const parseSegments = (input: string): Segment[] => {
    const lines = input.split('\n')
    const segments: Segment[] = []
    let textLines: string[] = []
    let fence: { open: string; marker: string; body: string[] } | null = null

    const flushText = (): void => {
        if (textLines.length > 0) {
            segments.push({ kind: 'text', body: textLines.join('\n') })
            textLines = []
        }
    }

    for (const line of lines) {
        if (fence) {
            const close = line.match(CLOSE_FENCE_RE)
            if (
                close &&
                close[1][0] === fence.marker[0] &&
                close[1].length >= fence.marker.length
            ) {
                segments.push({
                    kind: 'fence',
                    open: fence.open,
                    marker: fence.marker,
                    body: fence.body.join('\n')
                })
                fence = null
            } else {
                fence.body.push(line)
            }
            continue
        }
        const open = line.match(OPEN_FENCE_RE)
        if (open) {
            flushText()
            fence = { open: line, marker: open[1], body: [] }
        } else {
            textLines.push(line)
        }
    }
    // Unterminated fence at EOF: keep it fenced so it renders as code anyway.
    if (fence)
        segments.push({
            kind: 'fence',
            open: fence.open,
            marker: fence.marker,
            body: fence.body.join('\n')
        })
    flushText()
    return segments
}

const splitPlain = (text: string, max: number): string[] => {
    if (text.length === 0) return []
    if (text.length <= max) return [text]
    const out: string[] = []
    let remaining = text
    while (remaining.length > max) {
        let cut = remaining.lastIndexOf('\n\n', max)
        if (cut < max / 2) cut = remaining.lastIndexOf('\n', max)
        if (cut < max / 2) cut = remaining.lastIndexOf(' ', max)
        if (cut <= 0) cut = max
        out.push(remaining.slice(0, cut))
        remaining = remaining.slice(cut).trimStart()
    }
    if (remaining.length > 0) out.push(remaining)
    return out
}

const splitFence = (seg: Segment, max: number): string[] => {
    const open = seg.open ?? '```'
    const marker = seg.marker ?? '```'
    const wrap = (body: string): string =>
        body.length === 0 ? `${open}\n${marker}` : `${open}\n${body}\n${marker}`
    const whole = wrap(seg.body)
    if (whole.length <= max) return [whole]
    // Room left for the code body once the open line, close marker and two
    // newlines are accounted for.
    const budget = max - open.length - marker.length - 2
    if (budget <= 0) return [whole]
    return splitPlain(seg.body, budget).map(wrap)
}

export const chunkText = (text: string, max: number): string[] => {
    if (max <= 0 || text.length <= max) return [text]

    const pieces: string[] = []
    for (const seg of parseSegments(text)) {
        if (seg.kind === 'fence') pieces.push(...splitFence(seg, max))
        else pieces.push(...splitPlain(seg.body, max))
    }

    const chunks: string[] = []
    let current = ''
    for (const piece of pieces) {
        if (current === '') current = piece
        else if (current.length + 1 + piece.length <= max)
            current = `${current}\n${piece}`
        else {
            chunks.push(current)
            current = piece
        }
    }
    if (current !== '') chunks.push(current)
    return chunks.length > 0 ? chunks : [text]
}

const isTableSeparator = (line: string): boolean =>
    line.includes('-') &&
    line.includes('|') &&
    /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line)

/**
 * Wrap GitHub-style pipe tables (a header row followed by a `|---|` separator)
 * in a ```text``` fence. Tables already inside a code fence are left untouched.
 */
export const wrapMarkdownTables = (text: string): string => {
    if (!text.includes('|')) return text
    const lines = text.split('\n')
    const out: string[] = []
    let fenceMarkerChar: string | null = null
    let i = 0
    while (i < lines.length) {
        const line = lines[i]
        const fence = line.match(OPEN_FENCE_RE)
        if (fenceMarkerChar) {
            out.push(line)
            if (fence && fence[1][0] === fenceMarkerChar && CLOSE_FENCE_RE.test(line))
                fenceMarkerChar = null
            i += 1
            continue
        }
        if (fence) {
            fenceMarkerChar = fence[1][0]
            out.push(line)
            i += 1
            continue
        }
        if (
            line.includes('|') &&
            i + 1 < lines.length &&
            isTableSeparator(lines[i + 1])
        ) {
            const block = [line, lines[i + 1]]
            let j = i + 2
            while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
                block.push(lines[j])
                j += 1
            }
            out.push('```text', ...block, '```')
            i = j
            continue
        }
        out.push(line)
        i += 1
    }
    return out.join('\n')
}
