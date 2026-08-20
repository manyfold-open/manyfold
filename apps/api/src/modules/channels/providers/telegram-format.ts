const escapeHtml = (text: string): string =>
    text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')

const markdownInlineToHtml = (text: string): string => {
    const placeholders: string[] = []
    const hold = (html: string): string => {
        const key = `\u0000${placeholders.length}\u0000`
        placeholders.push(html)
        return key
    }

    let rendered = text.replace(/`([^`\n]+)`/g, (_match, code: string) =>
        hold(`<code>${escapeHtml(code)}</code>`)
    )
    rendered = rendered.replace(
        /\[([^\]\n]+)\]\(([^)\n]+)\)/g,
        (_match, label: string, href: string) =>
            hold(`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`)
    )
    rendered = escapeHtml(rendered)
    rendered = rendered.replace(/\*\*\*([^*\n]+)\*\*\*/g, (_match, body) =>
        hold(`<b><i>${body}</i></b>`)
    )
    rendered = rendered.replace(/\*\*([^*\n]+)\*\*/g, (_match, body) =>
        hold(`<b>${body}</b>`)
    )
    rendered = rendered.replace(/__([^_\n]+)__/g, (_match, body) =>
        hold(`<b>${body}</b>`)
    )
    rendered = rendered.replace(/~~([^~\n]+)~~/g, (_match, body) =>
        hold(`<s>${body}</s>`)
    )
    rendered = rendered.replace(
        /(^|[^*])\*([^*\n]+)\*(?!\*)/g,
        (_match, prefix: string, body: string) =>
            `${prefix}${hold(`<i>${body}</i>`)}`
    )

    for (let pass = 0; pass <= placeholders.length; pass += 1) {
        let changed = false
        for (let i = 0; i < placeholders.length; i += 1) {
            const key = `\u0000${i}\u0000`
            if (!rendered.includes(key)) continue
            rendered = rendered.replace(key, placeholders[i])
            changed = true
        }
        if (!changed) break
    }
    return rendered
}

const codeBlockHtml = (language: string, lines: string[]): string => {
    const className = language.trim()
        ? ` class="language-${escapeHtml(language.trim())}"`
        : ''
    return `<pre><code${className}>${escapeHtml(lines.join('\n'))}</code></pre>`
}

export const markdownToTelegramHtml = (text: string): string => {
    const lines = text.split('\n')
    const rendered: string[] = []
    let fence: { marker: string; language: string; lines: string[] } | null =
        null
    let quoteLines: string[] = []

    const flushQuote = (): void => {
        if (quoteLines.length === 0) return
        rendered.push(
            `<blockquote>${quoteLines.map(markdownInlineToHtml).join('\n')}</blockquote>`
        )
        quoteLines = []
    }

    for (const line of lines) {
        if (fence) {
            const closing = line.trim().match(/^(`{3,}|~{3,})\s*$/)
            if (
                closing &&
                closing[1][0] === fence.marker[0] &&
                closing[1].length >= fence.marker.length
            ) {
                rendered.push(codeBlockHtml(fence.language, fence.lines))
                fence = null
            } else {
                fence.lines.push(line)
            }
            continue
        }

        const opening = line.trim().match(/^(`{3,}|~{3,})(.*)$/)
        if (opening) {
            flushQuote()
            fence = {
                marker: opening[1],
                language: opening[2],
                lines: []
            }
            continue
        }

        const quote = line.match(/^\s*>\s?(.*)$/)
        if (quote) {
            quoteLines.push(quote[1])
            continue
        }
        flushQuote()

        const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/)
        rendered.push(
            heading
                ? `<b>${markdownInlineToHtml(heading[1])}</b>`
                : markdownInlineToHtml(line)
        )
    }

    flushQuote()
    if (fence) rendered.push(codeBlockHtml(fence.language, fence.lines))
    return rendered.join('\n')
}
