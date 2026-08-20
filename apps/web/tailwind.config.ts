import type { Config } from 'tailwindcss'
import typography from '@tailwindcss/typography'

const config: Config = {
    content: ['./index.html', './src/**/*.{ts,tsx}'],
    darkMode: ['selector', '[data-theme="dark"]'],
    theme: {
        extend: {
            colors: {
                fg: 'rgb(var(--color-fg) / <alpha-value>)',
                muted: 'rgb(var(--color-muted) / <alpha-value>)',
                subtle: 'rgb(var(--color-subtle) / <alpha-value>)',
                placeholder: 'rgb(var(--color-placeholder) / <alpha-value>)',
                divider: 'rgb(var(--color-divider) / <alpha-value>)',
                surface: {
                    DEFAULT: 'rgb(var(--color-surface) / <alpha-value>)',
                    subtle: 'rgb(var(--color-surface-subtle) / <alpha-value>)',
                    elevated:
                        'rgb(var(--color-surface-elevated) / <alpha-value>)',
                    hover: 'rgb(var(--color-surface-hover) / <alpha-value>)'
                },
                app: 'rgb(var(--color-app-bg) / <alpha-value>)',
                main: 'rgb(var(--color-main-bg) / <alpha-value>)',
                rail: {
                    DEFAULT: 'rgb(var(--color-rail) / <alpha-value>)',
                    hover: 'rgb(var(--color-rail-hover) / <alpha-value>)'
                },
                soft: {
                    DEFAULT: 'rgb(var(--color-soft) / <alpha-value>)',
                    hover: 'rgb(var(--color-soft-hover) / <alpha-value>)'
                },
                /* Neutral tag fill (§8.3 tag family — ringless ink wash;
                   the token is a full color, not an RGB triplet). */
                'tag-bg': 'var(--color-tag-bg)',
                /* Active session fill — used inside an active agent
                   block to mark the currently-open chat. Tone lifts
                   above the block in both themes. */
                'active-session': 'rgb(var(--color-active-session) / <alpha-value>)',
                strong: {
                    DEFAULT: 'rgb(var(--color-strong) / <alpha-value>)',
                    hover: 'rgb(var(--color-strong-hover) / <alpha-value>)',
                    fg: 'rgb(var(--color-strong-fg) / <alpha-value>)'
                },
                /* Status spectrum (DESIGN.md §4.1 / §10.6).
                   Each role has: DEFAULT (solid fg), bg (banner tint),
                   strong (saturated pressed/highlight). Use bg-info /
                   text-info / bg-info-bg / bg-info-strong, etc. */
                info: {
                    DEFAULT: 'rgb(var(--color-info) / <alpha-value>)',
                    bg: 'rgb(var(--color-info-bg) / <alpha-value>)',
                    strong: 'rgb(var(--color-info-strong) / <alpha-value>)'
                },
                success: {
                    DEFAULT: 'rgb(var(--color-success) / <alpha-value>)',
                    bg: 'rgb(var(--color-success-bg) / <alpha-value>)',
                    strong: 'rgb(var(--color-success-strong) / <alpha-value>)'
                },
                warning: {
                    DEFAULT: 'rgb(var(--color-warning) / <alpha-value>)',
                    bg: 'rgb(var(--color-warning-bg) / <alpha-value>)',
                    strong: 'rgb(var(--color-warning-strong) / <alpha-value>)'
                },
                error: {
                    DEFAULT: 'rgb(var(--color-error) / <alpha-value>)',
                    bg: 'rgb(var(--color-error-bg) / <alpha-value>)',
                    strong: 'rgb(var(--color-error-strong) / <alpha-value>)'
                },
                idle: {
                    DEFAULT: 'rgb(var(--color-idle) / <alpha-value>)',
                    bg: 'rgb(var(--color-idle-bg) / <alpha-value>)'
                },
                /* Legacy aliases — bg-danger-bg and bg-danger-hover are
                   used widely in the app today; they resolve via the
                   --color-danger-* aliases declared in styles.css. */
                danger: {
                    bg: 'rgb(var(--color-danger-bg) / <alpha-value>)',
                    hover: 'rgb(var(--color-danger-hover) / <alpha-value>)'
                },
                avatar: {
                    bg: 'rgb(var(--color-avatar-bg) / <alpha-value>)',
                    fg: 'rgb(var(--color-avatar-fg) / <alpha-value>)'
                },
                icon: {
                    bg: 'rgb(var(--color-icon-bg) / <alpha-value>)',
                    fg: 'rgb(var(--color-icon-fg) / <alpha-value>)'
                },
                link: 'rgb(var(--color-link) / <alpha-value>)',
                focus: 'rgb(var(--color-focus) / <alpha-value>)',
                badge: {
                    bg: 'rgb(var(--color-badge-bg) / <alpha-value>)',
                    text: 'rgb(var(--color-badge-text) / <alpha-value>)'
                },
                workflow: {
                    develop:
                        'rgb(var(--color-workflow-develop) / <alpha-value>)',
                    preview:
                        'rgb(var(--color-workflow-preview) / <alpha-value>)',
                    ship: 'rgb(var(--color-workflow-ship) / <alpha-value>)'
                }
            },
            fontFamily: {
                sans: [
                    'Geist',
                    '-apple-system',
                    'BlinkMacSystemFont',
                    'Segoe UI',
                    'Roboto',
                    'Arial',
                    'sans-serif'
                ],
                mono: [
                    'Geist Mono',
                    'ui-monospace',
                    'SFMono-Regular',
                    'Menlo',
                    'Monaco',
                    'Courier New',
                    'monospace'
                ]
            },
            /* Sizes come from the per-mode ramp in styles.css, not from
               scaling one base — see the [data-font-size] blocks there for
               the three columns and why they are px. Line-height, tracking
               and weight stay here: they are unitless or em, so they follow
               whatever size the mode resolves to. */
            fontSize: {
                display: [
                    'var(--text-display)',
                    {
                        lineHeight: '1.15',
                        letterSpacing: '-0.025em',
                        fontWeight: '500'
                    }
                ],
                h1: [
                    'var(--text-h1)',
                    {
                        lineHeight: '1.25',
                        letterSpacing: '-0.02em',
                        fontWeight: '500'
                    }
                ],
                h2: [
                    'var(--text-h2)',
                    {
                        lineHeight: '1.3',
                        letterSpacing: '-0.015em',
                        fontWeight: '500'
                    }
                ],
                h3: [
                    'var(--text-h3)',
                    {
                        lineHeight: '1.4',
                        letterSpacing: '-0.01em',
                        fontWeight: '500'
                    }
                ],
                body: ['var(--text-body)', { lineHeight: '1.5' }],
                chat: 'var(--text-chat)',
                ui: ['var(--text-ui)', { lineHeight: '1.43' }],
                caption: ['var(--text-caption)', { lineHeight: '1.33' }],
                code: ['var(--text-code)', { lineHeight: '1.6' }]
            },
            /* Product radius scale (DESIGN.md §6.1).
               Three working tiers — 14 / 10 / 8 — with Pill on top.
               **14 is the ceiling** for every card, panel, popover,
               dropdown, modal, and the chat shell in the product; only
               the chat composer goes rounder (pinned at 18px via its own
               .chat-composer-card class). The old 18 card tier was pulled
               down to 14 so dense pages split into many cards/boxes read
               crisp instead of bubbly:
                 Xs  8  micro-token glyphs: count badges, inline code
                        highlights, single-letter status dots, anything
                        that reads as "a glyph, not a surface"
                 Sm 10  small components + inner elements: buttons,
                        small banners / notes / alerts, form controls,
                        list rows, menu items, tool-call & code blocks,
                        in-card chips
                 Md 14  cards, panels, popover / dropdown / menu panels,
                        modals, the chat shell, settings & content cards,
                        stat / choice cards
                 Lg / Xl / 2xl / 3xl  collapse to 14 — the product has
                        no surface rounder than 14 (the composer excepted).
               Concentric nesting (§6.3): the tight binding case is the
               dropdown — panel 14 − 4px gutter = inner 10. Cards use
               generous padding, so the rule there is informational.
               Landing (`.lp-*`) reads `--lp-r-*` directly from styles.css
               and keeps its 24 / 28 / 32 hero tiers — see DESIGN.md §6.1. */
            borderRadius: {
                DEFAULT: '10px',
                xs: '8px',
                sm: '10px',
                md: '14px',
                lg: '20px',
                xl: '24px',
                '2xl': '28px',
                '3xl': '32px',
                pill: '9999px'
            },
            boxShadow: {
                ring: 'var(--shadow-ring)',
                'ring-light': 'var(--shadow-ring-light)',
                'ring-hover': 'var(--shadow-ring-hover)',
                card: 'var(--shadow-card)',
                elevated: 'var(--shadow-elevated)',
                focus: 'var(--shadow-focus)',
                'focus-inset': 'var(--shadow-focus-inset)'
            },
            /* Markdown prose theme for chat messages + .md previews.
               All colors point at the CSS-var tokens so the palette
               flips with [data-theme="dark"] automatically — no
               prose-invert needed. Heading sizes track the §fontSize
               tokens so markdown headings read like app headings, not
               article titles. Code/pre are NOT styled here — the chat
               CodeBlock owns them inside a `not-prose` boundary. */
            typography: {
                DEFAULT: {
                    css: {
                        maxWidth: 'none',
                        color: 'rgb(var(--color-fg))',
                        fontSize: 'var(--text-chat)' /* DESIGN.md §5 */,
                        lineHeight: '1.7',
                        '--tw-prose-body': 'rgb(var(--color-fg))',
                        '--tw-prose-headings': 'rgb(var(--color-fg))',
                        '--tw-prose-lead': 'rgb(var(--color-muted))',
                        '--tw-prose-links': 'rgb(var(--color-link))',
                        '--tw-prose-bold': 'rgb(var(--color-fg))',
                        '--tw-prose-counters': 'rgb(var(--color-subtle))',
                        '--tw-prose-bullets': 'rgb(var(--color-subtle))',
                        '--tw-prose-hr': 'rgb(var(--color-divider))',
                        '--tw-prose-quotes': 'rgb(var(--color-muted))',
                        '--tw-prose-quote-borders':
                            'rgb(var(--color-divider))',
                        '--tw-prose-captions': 'rgb(var(--color-subtle))',
                        '--tw-prose-code': 'rgb(var(--color-fg))',
                        '--tw-prose-th-borders': 'rgb(var(--color-divider))',
                        '--tw-prose-td-borders': 'rgb(var(--color-divider))',
                        'code::before': { content: 'none' },
                        'code::after': { content: 'none' },
                        code: {
                            fontSize: 'var(--text-code)',
                            fontWeight: '400'
                        },
                        strong: {
                            fontWeight: '500'
                        },
                        p: {
                            marginTop: '0.55em',
                            marginBottom: '0.55em'
                        },
                        'ul, ol': {
                            marginTop: '0.75em',
                            marginBottom: '0.75em'
                        },
                        li: {
                            marginTop: '0.25em',
                            marginBottom: '0.25em'
                        },
                        'li > ul, li > ol': {
                            marginTop: '0.25em',
                            marginBottom: '0.25em'
                        },
                        del: {
                            color: 'rgb(var(--color-muted))'
                        },
                        hr: {
                            marginTop: '1.5em',
                            marginBottom: '1.5em'
                        },
                        table: {
                            marginTop: '0',
                            marginBottom: '0'
                        },
                        h1: {
                            fontSize: 'var(--text-h2)',
                            lineHeight: '1.25',
                            letterSpacing: '-0.02em',
                            fontWeight: '500',
                            marginTop: '0.8em',
                            marginBottom: '0.45em'
                        },
                        h2: {
                            fontSize: 'var(--text-h3)',
                            lineHeight: '1.3',
                            letterSpacing: '-0.015em',
                            fontWeight: '500',
                            marginTop: '0.75em',
                            marginBottom: '0.4em'
                        },
                        h3: {
                            fontSize: 'var(--text-body)',
                            lineHeight: '1.4',
                            letterSpacing: '-0.01em',
                            fontWeight: '500',
                            marginTop: '0.7em',
                            marginBottom: '0.35em'
                        },
                        'h4, h5, h6': {
                            fontSize: 'var(--text-chat)',
                            fontWeight: '500',
                            marginTop: '0.65em',
                            marginBottom: '0.35em'
                        },
                        /* Code in a heading takes the next rung down rather
                           than the code token, so it holds its own against
                           the heading instead of reading as a mis-tagged run
                           of body text. Named rungs, not an em ratio: the
                           ramp compresses at the ends, so its gaps are not
                           proportional and one ratio per level would land on
                           fractions outside default mode. */
                        'h1 code': { fontSize: 'var(--text-h3)' },
                        'h2 code': { fontSize: 'var(--text-body)' },
                        'h3 code': { fontSize: 'var(--text-chat)' },
                        'h4 code, h5 code, h6 code': {
                            fontSize: 'var(--text-code)'
                        },
                        blockquote: {
                            fontStyle: 'normal',
                            fontWeight: '400'
                        },
                        'blockquote p:first-of-type::before': {
                            content: 'none'
                        },
                        'blockquote p:last-of-type::after': {
                            content: 'none'
                        }
                    }
                }
            }
        }
    },
    plugins: [typography]
}

export default config
