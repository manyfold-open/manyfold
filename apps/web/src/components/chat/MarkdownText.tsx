import type { FC, MouseEvent, ReactNode } from 'react'
import { Children, isValidElement, memo, useMemo, useRef, useState } from 'react'
import type { Components } from 'react-markdown'
import { splitMarkdownBlocks } from '@/components/chat/utils/markdownBlocks'
import {
    createStreamingMarkdownBlocks,
    type StreamingMarkdownBlocks
} from '@/components/chat/utils/streamingMarkdownBlocks'
import CachedMarkdown from '@/components/chat/utils/cachedMarkdown'
import MermaidDiagram from '@/components/chat/MermaidDiagram'
import { useI18n } from '@/lib/i18n'
import 'katex/dist/katex.min.css'

export type MarkdownLinkClickHandler = (
    href: string,
    event: MouseEvent<HTMLAnchorElement>
) => boolean | void

interface Props {
    onLinkClick?: MarkdownLinkClickHandler
    streaming?: boolean
    text: string
    // 'chat' (default) keeps the app-heading prose scale. 'doc' renders a
    // skill/README body inside a page that already has its own text-h1 title,
    // so headings step down one rung (h1→h2, h2→h3, h3→body) and to weight 500
    // — the doc's own `#` title then sits below the page title instead of
    // competing with it. Only affects this component's callers that opt in.
    variant?: 'chat' | 'doc'
}

const DOC_PROSE =
    'prose-headings:font-medium prose-h1:text-h2 prose-h2:text-h3 prose-h3:text-body'

const extractTextFromNode = (node: ReactNode): string => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number')
        return String(node)
    if (Array.isArray(node)) return node.map(extractTextFromNode).join('')
    if (typeof node === 'object' && 'props' in node) {
        const props = (node as { props?: { children?: ReactNode } }).props
        if (props && 'children' in props)
            return extractTextFromNode(props.children)
    }
    return ''
}

const mermaidSource = (children: ReactNode): string | null => {
    const child = Children.toArray(children)[0]
    if (!isValidElement(child)) return null
    const className = (child.props as { className?: string }).className ?? ''
    if (!/(^|\s)language-mermaid(\s|$)/.test(className)) return null
    return extractTextFromNode(child).replace(/\n+$/, '')
}

const codeLanguage = (children: ReactNode): string | null => {
    const child = Children.toArray(children)[0]
    if (!isValidElement(child)) return null
    const className = (child.props as { className?: string }).className ?? ''
    const match = /(^|\s)language-([\w-]+)/.exec(className)
    return match ? match[2] : null
}

const CodeBlock: FC<{ children: ReactNode }> = ({ children }) => {
    const { t } = useI18n()
    const [copied, setCopied] = useState(false)
    const mermaid = mermaidSource(children)
    if (mermaid)
        return (
            <div className='not-prose'>
                <MermaidDiagram code={mermaid} />
            </div>
        )
    const language = codeLanguage(children)
    const onCopy = (): void => {
        const text = extractTextFromNode(children)
        if (!text) return
        navigator.clipboard
            .writeText(text)
            .then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
            })
            .catch(() => undefined)
    }
    return (
        <div className='markdown-code-block not-prose bg-surface-subtle shadow-ring group relative my-4 overflow-hidden rounded-sm'>
            <div className='text-caption text-subtle border-divider flex items-center justify-between border-b px-3.5 py-1.5'>
                <span className='font-mono'>{language ?? 'code'}</span>
                <button
                    type='button'
                    onClick={onCopy}
                    aria-label={
                        copied
                            ? t('web.chat.copiedMessage')
                            : t('web.chat.copyCode')
                    }
                    className='hover:text-fg font-mono opacity-0 transition-opacity group-hover:opacity-100'
                >
                    {copied ? t('web.chat.copiedMessage') : t('web.chat.copyCode')}
                </button>
            </div>
            <pre className='text-code overflow-x-auto p-3.5 leading-relaxed'>
                {children}
            </pre>
        </div>
    )
}

// Prose styling (paragraphs, headings, lists, blockquotes, tables, hr,
// emphasis) is owned by @tailwindcss/typography via the `prose` wrapper
// in MarkdownText. Only the elements that need real logic stay custom:
// links (click interception), code blocks (copy + mermaid), and inline
// code (the chip look). Everything else renders as a native tag for prose.
const createComponents = (
    onLinkClick?: MarkdownLinkClickHandler
): Components => ({
    a: ({ children, href }) => (
        <a
            href={href}
            onClick={(event) => {
                if (!href) return
                if (!onLinkClick?.(href, event)) return
                event.preventDefault()
                event.stopPropagation()
            }}
            target='_blank'
            rel='noreferrer'
        >
            {children}
        </a>
    ),
    table: ({ children }) => (
        <div className='my-4 max-w-full overflow-x-auto'>
            <table className='min-w-full'>{children}</table>
        </div>
    ),
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    code: ({ className, children, ...rest }) => {
        const isBlock = /(^|\s)language-/.test(className ?? '')
        if (isBlock)
            return (
                <code className={className} {...rest}>
                    {children}
                </code>
            )
        return (
            <code
                className='bg-surface-subtle shadow-ring-light rounded-xs px-1 py-0.5 font-mono'
                {...rest}
            >
                {children}
            </code>
        )
    }
})

// One memoized <ReactMarkdown> per top-level block. A completed block's string
// is stable, so memo skips its re-render/re-highlight while the streaming tail
// grows, and createStreamingMarkdownBlocks hands back that same string rather
// than re-slicing it out of a fresh whole-message heal every frame.
const MarkdownBlock = memo<{ block: string; components: Components }>(
    ({ block, components }) => (
        <CachedMarkdown markdown={block} components={components} />
    )
)
MarkdownBlock.displayName = 'MarkdownBlock'

const MarkdownText: FC<Props> = memo((props) => {
    const components = useMemo(
        () => createComponents(props.onLinkClick),
        [props.onLinkClick]
    )
    // Held per instance and advanced during render, like the lastRenderable
    // ref it replaces. next() is idempotent for a repeated text, so a
    // StrictMode double render, or one caused by another prop, stays free.
    const stream = useRef<StreamingMarkdownBlocks | null>(null)
    const settled = useMemo(
        () => (props.streaming ? null : splitMarkdownBlocks(props.text)),
        [props.streaming, props.text]
    )
    let blocks = settled
    if (!blocks) {
        stream.current ??= createStreamingMarkdownBlocks()
        blocks = stream.current.next(props.text)
    }
    return (
        <div
            className={`prose min-w-0 max-w-full text-fg${props.variant === 'doc' ? ` ${DOC_PROSE}` : ''}`}
        >
            {blocks.map((block, index) => (
                <MarkdownBlock
                    key={index}
                    block={block}
                    components={components}
                />
            ))}
        </div>
    )
})

MarkdownText.displayName = 'MarkdownText'

export default MarkdownText
