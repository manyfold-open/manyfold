/**
 * The shape every product email is written in. Authors describe intent —
 * paragraph, list, callout, one call to action — and never touch markup or
 * line breaks; `renderEmail` turns one description into both an HTML body
 * and its plain-text alternative so the two can never drift apart.
 *
 * Line breaks are the renderer's business specifically because hand-wrapping
 * is what made the old plain-text-only mails look broken: mail clients render
 * text/plain with `white-space: pre-wrap`, so a body hard-wrapped at ~65
 * characters keeps every break on a 1400px screen and reads as a narrow
 * ragged column with sentences split down the middle.
 */
import {
    BRAND_NAME,
    DEFAULT_WEB_BASE_URL,
    SUPPORT_EMAIL
} from '@/common/brand'

export interface EmailLink {
    label: string
    url: string
}

export type EmailBlock =
    | { kind: 'paragraph'; text: string }
    | { kind: 'heading'; text: string }
    | { kind: 'list'; items: string[] }
    | { kind: 'linkList'; items: EmailLink[] }
    | { kind: 'callout'; label?: string; text: string }
    | { kind: 'code'; value: string }
    | { kind: 'button'; label: string; url: string }
    | { kind: 'note'; text: string }

export interface EmailContent {
    /**
     * The line inboxes preview next to the subject. Rendered into a hidden
     * element, so it must repeat nothing the reader will see twice.
     */
    preheader: string
    greeting?: string
    blocks: EmailBlock[]
    signoff?: string
    /** Small print under the card — support contact and sender identity. */
    footerNote?: string
}

export interface RenderedEmail {
    html: string
    text: string
}

export const DEFAULT_SIGNOFF = `— The ${BRAND_NAME} team`
export { BRAND_NAME, SUPPORT_EMAIL }
export const BRAND_URL = DEFAULT_WEB_BASE_URL

/* Web fonts are unreliable in mail clients (Outlook and Gmail both drop
   @font-face), so the product's Geist is not an option — a system stack is
   what actually renders as intended everywhere. */
export const FONT_STACK =
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"
export const MONO_STACK =
    "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace"

export interface EmailPalette {
    floor: string
    card: string
    ring: string
    fg: string
    muted: string
    subtle: string
    fill: string
    buttonBg: string
    buttonFg: string
}

/* Mirrors the app's cool-graphite ramp (apps/web/src/styles.css): the page
   floor is `--color-app-bg`, the card is `--color-surface-elevated` in light
   and `--color-surface` in dark, text is `--color-fg` / `--color-muted`. */
export const LIGHT_PALETTE: EmailPalette = {
    floor: '#d8dce0',
    card: '#f7fafc',
    ring: '#dadee3',
    fg: '#0a0c0f',
    muted: '#525861',
    subtle: '#6d747e',
    fill: '#e6e9ed',
    buttonBg: '#0a0c0f',
    buttonFg: '#f7fafc'
}

export const DARK_PALETTE: EmailPalette = {
    floor: '#07090c',
    card: '#20242a',
    ring: '#3a3f46',
    fg: '#e4e7ec',
    muted: '#b9bec6',
    subtle: '#7c838c',
    fill: '#2a2f36',
    buttonBg: '#e4e7ec',
    buttonFg: '#0a0c0f'
}

export const escapeHtml = (raw: string): string =>
    raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')

/** Anything that is not a link a mail client should follow becomes inert. */
export const safeUrl = (raw: string): string => {
    const trimmed = raw.trim()
    return /^(?:https?:|mailto:)/i.test(trimmed) ? trimmed : '#'
}

/** Headings are authored without punctuation; each renderer adds its own. */
export const headingText = (raw: string): string =>
    raw.trim().replace(/[:：]+$/, '')
