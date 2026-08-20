import assert from 'node:assert/strict'
import test from 'node:test'
import { extractWorkspaceFileRefs } from '../src/modules/channels/workspace-file-refs'

test('extracts a relative markdown link target', () => {
    const refs = extractWorkspaceFileRefs('Here it is: [chart](out/sine.png)')
    assert.deepEqual(refs, [{ relPath: 'out/sine.png', name: 'sine.png' }])
})

test('extracts a markdown image target', () => {
    const refs = extractWorkspaceFileRefs('![plot](./sine.png)')
    assert.deepEqual(refs, [{ relPath: 'sine.png', name: 'sine.png' }])
})

test('resolves /workspace absolute paths and strips line suffix', () => {
    const refs = extractWorkspaceFileRefs('[src](/workspace/app/main.py:12:3)')
    assert.deepEqual(refs, [{ relPath: 'app/main.py', name: 'main.py' }])
})

test('resolves file:// URLs under /workspace', () => {
    const refs = extractWorkspaceFileRefs(
        'see file:///workspace/report.pdf for details'
    )
    assert.deepEqual(refs, [{ relPath: 'report.pdf', name: 'report.pdf' }])
})

test('skips non-workspace absolute paths and external schemes', () => {
    const refs = extractWorkspaceFileRefs(
        '[a](/etc/passwd) [b](https://example.com/x.png) [c](mailto:x@y.z)'
    )
    assert.deepEqual(refs, [])
})

test('skips disallowed extensions', () => {
    const refs = extractWorkspaceFileRefs('[bin](build/app.exe)')
    assert.deepEqual(refs, [])
})

test('dedupes and orders images first, capped at four', () => {
    const refs = extractWorkspaceFileRefs(
        [
            '[a](notes.md)',
            '[b](a.png)',
            '[b-again](a.png)',
            '[c](data.csv)',
            '[d](chart.jpg)',
            '[e](more.svg)',
            '[f](extra.txt)'
        ].join('\n')
    )
    assert.equal(refs.length, 4)
    // images first
    assert.deepEqual(
        refs.map((r) => r.name),
        ['a.png', 'chart.jpg', 'more.svg', 'notes.md']
    )
})

test('returns empty for text with no file references', () => {
    assert.deepEqual(extractWorkspaceFileRefs('just a plain reply'), [])
    assert.deepEqual(extractWorkspaceFileRefs(''), [])
})
