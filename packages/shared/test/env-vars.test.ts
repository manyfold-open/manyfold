import assert from 'node:assert/strict'
import test from 'node:test'
import {
    envTextFromExtras,
    envTextToRecord,
    isReservedEnvKey,
    parseEnvText
} from '../src/env-vars'

test('parses simple KEY=VALUE pairs', () => {
    const { entries, errors } = parseEnvText('NODE_ENV=production\nPORT=8080')
    assert.equal(errors.length, 0)
    assert.deepEqual(
        entries.map((e) => [e.key, e.value]),
        [
            ['NODE_ENV', 'production'],
            ['PORT', '8080']
        ]
    )
})

test('skips blank lines and full-line comments (comments stay in raw text)', () => {
    const text = '# leading comment\n\nNODE_ENV=production\n  # indented comment\nA=1'
    const { entries, errors } = parseEnvText(text)
    assert.equal(errors.length, 0)
    assert.deepEqual(
        entries.map((e) => e.key),
        ['NODE_ENV', 'A']
    )
    // The raw text the caller stores is untouched, so comments are preserved.
    assert.ok(text.includes('# leading comment'))
})

test('trims unquoted values and strips trailing inline comments', () => {
    const { entries } = parseEnvText('NAME=  Ying Cai   # author name')
    assert.equal(entries[0].value, 'Ying Cai')
})

test('keeps # in unquoted value when not preceded by whitespace', () => {
    const { entries } = parseEnvText('URL=http://x#y')
    assert.equal(entries[0].value, 'http://x#y')
})

test('strips surrounding quotes without altering inner content', () => {
    const dq = parseEnvText('A="hello world"').entries[0]
    assert.equal(dq.value, 'hello world')
    const sq = parseEnvText("B='C-3PO # not a comment'").entries[0]
    assert.equal(sq.value, 'C-3PO # not a comment')
})

test('supports quoted values spanning multiple physical lines (mockup case)', () => {
    const text = 'CONFIG="key1=val1\nkey2=val2"'
    const { entries, errors } = parseEnvText(text)
    assert.equal(errors.length, 0)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].key, 'CONFIG')
    assert.equal(entries[0].value, 'key1=val1\nkey2=val2')
})

test('expands escapes inside double quotes but not single quotes', () => {
    assert.equal(parseEnvText('A="a\\nb\\tc"').entries[0].value, 'a\nb\tc')
    assert.equal(parseEnvText("A='a\\nb'").entries[0].value, 'a\\nb')
})

test('reports an error for a missing "=" and continues', () => {
    const { entries, errors } = parseEnvText('JUST_A_KEY\nA=1')
    assert.equal(errors.length, 1)
    assert.equal(errors[0].line, 1)
    assert.deepEqual(
        entries.map((e) => e.key),
        ['A']
    )
})

test('reports an error for an invalid variable name', () => {
    const { errors } = parseEnvText('1BAD=x\nMY KEY=y')
    assert.equal(errors.length, 2)
})

test('reports an error for an unterminated quoted value', () => {
    const { errors } = parseEnvText('A="never closed\nstill open')
    assert.equal(errors.length, 1)
    assert.match(errors[0].reason, /unterminated/)
})

test('flags reserved keys (prefixes, exact names) but not NODE_ENV', () => {
    assert.equal(isReservedEnvKey('MF_AGENT_ID'), true)
    assert.equal(isReservedEnvKey('ANTHROPIC_AUTH_TOKEN'), true)
    assert.equal(isReservedEnvKey('PATH'), true)
    assert.equal(isReservedEnvKey('NODE_ENV'), false)
    assert.equal(isReservedEnvKey('GIT_AUTHOR_NAME'), false)
    const reserved = parseEnvText('MF_AGENT_ID=x\nNODE_ENV=production').entries
    assert.equal(reserved[0].reserved, true)
    assert.equal(reserved[1].reserved, false)
})

test('envTextToRecord drops reserved + invalid and applies last-wins', () => {
    const record = envTextToRecord(
        'A=1\nA=2\nPATH=/evil\nMF_X=y\nBAD KEY=z\nB=ok'
    )
    assert.deepEqual(record, { A: '2', B: 'ok' })
})

test('envTextToRecord handles empty/nullish input', () => {
    assert.deepEqual(envTextToRecord(''), {})
    assert.deepEqual(envTextToRecord(null), {})
    assert.deepEqual(envTextToRecord(undefined), {})
})

test('empty value after = is allowed', () => {
    const { entries, errors } = parseEnvText('EMPTY=')
    assert.equal(errors.length, 0)
    assert.equal(entries[0].value, '')
})

test('envTextFromExtras reads the envText string or returns undefined', () => {
    assert.equal(envTextFromExtras({ envText: 'A=1' }), 'A=1')
    assert.equal(envTextFromExtras({ envText: 123 }), undefined)
    assert.equal(envTextFromExtras({}), undefined)
    assert.equal(envTextFromExtras(null), undefined)
    assert.equal(envTextFromExtras(undefined), undefined)
})