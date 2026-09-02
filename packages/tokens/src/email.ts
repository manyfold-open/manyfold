import { resolveRgb } from './contrast'
import { productColors } from './product-colors'
import type { Theme } from './parse'
import type { Rgb } from './types'

/** The email palette is the one consumer that cannot read a CSS variable:
    Gmail and Outlook strip custom properties, so every colour has to be a
    literal hex in the markup. That made it a fourth place where the ramp was
    transcribed by hand — and it fell behind. Measured [2026-09-02]: dark mode
    still matched the webapp exactly, while five light values had been left on
    the pre-`ramp moved toward white` numbers.

    So each field declares the product token it mirrors, and the hex is
    derived. Where it currently disagrees, the live value stays in `drift`
    with a reason, so adopting this module changes no email anyone receives.
    Resolving one means deleting its `drift` block. */
export interface EmailField {
    /** The product token this field mirrors. A pair when the two themes
        legitimately point at different tiers. */
    readonly token: string | { readonly light: string; readonly dark: string }
    readonly note?: string
    readonly drift?: {
        readonly light?: Rgb
        readonly dark?: Rgb
        readonly reason: string
    }
}

export const emailFields = {
    floor: {
        token: '--color-app-bg',
        note: '邮件外层地板',
        drift: {
            light: [216, 220, 224],
            reason: '停留在色阶向白移动之前的旧值（webapp 现为 222 226 230）'
        }
    },
    card: {
        token: {
            light: '--color-surface-elevated',
            dark: '--color-surface'
        },
        note: '正文卡面',
        drift: {
            light: [247, 250, 252],
            reason: '同 floor，落后于 webapp 的 253 254 255'
        }
    },
    ring: {
        token: '--color-divider',
        note: '卡面与内嵌块的 1px 边',
        drift: {
            light: [218, 222, 227],
            reason: '同 floor，落后于 webapp 的 225 229 234'
        }
    },
    fg: { token: '--color-fg', note: '正文主色' },
    muted: { token: '--color-muted', note: '次级正文' },
    subtle: { token: '--color-subtle', note: '元信息' },
    fill: {
        token: {
            light: '--color-surface-subtle',
            dark: '--color-surface-elevated'
        },
        note: '代码块 / 验证码的底',
        drift: {
            light: [230, 233, 237],
            reason: '浅色比 --color-surface-subtle 低 5 个单位。深色恰好等于 --color-surface-elevated，两侧对应的层级本就不同，统一前需要一个设计决定'
        }
    },
    buttonBg: { token: '--color-strong', note: '主按钮填充' },
    buttonFg: {
        token: '--color-strong-fg',
        note: '主按钮前景',
        drift: {
            light: [247, 250, 252],
            dark: [10, 12, 15],
            reason: '两侧都不等于 --color-strong-fg：浅色用近白而非纯白（docs 的同名 token 也这么做，取 --lp-paper，所以可能是有意的一致选择），深色比 14 17 21 更深。统一前需要确认哪个是意图'
        }
    }
} satisfies Record<string, EmailField>

export type EmailPaletteKey = keyof typeof emailFields

const toHex = (rgb: readonly number[]) =>
    '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('')

function tokenFor(field: EmailField, theme: Theme): string {
    return typeof field.token === 'string' ? field.token : field.token[theme]
}

/** Resolves the palette for one theme into the literal hexes the templates
    inline. Values recorded as drift win, so this returns exactly what the
    templates carried before they consumed this module. */
export function emailPalette(theme: Theme): Record<EmailPaletteKey, string> {
    const out = {} as Record<EmailPaletteKey, string>
    for (const [key, field] of Object.entries(emailFields) as Array<
        [EmailPaletteKey, EmailField]
    >) {
        const held = field.drift?.[theme]
        if (held) {
            out[key] = toHex(held)
            continue
        }
        const rgb = resolveRgb(
            productColors,
            tokenFor(field, theme),
            'web',
            theme
        )
        if (!rgb)
            throw new Error(
                `email palette: ${key} maps to ${tokenFor(field, theme)}, which is not a plain colour in the ${theme} theme`
            )
        out[key] = toHex(rgb)
    }
    return out
}

/** Fields whose live value still disagrees with the token they mirror. */
export function listEmailDrift(): Array<{
    field: EmailPaletteKey
    theme: Theme
    reason: string
}> {
    const out: Array<{ field: EmailPaletteKey; theme: Theme; reason: string }> =
        []
    for (const [key, field] of Object.entries(emailFields) as Array<
        [EmailPaletteKey, EmailField]
    >) {
        for (const theme of ['light', 'dark'] as Theme[]) {
            if (field.drift?.[theme])
                out.push({ field: key, theme, reason: field.drift.reason })
        }
    }
    return out
}
