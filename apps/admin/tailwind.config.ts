import type { Config } from 'tailwindcss'

const config: Config = {
    content: ['./index.html', './src/**/*.{ts,tsx}'],
    darkMode: 'class',
    theme: {
        extend: {
            colors: {
                brand: {
                    DEFAULT: '#533afd',
                    hover: '#4434d4',
                    deep: '#2e2b8c',
                    mid: '#665efd',
                    light: '#b9b9f9',
                    soft: '#d6d9fc',
                    subtle: 'rgba(83,58,253,0.05)',
                    dark: '#1c1e54',
                    darkest: '#0d253d'
                },
                heading: '#061b31',
                label: '#273951',
                body: '#64748d',
                surface: {
                    DEFAULT: '#ffffff',
                    subtle: '#fafbfc',
                    muted: '#f6f9fc'
                },
                border: {
                    DEFAULT: '#e5edf5',
                    purple: '#b9b9f9',
                    soft: '#d6d9fc',
                    dashed: '#362baa'
                },
                success: {
                    DEFAULT: '#15be53',
                    text: '#108c3d',
                    bg: 'rgba(21,190,83,0.2)',
                    ring: 'rgba(21,190,83,0.4)'
                },
                accent: {
                    ruby: '#ea2261',
                    magenta: '#f96bee',
                    magentaLight: '#ffd7ef',
                    lemon: '#9b6829'
                }
            },
            fontFamily: {
                sans: [
                    'Inter',
                    '-apple-system',
                    'BlinkMacSystemFont',
                    'SF Pro Display',
                    'Segoe UI',
                    'Roboto',
                    'sans-serif'
                ],
                mono: [
                    'Source Code Pro',
                    'SFMono-Regular',
                    'Menlo',
                    'monospace'
                ]
            },
            fontSize: {
                'display-lg': [
                    '3.5rem',
                    { lineHeight: '1.03', letterSpacing: '-0.025em' }
                ],
                display: [
                    '3rem',
                    { lineHeight: '1.15', letterSpacing: '-0.02em' }
                ],
                h1: ['1.5rem', { lineHeight: '1.16' }],
                h2: ['1.25rem', { lineHeight: '1.2' }],
                h3: ['1.125rem', { lineHeight: '1.25' }],
                'body-lg': ['1rem', { lineHeight: '1.35' }],
                body: ['0.875rem', { lineHeight: '1.4' }],
                caption: ['0.8125rem', { lineHeight: '1.4' }],
                'caption-sm': ['0.75rem', { lineHeight: '1.33' }]
            },
            borderRadius: {
                DEFAULT: '4px',
                md: '5px',
                lg: '6px',
                xl: '8px'
            },
            boxShadow: {
                ambient: 'rgba(23,23,23,0.06) 0px 3px 6px',
                card: 'rgba(23,23,23,0.08) 0px 15px 35px 0px',
                elevated:
                    'rgba(50,50,93,0.25) 0px 30px 45px -30px, rgba(0,0,0,0.1) 0px 18px 36px -18px',
                deep: 'rgba(3,3,39,0.25) 0px 14px 21px -14px, rgba(0,0,0,0.1) 0px 8px 17px -8px',
                'focus-brand': '0 0 0 2px #533afd'
            }
        }
    },
    plugins: []
}

export default config
