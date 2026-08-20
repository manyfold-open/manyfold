import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCsv } from '../src/components/chat/preview/parseCsv'

test('parses simple comma-separated rows', () => {
    assert.deepEqual(parseCsv('a,b,c\n1,2,3'), [
        ['a', 'b', 'c'],
        ['1', '2', '3']
    ])
})

test('keeps commas inside quoted fields', () => {
    assert.deepEqual(parseCsv('name,note\n"Doe, Jane",ok'), [
        ['name', 'note'],
        ['Doe, Jane', 'ok']
    ])
})

test('unescapes doubled quotes inside quoted fields', () => {
    assert.deepEqual(parseCsv('"say ""hi""",x'), [['say "hi"', 'x']])
})

test('keeps newlines inside quoted fields', () => {
    assert.deepEqual(parseCsv('"line1\nline2",b\nc,d'), [
        ['line1\nline2', 'b'],
        ['c', 'd']
    ])
})

test('treats CRLF as a single row separator', () => {
    assert.deepEqual(parseCsv('a,b\r\nc,d\r\n'), [
        ['a', 'b'],
        ['c', 'd']
    ])
})

test('treats a lone CR as a row separator', () => {
    assert.deepEqual(parseCsv('a,b\rc,d'), [
        ['a', 'b'],
        ['c', 'd']
    ])
})

test('strips a leading BOM', () => {
    assert.deepEqual(parseCsv('\ufeffa,b'), [['a', 'b']])
})

test('a trailing newline does not emit a phantom row', () => {
    assert.deepEqual(parseCsv('a,b\n'), [['a', 'b']])
})

test('returns no rows for an empty string', () => {
    assert.deepEqual(parseCsv(''), [])
})

test('never throws: unterminated quote consumes to EOF as the final field', () => {
    assert.deepEqual(parseCsv('a,"bc\nd'), [['a', 'bc\nd']])
})