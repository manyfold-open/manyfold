import type { CSSProperties } from 'react'

// @pierre/trees renders inside a shadow root, so DESIGN.md's Tailwind-class
// rule cannot reach it — CSS custom properties are the only way in. Values are
// the admin tokens from tailwind.config.ts; keep them in sync by hand.
export const FILE_TREE_THEME = {
    '--trees-accent-override': '#533afd',
    '--trees-bg-muted-override': '#f6f9fc',
    '--trees-bg-override': '#ffffff',
    '--trees-border-color-override': '#e5edf5',
    '--trees-density-override': '0.92',
    '--trees-fg-muted-override': '#64748d',
    '--trees-fg-override': '#061b31',
    '--trees-focus-ring-color-override': 'rgba(83,58,253,0.85)',
    '--trees-font-family-override':
        'Inter, -apple-system, BlinkMacSystemFont, SF Pro Display, Segoe UI, sans-serif',
    '--trees-font-size-override': '13px',
    '--trees-item-height': '28px',
    '--trees-padding-inline-override': '10px',
    '--trees-input-bg-override': '#fafbfc',
    '--trees-search-bg-override': '#fafbfc',
    '--trees-search-fg-override': '#061b31',
    '--trees-selected-bg-override': 'rgba(83,58,253,0.05)',
    '--trees-selected-fg-override': '#061b31',
    colorScheme: 'inherit',
    height: '100%',
    minHeight: 0
} as CSSProperties
