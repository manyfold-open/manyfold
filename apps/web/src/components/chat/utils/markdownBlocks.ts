import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath, { singleDollarTextMath: false })

// Link-reference and footnote definitions can be referenced from other blocks,
// so a message containing them must render as one unit or those references break.
const DEFINITION_TYPES = new Set(['definition', 'footnoteDefinition'])

export interface MarkdownBlockScan {
    blocks: string[]
    // Offset each entry of `blocks` was sliced from, so a caller streaming a
    // suffix can map a block back onto the source it re-parses from.
    starts: number[]
    // The source must render unsplit: a definition is in scope, a node
    // carried no offsets, or nothing renderable came out of the parse.
    whole: boolean
    // Offset one past the third-to-last top-level node: the source before it
    // can no longer change, however the message continues.
    //
    // Appended text lands inside the final node, so that node is always open.
    // It can also merge the final node into the one before it: `1. one\n\n2`
    // parses as a list plus the paragraph `2`, and typing the `.` turns that
    // paragraph into a list item, which the list above then swallows. So
    // the last TWO nodes stay open. It stops there — reaching a third node
    // back would need the middle node to grow a block marker of its own, and
    // nothing is ever inserted in front of it. Definitions are the exception
    // that reaches everywhere, and they take the `whole` path instead.
    settledEnd: number
    // How many leading entries of `blocks` end at or before `settledEnd`.
    settledCount: number
}

const WHOLE: MarkdownBlockScan = Object.freeze({
    blocks: Object.freeze([]) as unknown as string[],
    starts: Object.freeze([]) as unknown as number[],
    whole: true,
    settledEnd: 0,
    settledCount: 0
})

// Split markdown into its top-level blocks using the SAME parser react-markdown
// renders with, so boundaries always match how the content displays (loose
// ordered lists stay one block, fenced code and GFM tables stay intact). Each
// block string can then render as its own memoized <ReactMarkdown>, so during
// streaming only the last, growing block re-parses instead of the whole message.
export const scanMarkdownBlocks = (markdown: string): MarkdownBlockScan => {
    const tree = processor.parse(markdown)
    const openIndex = tree.children.length - 1
    const blocks: string[] = []
    const starts: number[] = []
    let settledEnd = 0
    let settledCount = 0
    for (let index = 0; index <= openIndex; index += 1) {
        const node = tree.children[index]
        if (DEFINITION_TYPES.has(node.type)) return WHOLE
        const start = node.position?.start?.offset
        const end = node.position?.end?.offset
        if (start === undefined || end === undefined) return WHOLE
        const block = markdown.slice(start, end)
        if (block.trim()) {
            blocks.push(block)
            starts.push(start)
        }
        if (index < openIndex - 1) {
            settledEnd = end
            settledCount = blocks.length
        }
    }
    if (blocks.length === 0) return WHOLE
    return { blocks, starts, whole: false, settledEnd, settledCount }
}

export const splitMarkdownBlocks = (markdown: string): string[] => {
    if (!markdown) return []
    const scan = scanMarkdownBlocks(markdown)
    return scan.whole ? [markdown] : scan.blocks
}
