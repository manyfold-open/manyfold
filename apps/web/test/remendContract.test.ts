import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { healMarkdownSpan } from '../src/components/chat/utils/streamingMarkdown'

// createStreamingMarkdownBlocks decides whether a settled block is safe to
// freeze by asking remend itself — it heals the block with a probe appended
// and requires the answer to match healing the probe alone. That gate is only
// as complete as the probe list, and the probe list was written by reading
// remend 1.3.0's handlers. A new handler, or a changed one, can move state
// past a probe the list does not carry, and the symptom is wrong markdown
// mid-stream rather than a crash. So the version is pinned and asserted here:
// an upgrade has to come with a fresh read of the handler list and a re-run
// of test/streamingMarkdownBlocks.test.ts, not a silent bump.
const PINNED = '1.3.0'

const here = fileURLToPath(new URL('.', import.meta.url))

test('remend is pinned to an exact version, not a range', () => {
    const manifest = JSON.parse(
        readFileSync(`${here}../package.json`, 'utf8')
    ) as { dependencies: Record<string, string> }
    assert.equal(
        manifest.dependencies.remend,
        PINNED,
        'a caret here would let a minor bump change healing without review'
    )
})

// remend does not export ./package.json, so read the resolved install
// directly; the workspace hoists it to the repo root node_modules — which is
// this repository's root in a plain checkout and one level higher when the
// repo is mounted as the oss/ submodule of the cloud superproject.
test('the installed remend is the version the probe list was written for', () => {
    const candidates = [
        `${here}../../../node_modules/remend/package.json`,
        `${here}../../../../node_modules/remend/package.json`
    ]
    const installed = JSON.parse(
        readFileSync(candidates.find(existsSync) ?? candidates[0], 'utf8')
    ) as { version: string }
    assert.equal(installed.version, PINNED)
})

// A canary for the handler behaviours the probe list depends on. If a bump
// changes any of these, the probe list needs re-deriving before it can be
// trusted to gate a split point.
test('remend still heals the marker classes the probe list assumes', () => {
    assert.equal(healMarkdownSpan('\n\n`z'), '\n\n`z`')
    assert.equal(healMarkdownSpan('\n\n*z'), '\n\n*z*')
    assert.equal(healMarkdownSpan('\n\n**z'), '\n\n**z**')
    assert.equal(healMarkdownSpan('\n\n***z'), '\n\n***z***')
    assert.equal(healMarkdownSpan('\n\n_z'), '\n\n_z_')
    assert.equal(healMarkdownSpan('\n\n__z'), '\n\n__z__')
    assert.equal(healMarkdownSpan('\n\n~~z'), '\n\n~~z~~')
    assert.equal(healMarkdownSpan('\n\nz~z'), '\n\nz\\~z')
    assert.equal(healMarkdownSpan('\n\n$$z'), '\n\n$$z$$')
    assert.equal(healMarkdownSpan('\n\nz [z'), '\n\nz z')
    assert.equal(healMarkdownSpan('\n\nz ![z'), '\n\nz ')
    assert.equal(healMarkdownSpan('\n\nz <b z'), '\n\nz')
    assert.equal(healMarkdownSpan('\n\n- >= 1'), '\n\n- \\>= 1')
    assert.equal(healMarkdownSpan('\n\nz\n-'), '\n\nz\n-​')
})

// The reason every probe opens on a blank line, and the reason the splitter
// refuses a split point that does not: the setext handler reads the line
// before the last one, so a window opening mid-paragraph heals differently
// from the same text inside the document.
test('healing a window is line-sensitive across a single newline', () => {
    assert.notEqual(
        healMarkdownSpan('plain\n-'),
        'plain' + healMarkdownSpan('\n-')
    )
    assert.equal(
        healMarkdownSpan('plain\n\n-'),
        'plain' + healMarkdownSpan('\n\n-')
    )
})
