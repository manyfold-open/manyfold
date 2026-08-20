// Escape-first renderer: the whole input is HTML-escaped before any rule runs, so
// no attacker-controlled '<' can reach innerHTML. The agent quotes knowledge-base
// chunks verbatim, which makes that the load-bearing property here.
const escapeHtml = (value: string): string =>
    value.replace(
        /[&<>"]/g,
        (char) =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;'
            })[char] ?? char
    )

const SAFE_HREF = /^(https?:\/\/|\/|#)/

const linkTag = (href: string, label: string): string => {
    if (!SAFE_HREF.test(href)) return label
    const external = href.startsWith('http')
    const rel = external ? ' target="_blank" rel="noopener noreferrer"' : ''
    return `<a href="${href}"${rel}>${label}</a>`
}

// Inline code is parked behind a '<N>' marker while the emphasis and link rules
// run, so they cannot rewrite anything the author meant literally. The input is
// already HTML-escaped, so a bare '<' cannot occur in it and the marker is
// collision-proof; the tags injected below never match <digits>.
const inline = (text: string): string => {
    const codes: string[] = []
    let out = text.replace(/`([^`]+)`/g, (_match, code: string) => {
        codes.push(`<code>${code}</code>`)
        return `<${codes.length - 1}>`
    })
    out = out.replace(
        /\[([^\]]*)\]\(([^)\s]+)\)/g,
        (_match, label: string, href: string) => linkTag(href, label)
    )
    out = out.replace(
        /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
        (_match: string, lead: string, url: string) =>
            `${lead}${linkTag(url, url)}`
    )
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    out = out.replace(
        /<(\d+)>/g,
        (match: string, index: string) => codes[Number(index)] ?? match
    )
    return out
}

const tableRow = (line: string): string[] =>
    line
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim())

const isDivider = (line: string): boolean =>
    /^\|?[\s:-]*-[\s|:-]*\|?$/.test(line) && line.includes('-')

export const renderMarkdown = (source: string): string => {
    const lines = escapeHtml(source).split('\n')
    const out: string[] = []
    let index = 0

    while (index < lines.length) {
        const line = lines[index]

        const fence = /^\s*```(\S*)\s*$/.exec(line)
        if (fence) {
            const body: string[] = []
            index += 1
            while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
                body.push(lines[index])
                index += 1
            }
            index += 1
            const lang = fence[1] ? ` data-lang="${fence[1]}"` : ''
            out.push(
                `<figure class="docs-support-code"${lang}><pre><code>${body.join('\n')}</code></pre></figure>`
            )
            continue
        }

        if (!line.trim()) {
            index += 1
            continue
        }

        if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
            out.push('<hr />')
            index += 1
            continue
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
            const level = Math.min(heading[1].length + 2, 6)
            out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`)
            index += 1
            continue
        }

        if (/^\s*&gt;\s?/.test(line)) {
            const body: string[] = []
            while (index < lines.length && /^\s*&gt;\s?/.test(lines[index])) {
                body.push(lines[index].replace(/^\s*&gt;\s?/, ''))
                index += 1
            }
            out.push(`<blockquote>${inline(body.join(' '))}</blockquote>`)
            continue
        }

        if (
            line.includes('|') &&
            index + 1 < lines.length &&
            isDivider(lines[index + 1])
        ) {
            const head = tableRow(line)
            index += 2
            const body: string[][] = []
            while (index < lines.length && lines[index].includes('|')) {
                body.push(tableRow(lines[index]))
                index += 1
            }
            const headHtml = head.map((cell) => `<th>${inline(cell)}</th>`).join('')
            const bodyHtml = body
                .map(
                    (row) =>
                        `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`
                )
                .join('')
            out.push(
                `<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`
            )
            continue
        }

        const bullet = /^\s*([-*+])\s+(.*)$/.exec(line)
        const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
        if (bullet || ordered) {
            const tag = bullet ? 'ul' : 'ol'
            const items: string[] = []
            while (index < lines.length) {
                const current = lines[index]
                const match = bullet
                    ? /^\s*([-*+])\s+(.*)$/.exec(current)
                    : /^\s*(\d+)[.)]\s+(.*)$/.exec(current)
                if (match) {
                    items.push(match[2])
                    index += 1
                    continue
                }
                if (/^\s{2,}\S/.test(current) && items.length) {
                    items[items.length - 1] += ` ${current.trim()}`
                    index += 1
                    continue
                }
                break
            }
            out.push(
                `<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`
            )
            continue
        }

        const paragraph: string[] = []
        while (index < lines.length) {
            const current = lines[index]
            if (
                !current.trim() ||
                /^\s*```/.test(current) ||
                /^(#{1,6})\s+/.test(current) ||
                /^\s*&gt;\s?/.test(current) ||
                /^\s*([-*+])\s+/.test(current) ||
                /^\s*\d+[.)]\s+/.test(current)
            )
                break
            paragraph.push(current)
            index += 1
        }
        out.push(`<p>${inline(paragraph.join(' '))}</p>`)
    }

    return out.join('')
}