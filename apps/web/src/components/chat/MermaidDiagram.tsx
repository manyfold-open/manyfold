import type { FC } from 'react'
import { memo, useEffect, useId, useState } from 'react'
import { useTheme } from '@/lib/theme'

interface Props {
    code: string
}

const RENDER_DEBOUNCE_MS = 150

// Mermaid is large and rarely needed, so it is imported lazily — the chunk only
// loads when a diagram actually appears. While the fenced block is still
// streaming (incomplete syntax) or invalid, we fall back to showing the source
// instead of an error box; it swaps to the diagram once it parses.
const MermaidDiagram: FC<Props> = memo(({ code }) => {
    const { theme } = useTheme()
    const rawId = useId()
    const renderId = `mermaid-${rawId.replace(/[^a-zA-Z0-9-]/g, '')}`
    const [svg, setSvg] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        const run = async (): Promise<void> => {
            try {
                const mermaid = (await import('mermaid')).default
                mermaid.initialize({
                    startOnLoad: false,
                    securityLevel: 'strict',
                    theme: theme === 'dark' ? 'dark' : 'default'
                })
                const valid = await mermaid.parse(code, { suppressErrors: true })
                if (!valid) {
                    if (!cancelled) setSvg(null)
                    return
                }
                const result = await mermaid.render(renderId, code)
                if (!cancelled) setSvg(result.svg)
            } catch {
                if (!cancelled) setSvg(null)
            }
        }
        // Debounce so a streaming (still-growing) fence doesn't re-parse on
        // every character — only render once the source settles.
        const timer = setTimeout(() => {
            void run()
        }, RENDER_DEBOUNCE_MS)
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [code, theme, renderId])

    // mermaid renders with securityLevel 'strict', which sanitizes the SVG before injection
    if (svg)
        return (
            <div
                className='markdown-mermaid bg-surface-subtle shadow-ring my-3 flex justify-center overflow-x-auto rounded-md p-3.5'
                dangerouslySetInnerHTML={{ __html: svg }}
            />
        )

    return (
        <pre className='markdown-code-block bg-surface-subtle text-caption shadow-ring my-3 overflow-x-auto rounded-md p-3.5'>
            <code>{code}</code>
        </pre>
    )
})

MermaidDiagram.displayName = 'MermaidDiagram'

export default MermaidDiagram
