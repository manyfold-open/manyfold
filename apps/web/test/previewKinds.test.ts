import assert from 'node:assert/strict'
import test from 'node:test'
import {
    HTML_PREVIEW_SANDBOX,
    MAX_DOCX_PREVIEW_BYTES,
    MAX_SQLITE_PREVIEW_BYTES,
    MAX_XLSX_PREVIEW_BYTES,
    binaryPreviewKind,
    binaryPreviewLimit,
    cellText,
    codeLanguageFor,
    isHtmlExt,
    isLegacyExcelExt
} from '../src/components/chat/preview/previewKinds'

test('binaryPreviewKind maps office and sqlite extensions', () => {
    assert.equal(binaryPreviewKind('docx'), 'docx')
    assert.equal(binaryPreviewKind('xlsx'), 'xlsx')
    assert.equal(binaryPreviewKind('sqlite'), 'sqlite')
    assert.equal(binaryPreviewKind('sqlite3'), 'sqlite')
    assert.equal(binaryPreviewKind('db'), 'sqlite')
})

test('binaryPreviewKind rejects non-binary-preview extensions', () => {
    assert.equal(binaryPreviewKind('png'), null)
    assert.equal(binaryPreviewKind('txt'), null)
    assert.equal(binaryPreviewKind('xls'), null)
    assert.equal(binaryPreviewKind(''), null)
})

test('binaryPreviewLimit returns the per-format byte cap', () => {
    assert.equal(binaryPreviewLimit('docx'), MAX_DOCX_PREVIEW_BYTES)
    assert.equal(binaryPreviewLimit('xlsx'), MAX_XLSX_PREVIEW_BYTES)
    assert.equal(binaryPreviewLimit('sqlite'), MAX_SQLITE_PREVIEW_BYTES)
    assert.equal(MAX_DOCX_PREVIEW_BYTES, 10_000_000)
    assert.equal(MAX_XLSX_PREVIEW_BYTES, 10_000_000)
    assert.equal(MAX_SQLITE_PREVIEW_BYTES, 20_000_000)
})

test('isLegacyExcelExt flags only xls', () => {
    assert.equal(isLegacyExcelExt('xls'), true)
    assert.equal(isLegacyExcelExt('xlsx'), false)
    assert.equal(isLegacyExcelExt('csv'), false)
})

test('isHtmlExt accepts html and htm', () => {
    assert.equal(isHtmlExt('html'), true)
    assert.equal(isHtmlExt('htm'), true)
    assert.equal(isHtmlExt('xhtml'), false)
    assert.equal(isHtmlExt('md'), false)
})

test('codeLanguageFor maps known code extensions', () => {
    assert.equal(codeLanguageFor('ts'), 'typescript')
    assert.equal(codeLanguageFor('py'), 'python')
    assert.equal(codeLanguageFor('dockerfile'), 'dockerfile')
    assert.equal(codeLanguageFor('toml'), 'ini')
})

test('codeLanguageFor leaves plain-text and claimed-earlier extensions alone', () => {
    // null keeps txt/log/etc on the existing plain <pre> path and lets
    // csv/html dispatch to their dedicated previews — the no-regression contract
    assert.equal(codeLanguageFor('txt'), null)
    assert.equal(codeLanguageFor('log'), null)
    assert.equal(codeLanguageFor('conf'), null)
    assert.equal(codeLanguageFor('env'), null)
    assert.equal(codeLanguageFor('csv'), null)
    assert.equal(codeLanguageFor('html'), null)
    assert.equal(codeLanguageFor('htm'), null)
    assert.equal(codeLanguageFor('unknown-ext'), null)
})

test('cellText stringifies spreadsheet cell shapes', () => {
    assert.equal(cellText(null), '')
    assert.equal(cellText(undefined), '')
    assert.equal(
        cellText(new Date('2026-06-11T00:00:00.000Z')),
        '2026-06-11T00:00:00.000Z'
    )
    assert.equal(
        cellText({ richText: [{ text: 'a' }, { text: 'b' }] }),
        'ab'
    )
    assert.equal(cellText({ formula: 'A1+A2', result: 3 }), '3')
    assert.equal(
        cellText({ text: 'link', hyperlink: 'https://example.com' }),
        'link'
    )
    assert.equal(cellText({ error: '#N/A' }), '#ERR')
    assert.equal(cellText(new Uint8Array(4)), '[blob 4 B]')
    assert.equal(cellText(42), '42')
})

test('html preview sandbox never includes allow-same-origin', () => {
    // allow-same-origin + allow-scripts would hand frame scripts the parent
    // DOM and the signed-in session; opaque origin is the security boundary
    assert.equal(HTML_PREVIEW_SANDBOX.includes('allow-same-origin'), false)
    assert.equal(HTML_PREVIEW_SANDBOX, 'allow-scripts')
})