import type { CSSProperties } from 'react'

// Shared @pierre/trees theming so every file tree (chat workspace browser,
// skill library editor) renders identically. One exception: --trees-bg must
// match the HOST panel's fill (the library paints it on sticky overlays and
// truncate fade masks, so it has to be opaque and identical to the ground
// under the tree). The default below is the chat canvas; a tree mounted on a
// different surface spreads this object and overrides --trees-bg-override.
export const FILE_TREE_THEME = {
    '--trees-accent-override': 'rgb(var(--color-link))',
    '--trees-bg-muted-override': 'rgb(var(--color-soft))',
    '--trees-bg-override': 'rgb(var(--color-main-bg))',
    '--trees-border-color-override': 'rgb(var(--color-divider))',
    '--trees-density-override': '0.92',
    '--trees-fg-muted-override': 'rgb(var(--color-placeholder))',
    '--trees-fg-override': 'rgb(var(--color-fg))',
    '--trees-focus-ring-color-override': 'rgb(var(--color-focus) / 0.85)',
    '--trees-font-family-override':
        'Geist, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    '--trees-font-size-override': 'var(--text-ui)',
    '--trees-item-height': '30px',
    '--trees-padding-inline-override': '12px',
    '--trees-input-bg-override': 'rgb(var(--color-surface-subtle))',
    '--trees-search-bg-override': 'rgb(var(--color-surface-subtle))',
    '--trees-search-fg-override': 'rgb(var(--color-fg))',
    '--trees-selected-bg-override': 'rgb(var(--color-surface-hover))',
    '--trees-selected-fg-override': 'rgb(var(--color-fg))',
    colorScheme: 'inherit',
    height: '100%',
    minHeight: 0
} as CSSProperties
