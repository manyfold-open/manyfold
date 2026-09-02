import { iris } from './palette'
import type { TokenTable } from './types'

/** Landing-register colour tokens — the `--lp-*` scope.

    Kept separate from `productColors` because the two registers are still
    two token sets by design (DESIGN.landing.md §0.2): `--lp-*` is scoped to
    `.landing-root` and cannot leak into the app shell, nor the reverse.
    What they now share is the ramp underneath — `iris` and the Ash curve
    live in `palette.ts`, so aligning the product with landing means
    pointing at the same steps rather than copying values across.

    Fieldwork's 32 tokens (`--lp-field*`, `--lp-w-*`, `--lp-ht-*`) are
    deliberately absent: they are landing-only and the product does not
    adopt the ASCII field at all. */
export const landingColors: TokenTable = {
    '--lp-bg': {
        note: '页面画布',
        light: [244, 244, 246],
        dark: [10, 10, 12]
    },
    '--lp-bg-deep': {
        note: '下沉带 / footer',
        light: [231, 232, 234],
        dark: [5, 5, 6]
    },
    '--lp-bg-soft': {
        note: '交替分区',
        light: [249, 249, 251],
        dark: [16, 16, 19]
    },
    '--lp-error': {
        note: '失败 / 破坏性',
        light: [221, 61, 52],
        dark: [255, 122, 112]
    },
    '--lp-error-bg': {
        light: { raw: 'rgba(221, 61, 52, 0.09)' },
        dark: { raw: 'rgba(255, 122, 112, 0.13)' }
    },
    '--lp-error-strong': {
        light: [184, 44, 37],
        dark: [242, 85, 75]
    },
    '--lp-faint': {
        note: '计量条标签 / 禁用读数',
        light: [184, 185, 191],
        dark: [64, 66, 72]
    },
    '--lp-focus-rgb': {
        light: { raw: 'var(--lp-iris-600-rgb)' },
        dark: { raw: 'var(--lp-iris-400-rgb)' }
    },
    '--lp-idle': {
        note: '空闲 / 禁用',
        light: [154, 157, 178],
        dark: [109, 112, 133]
    },
    '--lp-idle-bg': {
        light: { raw: 'rgba(154, 157, 178, 0.13)' },
        dark: { raw: 'rgba(109, 112, 133, 0.16)' }
    },
    '--lp-info': {
        note: '品牌色 = info 状态色',
        light: { raw: 'var(--lp-iris-600)' },
        dark: { raw: 'var(--lp-iris-400)' }
    },
    '--lp-info-bg': {
        light: { raw: 'rgb(var(--lp-iris-600-rgb) / 0.1)' },
        dark: { raw: 'rgb(var(--lp-iris-400-rgb) / 0.16)' }
    },
    '--lp-info-strong': {
        light: { raw: 'var(--lp-iris-700)' },
        dark: { raw: 'var(--lp-iris-300)' }
    },
    '--lp-ink': {
        note: '标题正文主色',
        light: [16, 16, 19],
        dark: [237, 237, 239]
    },
    '--lp-ink-soft': {
        note: '引导段 lead',
        light: [42, 43, 48],
        dark: [198, 199, 203]
    },
    '--lp-iris-100': {
        light: [...iris[100]],
        dark: [...iris[100]]
    },
    '--lp-iris-200': {
        light: [...iris[200]],
        dark: [...iris[200]]
    },
    '--lp-iris-300': {
        light: [...iris[300]],
        dark: [...iris[300]]
    },
    '--lp-iris-300-rgb': {
        light: [...iris[300]],
        dark: [...iris[300]]
    },
    '--lp-iris-400': {
        light: [...iris[400]],
        dark: [...iris[400]]
    },
    '--lp-iris-400-rgb': {
        light: [...iris[400]],
        dark: [...iris[400]]
    },
    '--lp-iris-50': {
        light: [...iris[50]],
        dark: [...iris[50]]
    },
    '--lp-iris-500': {
        light: [...iris[500]],
        dark: [...iris[500]]
    },
    '--lp-iris-600': {
        light: [...iris[600]],
        dark: [...iris[600]]
    },
    '--lp-iris-600-rgb': {
        light: [...iris[600]],
        dark: [...iris[600]]
    },
    '--lp-iris-700': {
        light: [...iris[700]],
        dark: [...iris[700]]
    },
    '--lp-iris-700-rgb': {
        light: [...iris[700]],
        dark: [...iris[700]]
    },
    '--lp-iris-800': {
        light: [...iris[800]],
        dark: [...iris[800]]
    },
    '--lp-iris-900': {
        light: [...iris[900]],
        dark: [...iris[900]]
    },
    '--lp-line': {
        light: { raw: 'rgba(16, 16, 22, 0.12)' },
        dark: { raw: 'rgba(232, 232, 238, 0.13)' }
    },
    '--lp-line-soft': {
        light: { raw: 'rgba(16, 16, 22, 0.07)' },
        dark: { raw: 'rgba(232, 232, 238, 0.07)' }
    },
    '--lp-line-strong': {
        light: { raw: 'rgba(16, 16, 22, 0.22)' },
        dark: { raw: 'rgba(232, 232, 238, 0.24)' }
    },
    '--lp-muted': {
        note: '次级正文',
        light: [92, 94, 102],
        dark: [140, 142, 150]
    },
    '--lp-paper': {
        note: '卡面',
        light: [252, 252, 253],
        dark: [22, 23, 25]
    },
    '--lp-paper-warm': {
        note: '抬升卡面 / popover',
        light: [255, 255, 255],
        dark: [30, 31, 35]
    },
    '--lp-subtle': {
        note: '元信息 caption',
        light: [141, 143, 151],
        dark: [98, 100, 107]
    },
    '--lp-success': {
        note: '成功 / 已交付',
        light: [18, 167, 92],
        dark: [59, 211, 131]
    },
    '--lp-success-bg': {
        light: { raw: 'rgba(18, 167, 92, 0.1)' },
        dark: { raw: 'rgba(59, 211, 131, 0.14)' }
    },
    '--lp-success-soft': {
        light: { raw: 'var(--lp-success-bg)' },
        dark: { raw: 'var(--lp-success-bg)' }
    },
    '--lp-success-strong': {
        light: [11, 133, 72],
        dark: [34, 196, 111]
    },
    '--lp-warning': {
        note: '排队 / 待处理',
        light: [200, 129, 28],
        dark: [239, 180, 94]
    },
    '--lp-warning-bg': {
        light: { raw: 'rgba(200, 129, 28, 0.1)' },
        dark: { raw: 'rgba(239, 180, 94, 0.16)' }
    },
    '--lp-warning-strong': {
        light: [160, 103, 20],
        dark: [233, 162, 59]
    }
}
