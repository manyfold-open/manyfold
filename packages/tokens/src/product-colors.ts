import type { TokenTable } from './types'

/** Product-register colour tokens — the single definition site for every
    `--color-*` the webapp and the docs site consume.

    Values are exactly what the two baselines carried before this package
    existed, so introducing it renders identically. Where the two
    disagreed, the difference is now an explicit `override` carrying a
    reason instead of sitting silently in two files. The ones marked
    `drift: true` are believed accidental and await their own decision —
    run `pnpm tokens:drift` for the list. */
export const productColors: TokenTable = {
    '--color-active-session': {
        only: ['web'],
        light: { raw: 'var(--color-rail-hover)' },
        dark: { raw: 'var(--color-rail-hover)' }
    },
    '--color-app': {
        only: ['docs'],
        light: [222, 226, 230],
        dark: [7, 9, 12]
    },
    '--color-app-bg': {
        note: '页面地板',
        only: ['web'],
        light: [222, 226, 230],
        dark: [7, 9, 12]
    },
    '--color-avatar-bg': {
        only: ['web'],
        light: [220, 224, 228],
        dark: [44, 50, 58]
    },
    '--color-avatar-fg': {
        only: ['web'],
        light: [31, 36, 44],
        dark: [228, 231, 236]
    },
    '--color-badge-bg': {
        light: { raw: 'var(--color-info-bg)' },
        dark: { raw: 'var(--color-info-bg)' }
    },
    '--color-badge-text': {
        light: { raw: 'var(--color-info-strong)' },
        dark: { raw: 'var(--color-info)' }
    },
    '--color-danger-bg': {
        light: { raw: 'var(--color-error-bg)' },
        dark: { raw: 'var(--color-error-bg)' }
    },
    '--color-danger-fg': {
        only: ['docs'],
        light: { raw: 'var(--color-error-strong)' },
        dark: { raw: 'var(--color-error)' }
    },
    '--color-danger-hover': {
        light: [245, 220, 216],
        dark: [82, 44, 40],
        overrides: {
            docs: {
                light: [244, 218, 213],
                reason: '无出处的 1–3 单位差，疑为单侧改动',
                drift: true
            }
        }
    },
    '--color-disabled-control': {
        only: ['web'],
        light: [200, 204, 209],
        dark: [64, 70, 78]
    },
    '--color-divider': {
        note: '分隔线',
        light: [225, 229, 234],
        dark: [58, 63, 70],
        overrides: {
            docs: {
                light: { raw: 'rgba(10, 12, 15, 0.18)' },
                dark: { raw: 'rgba(255, 255, 255, 0.13)' },
                reason: '两侧都是有意：docs 用半透明墨线以便叠在多种背景上，并另有 --color-divider-soft 半强度档；webapp 用不透明色精确控制',
                drift: false
            }
        }
    },
    '--color-divider-soft': {
        only: ['docs'],
        light: { raw: 'rgba(10, 12, 15, 0.09)' },
        dark: { raw: 'rgba(255, 255, 255, 0.06)' }
    },
    '--color-error': {
        note: '失败 / 破坏性',
        light: [196, 76, 58],
        dark: [224, 122, 106]
    },
    '--color-error-bg': {
        light: [247, 226, 222],
        dark: [64, 36, 34]
    },
    '--color-error-strong': {
        light: [154, 53, 39],
        dark: [191, 89, 70]
    },
    '--color-fg': {
        note: '正文与标题主色',
        light: [10, 12, 15],
        dark: [228, 231, 236]
    },
    '--color-focus': {
        note: '焦点环取色',
        light: { raw: 'var(--color-info)' },
        dark: { raw: 'var(--color-info)' }
    },
    '--color-icon-bg': {
        only: ['web'],
        light: [220, 226, 232],
        dark: [38, 43, 50]
    },
    '--color-icon-fg': {
        only: ['web'],
        light: [60, 68, 78],
        dark: [185, 190, 198]
    },
    '--color-idle': {
        note: '空闲 / 禁用',
        light: [138, 144, 153],
        dark: [110, 118, 130]
    },
    '--color-idle-bg': {
        light: [234, 235, 237],
        dark: [36, 40, 46]
    },
    '--color-info': {
        note: '品牌 / 活跃 / 运行中',
        light: [59, 130, 201],
        dark: [123, 182, 232]
    },
    '--color-info-bg': {
        light: [232, 240, 249],
        dark: [24, 38, 56]
    },
    '--color-info-strong': {
        light: [38, 102, 173],
        dark: [92, 153, 210]
    },
    '--color-ink-soft': {
        only: ['docs'],
        light: [31, 36, 44],
        dark: [185, 190, 198]
    },
    '--color-link': {
        light: { raw: 'var(--color-info)' },
        dark: { raw: 'var(--color-info)' }
    },
    '--color-link-hover': {
        only: ['docs'],
        light: { raw: 'var(--color-info-strong)' },
        dark: { raw: 'var(--color-info-strong)' }
    },
    '--color-main': {
        only: ['docs'],
        light: [247, 249, 251],
        dark: [20, 23, 27]
    },
    '--color-main-bg': {
        note: '工作画布',
        only: ['web'],
        light: [247, 249, 251],
        dark: [20, 23, 27]
    },
    '--color-muted': {
        note: '次级正文',
        light: [82, 88, 97],
        dark: [185, 190, 198],
        overrides: {
            docs: {
                dark: [124, 131, 140],
                reason: '墨阶漂移：docs 的深色值恰等于 webapp 的 --color-subtle',
                drift: true
            }
        }
    },
    '--color-placeholder': {
        note: '输入框占位符',
        light: [130, 136, 145],
        dark: [105, 112, 122],
        overrides: {
            docs: {
                light: [155, 161, 170],
                dark: [100, 106, 114],
                reason: '墨阶漂移，无出处',
                drift: true
            }
        }
    },
    '--color-rail': {
        note: '侧栏',
        light: [235, 238, 241],
        dark: [13, 16, 20]
    },
    '--color-rail-hover': {
        only: ['web'],
        light: [223, 227, 232],
        dark: [28, 32, 38]
    },
    '--color-settings-bg': {
        only: ['web'],
        light: [247, 249, 251],
        dark: [20, 23, 27]
    },
    '--color-settings-rail': {
        only: ['web'],
        light: [235, 238, 241],
        dark: [13, 16, 20]
    },
    '--color-soft': {
        light: [234, 237, 241],
        dark: [58, 63, 71],
        overrides: {
            docs: {
                dark: [28, 32, 38],
                reason: '用途不同：webapp 是 popover item hover（锚定 surface-elevated），docs 是列表行 hover',
                drift: false
            }
        }
    },
    '--color-soft-hover': {
        light: [226, 230, 234],
        dark: [70, 76, 84],
        overrides: {
            docs: {
                dark: [38, 43, 50],
                reason: '同 --color-soft',
                drift: false
            }
        }
    },
    '--color-strong': {
        note: '主按钮填充',
        light: [10, 12, 15],
        dark: [228, 231, 236],
        overrides: {
            docs: {
                dark: [230, 233, 236],
                reason: '深色 1–2 单位差，无出处',
                drift: true
            }
        }
    },
    '--color-strong-fg': {
        note: '主按钮前景',
        light: [255, 255, 255],
        dark: [14, 17, 21],
        overrides: {
            docs: {
                light: [236, 240, 243],
                dark: [15, 17, 20],
                reason: 'docs 的主按钮前景取 --lp-paper 而非纯白（见 docs 原注释）',
                drift: false
            }
        }
    },
    '--color-strong-hover': {
        light: [42, 49, 56],
        dark: [200, 206, 214],
        overrides: {
            docs: {
                dark: [244, 246, 248],
                reason: '深色方向相反：webapp 降一档（228→200），docs 升一档（230→244）。DESIGN.md §8.10 的 hover 是降一档，docs 这侧疑为 bug',
                drift: true
            }
        }
    },
    '--color-subtle': {
        note: '元信息 / caption',
        light: [109, 116, 126],
        dark: [124, 131, 140],
        overrides: {
            docs: {
                light: [130, 136, 145],
                dark: [80, 85, 92],
                reason: '墨阶漂移：docs 的浅色值恰等于 webapp 的 --color-placeholder，整条墨阶错位一档',
                drift: true
            }
        }
    },
    '--color-success': {
        note: '成功 / 已交付',
        light: [46, 158, 110],
        dark: [91, 197, 152]
    },
    '--color-success-bg': {
        light: [230, 244, 237],
        dark: [22, 50, 38]
    },
    '--color-success-strong': {
        light: [31, 126, 84],
        dark: [58, 166, 122]
    },
    '--color-surface': {
        note: '卡面',
        light: [251, 252, 254],
        dark: [32, 36, 42]
    },
    '--color-surface-elevated': {
        note: '弹层 / popover',
        light: [253, 254, 255],
        dark: [42, 47, 54]
    },
    '--color-surface-hover': {
        light: [233, 237, 241],
        dark: [48, 53, 60]
    },
    '--color-surface-subtle': {
        note: '卡内下沉面板',
        light: [235, 238, 241],
        dark: [26, 30, 36]
    },
    '--color-tag-bg': {
        only: ['web'],
        light: { raw: 'rgb(var(--color-fg) / 0.07)' },
        dark: { raw: 'rgb(var(--color-fg) / 0.1)' }
    },
    '--color-warning': {
        note: '排队 / 待处理',
        light: [200, 148, 54],
        dark: [228, 185, 104]
    },
    '--color-warning-bg': {
        light: [248, 240, 224],
        dark: [56, 44, 22]
    },
    '--color-warning-strong': {
        light: [160, 115, 33],
        dark: [195, 153, 69]
    },
    '--color-workflow-develop': {
        light: { raw: 'var(--color-info)' },
        dark: { raw: 'var(--color-info)' }
    },
    '--color-workflow-preview': {
        light: { raw: 'var(--color-warning)' },
        dark: { raw: 'var(--color-warning)' }
    },
    '--color-workflow-ship': {
        light: { raw: 'var(--color-error)' },
        dark: { raw: 'var(--color-error)' },
        overrides: {
            docs: {
                light: { raw: 'var(--color-success)' },
                dark: { raw: 'var(--color-success)' },
                reason: '语义不同：webapp 表示 destructive，docs 用于 changelog 的 shipped（success 语义）',
                drift: false
            }
        }
    }
}
