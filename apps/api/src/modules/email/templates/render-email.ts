import {
    BRAND_NAME,
    BRAND_URL,
    DARK_PALETTE as D,
    DEFAULT_SIGNOFF,
    escapeHtml,
    FONT_STACK,
    headingText,
    LIGHT_PALETTE as L,
    MONO_STACK,
    safeUrl,
    type EmailBlock,
    type EmailContent,
    type RenderedEmail
} from '@/modules/email/templates/email-content'

/**
 * One description in, a multipart/alternative pair out. Callers hand both
 * halves to the provider (Resend takes `html` and `text` together); clients
 * that cannot render HTML fall back to the text half, which is why it is
 * generated from the same blocks rather than maintained by hand.
 */
export const renderEmail = (content: EmailContent): RenderedEmail => ({
    html: renderHtml(content),
    text: renderText(content)
})

const renderText = (content: EmailContent): string => {
    const lines: string[] = []
    if (content.greeting) lines.push(content.greeting.trim(), '')
    for (const block of content.blocks) lines.push(...textBlock(block), '')
    lines.push(content.signoff ?? DEFAULT_SIGNOFF)
    if (content.footerNote) lines.push('', content.footerNote.trim())
    lines.push('', `${BRAND_NAME} · ${BRAND_URL}`)
    return lines.join('\n')
}

/* Paragraphs stay on one line on purpose — the client reflows them to
   whatever width the reader actually has. URLs sit at column 0 so every
   autolinker picks them up whole. */
const textBlock = (block: EmailBlock): string[] => {
    switch (block.kind) {
        case 'paragraph':
        case 'note':
            return [block.text.trim()]
        case 'heading':
            return [`${headingText(block.text)}:`]
        case 'list':
            return block.items.map((item) => `· ${item.trim()}`)
        case 'linkList':
            return block.items.map(
                (item) => `· ${item.label.trim()}: ${item.url.trim()}`
            )
        case 'callout':
            return block.label
                ? [`${headingText(block.label)}:`, block.text.trim()]
                : [block.text.trim()]
        case 'code':
            return [block.value.trim()]
        case 'button':
            return [`${headingText(block.label)}:`, block.url.trim()]
    }
}

