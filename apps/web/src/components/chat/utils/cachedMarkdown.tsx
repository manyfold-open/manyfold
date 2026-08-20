import type { Root } from 'hast'
import { type Components as JsxComponents, toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { urlAttributes } from 'html-url-attributes'
import type { FC } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { type Components, defaultUrlTransform } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'

// react-markdown rebuilds AND re-freezes its unified processor on every render —
// re-registering rehype-highlight's 13 language grammars each frame, ~80% of the
// per-render cost. Build the processor ONCE and reuse it for parse+run, so the
// streaming tail block pays only the parse, not the pipeline construction.
// singleDollarTextMath is off so prose dollars ($HOME, "$5 and $10") aren't parsed
// as math; inline and display math both use $$…$$.
const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath, { singleDollarTextMath: false })
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeHighlight, {
        detect: true,
        subset: [
            'typescript',
            'tsx',
            'javascript',
            'jsx',
            'python',
            'bash',
            'json',
            'yaml',
            'html',
            'css',
            'sql',
            'rust',
            'go'
        ]
    })
    .use(rehypeKatex)
    .freeze()

// Mirror react-markdown's post-processing for the options we use: raw HTML nodes
// become text (HTML is shown escaped, never executed), and every URL runs through
// react-markdown's own defaultUrlTransform so `javascript:` links stay sanitized.
const sanitizeTree = (tree: Root): void => {
    visit(tree, (node, index, parent) => {
        const raw = node as { type: string; value?: string }
        if (raw.type === 'raw' && parent && typeof index === 'number') {
            parent.children[index] = { type: 'text', value: raw.value ?? '' }
            return index
        }
        if (node.type === 'element') {
            for (const key in urlAttributes) {
                if (
                    Object.hasOwn(urlAttributes, key) &&
                    Object.hasOwn(node.properties, key)
                ) {
                    const test = urlAttributes[key]
                    if (test === null || test.includes(node.tagName)) {
                        node.properties[key] = defaultUrlTransform(
                            String(node.properties[key] || '')
                        )
                    }
                }
            }
        }
    })
}

interface Props {
    components: Components
    markdown: string
}

const CachedMarkdown: FC<Props> = ({ components, markdown }) => {
    const tree = processor.runSync(processor.parse(markdown)) as Root
    sanitizeTree(tree)
    return toJsxRuntime(tree, {
        Fragment,
        components: components as JsxComponents,
        ignoreInvalidStyle: true,
        jsx,
        jsxs,
        passKeys: true,
        passNode: true
    })
}

export default CachedMarkdown
