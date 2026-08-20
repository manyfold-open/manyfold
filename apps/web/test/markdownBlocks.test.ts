import assert from 'node:assert/strict'
import test from 'node:test'
import {
    scanMarkdownBlocks,
    splitMarkdownBlocks
} from '../src/components/chat/utils/markdownBlocks'

test('returns an empty array for empty input', () => {
    assert.deepEqual(splitMarkdownBlocks(''), [])
})

test('treats a single block as one block', () => {
    assert.deepEqual(splitMarkdownBlocks('just one line'), ['just one line'])
})

test('splits consecutive paragraphs into separate blocks', () => {
    assert.deepEqual(splitMarkdownBlocks('First para.\n\nSecond para.'), [
        'First para.',
        'Second para.'
    ])
})

test('separates a heading from the following paragraph', () => {
    assert.deepEqual(splitMarkdownBlocks('# Title\n\nBody text.'), [
        '# Title',
        'Body text.'
    ])
})

test('keeps a loose ordered list as ONE block (no numbering reset)', () => {
    // A blank-line splitter would break this into three "1." lists — the exact
    // regression that justifies splitting with the real markdown parser.
    const md = '1. one\n\n2. two\n\n3. three'
    assert.deepEqual(splitMarkdownBlocks(md), [md])
})

test('keeps a fenced code block containing blank lines as one block', () => {
    const md = '```js\nconst a = 1\n\nconst b = 2\n```'
    assert.deepEqual(splitMarkdownBlocks(md), [md])
})

test('keeps a GFM table as one block', () => {
    const md = '| a | b |\n| - | - |\n| 1 | 2 |'
    assert.deepEqual(splitMarkdownBlocks(md), [md])
})

test('does not split when a link reference definition is present', () => {
    // Splitting would orphan the [d] reference from its definition; render whole.
    const md = 'See [the docs][d] for details.\n\n[d]: https://example.com'
    assert.deepEqual(splitMarkdownBlocks(md), [md])
})

test('keeps single-line display math as one block', () => {
    assert.deepEqual(splitMarkdownBlocks('$$x^2 + y^2$$'), ['$$x^2 + y^2$$'])
})

test('keeps multi-line display math with a blank line as one block', () => {
    // remark-math (in the splitter) is what keeps the blank line from splitting
    // the formula in two.
    const md = '$$\na = 1\n\nb = 2\n$$'
    assert.deepEqual(splitMarkdownBlocks(md), [md])
})

test('keeps inline math within its paragraph', () => {
    assert.deepEqual(splitMarkdownBlocks('Euler: $e^{i\\pi}+1=0$ is neat.'), [
        'Euler: $e^{i\\pi}+1=0$ is neat.'
    ])
})

test('settles nothing until a third top-level node exists', () => {
    // Two nodes means the second could still merge into the first, so nothing
    // is safe to freeze yet.
    const two = scanMarkdownBlocks('First para.\n\nSecond para.')
    assert.equal(two.settledCount, 0)
    assert.equal(two.settledEnd, 0)

    const three = scanMarkdownBlocks('First para.\n\nSecond para.\n\nThird.')
    assert.equal(three.settledCount, 1)
    assert.equal(three.settledEnd, 'First para.'.length)
    assert.deepEqual(three.blocks.slice(0, three.settledCount), ['First para.'])
})

test('holds the list open while the paragraph after it could join it', () => {
    // `2` is a paragraph now; the moment the user types `.` it becomes a list
    // item and the list above swallows it, rewriting a node that a one-node
    // window would already have frozen.
    const before = scanMarkdownBlocks('1. one\n\n2')
    assert.deepEqual(before.blocks, ['1. one', '2'])
    assert.equal(before.settledCount, 0)
    assert.deepEqual(splitMarkdownBlocks('1. one\n\n2.'), ['1. one\n\n2.'])
})

test('a definition anywhere in the source refuses to settle anything', () => {
    const scan = scanMarkdownBlocks(
        'See [the docs][d].\n\nMore prose.\n\n[d]: https://example.com'
    )
    assert.equal(scan.whole, true)
    assert.equal(scan.settledCount, 0)
    assert.deepEqual(scan.blocks, [])
})

test('settledEnd lands on a raw offset the caller can slice at', () => {
    const source = '# Title\n\nBody text.\n\nMore body.\n\nStill typ'
    const scan = scanMarkdownBlocks(source)
    assert.equal(source.slice(0, scan.settledEnd), '# Title\n\nBody text.')
    assert.deepEqual(scan.blocks.slice(0, scan.settledCount), [
        '# Title',
        'Body text.'
    ])
    assert.deepEqual(scan.blocks.slice(scan.settledCount), [
        'More body.',
        'Still typ'
    ])
})