const AUTOLINK =
    /(https?:\/\/[^\s<]*[^\s<.,;:!?)\]}])|([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g

const LINK_STYLE = `color:${L.fg};text-decoration:underline`

/** Runs on already-escaped text, so `&amp;` inside a URL stays correct. */
const linkify = (escaped: string): string =>
    escaped.replace(AUTOLINK, (_match, url?: string, mail?: string) =>
        url
            ? `<a class="mf-link" href="${url}" style="${LINK_STYLE}">${url}</a>`
            : `<a class="mf-link" href="mailto:${mail}" style="${LINK_STYLE}">${mail}</a>`
    )

const text = (
    html: string,
    opts?: { size?: number; color?: string; cls?: string }
): string =>
    `<div class="${opts?.cls ?? 'mf-text'}" style="margin:0;font-family:${FONT_STACK};font-size:${opts?.size ?? 15}px;line-height:1.6;color:${opts?.color ?? L.fg};mso-line-height-rule:exactly">${html}</div>`

const row = (html: string, gap: number): string =>
    `<tr><td style="padding:0 0 ${gap}px">${html}</td></tr>`

const bulleted = (items: string[]): string =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items
        .map(
            (item) =>
                `<tr><td width="18" valign="top" style="width:18px;padding:0 0 8px">${text('&bull;', { color: L.subtle, cls: 'mf-subtle' })}</td><td valign="top" style="padding:0 0 8px">${text(item)}</td></tr>`
        )
        .join('')}</table>`

const htmlBlock = (block: EmailBlock): { html: string; gap: number } => {
    switch (block.kind) {
        case 'paragraph':
            return {
                html: text(linkify(escapeHtml(block.text.trim()))),
                gap: 16
            }
        case 'note':
            return {
                html: text(linkify(escapeHtml(block.text.trim())), {
                    size: 13,
                    color: L.muted,
                    cls: 'mf-muted'
                }),
                gap: 16
            }
        case 'heading':
            return {
                html: `<div class="mf-subtle" style="margin:0;font-family:${FONT_STACK};font-size:11px;font-weight:600;line-height:1.4;letter-spacing:0.07em;text-transform:uppercase;color:${L.subtle}">${escapeHtml(headingText(block.text))}</div>`,
                gap: 12
            }
        case 'list':
            return {
                html: bulleted(
                    block.items.map((item) => linkify(escapeHtml(item.trim())))
                ),
                gap: 10
            }
        case 'linkList':
            return {
                html: bulleted(
                    block.items.map(
                        (item) =>
                            `${escapeHtml(item.label.trim())} <a class="mf-link" href="${escapeHtml(safeUrl(item.url))}" style="${LINK_STYLE}">${escapeHtml(item.url.trim().replace(/^https?:\/\//, ''))}</a>`
                    )
                ),
                gap: 10
            }
        case 'callout':
            return {
                html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="mf-fill" style="background:${L.fill};border:1px solid ${L.ring};border-radius:10px;padding:14px 16px">${
                    block.label
                        ? `<div class="mf-subtle" style="margin:0 0 6px;font-family:${FONT_STACK};font-size:11px;font-weight:600;line-height:1.4;letter-spacing:0.07em;text-transform:uppercase;color:${L.subtle}">${escapeHtml(headingText(block.label))}</div>`
                        : ''
                }${text(linkify(escapeHtml(block.text.trim())))}</td></tr></table>`,
                gap: 20
            }
        case 'code':
            return {
                html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="mf-fill" align="center" style="background:${L.fill};border:1px solid ${L.ring};border-radius:10px;padding:18px 20px"><div class="mf-code" style="margin:0;font-family:${MONO_STACK};font-size:28px;font-weight:600;line-height:1.2;letter-spacing:0.16em;text-indent:0.16em;color:${L.fg}">${escapeHtml(block.value.trim())}</div></td></tr></table>`,
                gap: 22
            }
        case 'button':
            return {
                html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="mf-btn" bgcolor="${L.buttonBg}" style="background:${L.buttonBg};border-radius:10px"><a href="${escapeHtml(safeUrl(block.url))}" style="display:inline-block;padding:13px 24px;font-family:${FONT_STACK};font-size:15px;font-weight:600;line-height:1;color:${L.buttonFg};text-decoration:none;border-radius:10px">${escapeHtml(block.label.trim())}</a></td></tr></table>`,
                gap: 24
            }
    }
}

/* Zero-width joiner padding stops the inbox preview from spilling into the
   body copy after the preheader ends. */
const PREHEADER_PAD = '&#847;&zwnj;&nbsp;'.repeat(40)

const renderHtml = (content: EmailContent): string => {
    const rows = [
        ...(content.greeting
            ? [row(text(escapeHtml(content.greeting.trim())), 18)]
            : []),
        ...content.blocks.map((block) => {
            const { html, gap } = htmlBlock(block)
            return row(html, gap)
        }),
        row(
            text(escapeHtml(content.signoff ?? DEFAULT_SIGNOFF), {
                color: L.muted,
                cls: 'mf-muted'
            }),
            0
        )
    ].join('')

    const footer = [
        content.footerNote
            ? linkify(escapeHtml(content.footerNote.trim()))
            : null,
        `<a class="mf-flink" href="${BRAND_URL}" style="color:${L.subtle};text-decoration:underline">${BRAND_URL.replace(/^https?:\/\//, '')}</a>`
    ]
        .filter(Boolean)
        .join(' &middot; ')

    return `<!doctype html>
<html lang="en" style="margin:0;padding:0">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(content.preheader)}</title>
<!--[if mso]><style>*{font-family:Arial,Helvetica,sans-serif !important}</style><![endif]-->
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (max-width:620px){
.mf-pad{padding-left:22px !important;padding-right:22px !important}
.mf-shell{padding:20px 12px !important}
}
@media (prefers-color-scheme:dark){
.mf-floor{background:${D.floor} !important}
.mf-card{background:${D.card} !important;border-color:${D.ring} !important}
.mf-text{color:${D.fg} !important}
.mf-muted{color:${D.muted} !important}
.mf-subtle{color:${D.subtle} !important}
.mf-mark{color:${D.fg} !important}
.mf-code{color:${D.fg} !important}
.mf-link{color:${D.fg} !important}
.mf-flink{color:${D.subtle} !important}
.mf-fill{background:${D.fill} !important;border-color:${D.ring} !important}
.mf-btn{background:${D.buttonBg} !important}
.mf-btn a{color:${D.buttonFg} !important}
}
</style>
</head>
<body class="mf-floor" style="margin:0;padding:0;width:100%;background:${L.floor};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;overflow:hidden;line-height:1px;max-height:0;max-width:0;opacity:0;color:transparent;font-size:1px">${escapeHtml(content.preheader)}${PREHEADER_PAD}</div>
<table role="presentation" class="mf-floor" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${L.floor}">
<tr><td class="mf-shell" align="center" style="padding:36px 16px">
<!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto">
<tr><td class="mf-card" style="background:${L.card};border:1px solid ${L.ring};border-radius:14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td class="mf-pad" style="padding:30px 32px 0"><div class="mf-mark" style="font-family:${FONT_STACK};font-size:15px;font-weight:600;letter-spacing:-0.01em;line-height:1;color:${L.fg}">${BRAND_NAME}</div></td></tr>
<tr><td class="mf-pad" style="padding:24px 32px 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr>
</table>
</td></tr>
<tr><td class="mf-pad" style="padding:18px 32px 0"><div class="mf-subtle" style="font-family:${FONT_STACK};font-size:12px;line-height:1.6;color:${L.subtle}">${footer}</div></td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`
}
