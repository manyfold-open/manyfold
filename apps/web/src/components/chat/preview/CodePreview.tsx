import { useEffect, useState } from 'react'
import type { FC, ReactNode } from 'react'
import type { HLJSApi } from 'highlight.js'
import { MAX_HIGHLIGHT_BYTES } from '@/components/chat/preview/previewKinds'

let hljsPromise: Promise<HLJSApi> | null = null

const loadHljs = (): Promise<HLJSApi> => {
    if (!hljsPromise)
        hljsPromise = Promise.all([
            import('highlight.js/lib/common'),
            // dockerfile is not bundled in lib/common
            import('highlight.js/lib/languages/dockerfile')
        ]).then(([common, dockerfile]) => {
            const hljs = common.default
            hljs.registerLanguage('dockerfile', dockerfile.default)
            return hljs
        })
    return hljsPromise
}

interface CodePreviewProps {
    text: string
    language: string
}

interface Highlighted {
    source: string
    language: string
    html: string
}

const CodePreview: FC<CodePreviewProps> = ({ text, language }): ReactNode => {
    const [highlighted, setHighlighted] = useState<Highlighted | null>(null)

    useEffect(() => {
        if (text.length > MAX_HIGHLIGHT_BYTES) return
        let cancelled = false
        loadHljs()
            .then((hljs) => {
                if (cancelled || !hljs.getLanguage(language)) return
                const result = hljs.highlight(text, {
                    language,
                    ignoreIllegals: true
                })
                if (cancelled) return
                setHighlighted({ source: text, language, html: result.value })
            })
            .catch((error) => {
                console.error('code preview highlight failed', error)
            })
        return () => {
            cancelled = true
        }
    }, [text, language])

    const html =
        highlighted &&
        highlighted.source === text &&
        highlighted.language === language
            ? highlighted.html
            : null
    if (html === null)
        return (
            <pre className='text-caption text-fg font-mono leading-6 break-words whitespace-pre-wrap'>
                {text}
            </pre>
        )
    return (
        // markdown-code-block scopes the dark-theme hljs token overrides in
        // styles.css; hljs HTML-escapes source so the injected markup is safe
        <pre className='markdown-code-block text-caption text-fg font-mono leading-6'>
            <code className='hljs' dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
    )
}

export default CodePreview