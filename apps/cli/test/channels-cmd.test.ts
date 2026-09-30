import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelDetail } from '@manyfold/shared'
import { buildSendBody } from '../src/commands/channels/send'
import { maskSensitive, parseJsonArg } from '../src/commands/channels/helpers'
import { UsageError } from '../src/usage-error'
import { spawnMf } from './fixtures/spawn-mf'

const usage =
    (pattern: RegExp) =>
    (err: unknown): boolean =>
        err instanceof UsageError && pattern.test(err.message)

test('parseJsonArg: inline JSON object', async () => {
    const parsed = await parseJsonArg('{"foo":"bar"}', '--config')
    assert.deepEqual(parsed, { foo: 'bar' })
})

test('parseJsonArg: rejects non-object inline JSON', async () => {
    await assert.rejects(
        () => parseJsonArg('"foo"', '--config'),
        usage(/expected a JSON object/)
    )
    await assert.rejects(
        () => parseJsonArg('[1,2,3]', '--config'),
        usage(/expected a JSON object/)
    )
})

test('parseJsonArg: invalid JSON reports the parse error', async () => {
    await assert.rejects(
        () => parseJsonArg('{ not json }', '--config'),
        usage(/invalid JSON/)
    )
})

test('parseJsonArg: @path reads the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-cli-'))
    try {
        const file = join(dir, 'config.json')
        await writeFile(file, JSON.stringify({ chat_id: 42 }))
        const parsed = await parseJsonArg(`@${file}`, '--config')
        assert.deepEqual(parsed, { chat_id: 42 })
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('parseJsonArg: @ with empty path errors', async () => {
    await assert.rejects(
        () => parseJsonArg('@', '--credentials'),
        usage(/requires a file path/)
    )
})

test('parseJsonArg: an @path that cannot be read names the flag', async () => {
    await assert.rejects(
        () => parseJsonArg('@/nonexistent/config.json', '--config'),
        usage(/^--config: cannot read \/nonexistent\/config\.json \(ENOENT\)$/)
    )
})

test('maskSensitive strips sensitive keys if present', () => {
    const detail = {
        id: 'chn_x',
        provider: 'telegram',
        label: 'TG',
        agentId: 'agt_A',
        credentials: { botToken: 'secret' },
        credentialsCiphertext: 'should-not-leak',
        credentialsPlaintext: 'should-not-leak'
    } as unknown as ChannelDetail
    const masked = maskSensitive(detail)
    assert.equal(masked.credentials, '[redacted]')
    assert.equal(masked.credentialsCiphertext, '[redacted]')
    assert.equal(masked.credentialsPlaintext, '[redacted]')
    assert.equal(masked.id, 'chn_x')
})

test('maskSensitive leaves safe responses untouched', () => {
    const detail = {
        id: 'chn_x',
        provider: 'telegram',
        label: 'TG',
        agentId: 'agt_A',
        status: 'active',
        config: { chat_id: 1 }
    } as unknown as ChannelDetail
    const masked = maskSensitive(detail)
    assert.equal(masked.id, 'chn_x')
    assert.deepEqual(masked.config, { chat_id: 1 })
    assert.equal('credentials' in masked, false)
    assert.equal('credentialsCiphertext' in masked, false)
})

test('maskSensitive masks secrets nested inside config', () => {
    const detail = {
        id: 'chn_lark',
        provider: 'lark',
        label: 'Lark',
        agentId: 'agt_A',
        config: {
            appId: 'cli_123',
            subscriptionMode: 'webhook',
            mentionOnly: true,
            verificationToken: 'should-not-leak',
            encryptKey: 'should-not-leak'
        }
    }
    const masked = maskSensitive(detail)
    const config = masked.config as Record<string, unknown>
    assert.equal(config.appId, 'cli_123')
    assert.equal(config.subscriptionMode, 'webhook')
    assert.equal(config.mentionOnly, true)
    assert.equal(config.verificationToken, '[redacted]')
    assert.equal(config.encryptKey, '[redacted]')
    assert.equal(masked.id, 'chn_lark')
})

test('maskSensitive recurses through arrays and deep objects', () => {
    const masked = maskSensitive({
        recentDeliveries: [
            { id: 'dlv_1', meta: { token: 'should-not-leak' } },
            { id: 'dlv_2', errorMessage: null }
        ]
    })
    assert.deepEqual(masked.recentDeliveries, [
        { id: 'dlv_1', meta: { token: '[redacted]' } },
        { id: 'dlv_2', errorMessage: null }
    ])
})

test('maskSensitive applies extraKeys at nested levels', () => {
    const masked = maskSensitive(
        { config: { webhookSecret: 'should-not-leak', chat_id: 1 } },
        ['webhookSecret']
    )
    assert.deepEqual(masked, {
        config: { webhookSecret: '[redacted]', chat_id: 1 }
    })
})

test('buildSendBody requires text and exactly one target', () => {
    assert.deepEqual(
        buildSendBody({ chatId: 'oc_x', text: ' hi ' }),
        { text: 'hi', chatId: 'oc_x' }
    )
    assert.deepEqual(
        buildSendBody({ userId: 'ou_y', text: 'hi' }),
        { text: 'hi', userId: 'ou_y' }
    )
    assert.deepEqual(
        buildSendBody({ replyTo: 'om_z', text: 'hi' }),
        { text: 'hi', replyToMessageId: 'om_z' }
    )
    assert.throws(() => buildSendBody({ chatId: 'oc_x' }), usage(/--text/))
    assert.throws(
        () => buildSendBody({ chatId: 'oc_x', text: '   ' }),
        usage(/--text/)
    )
    assert.throws(
        () => buildSendBody({ text: 'hi' }),
        usage(/exactly one target/)
    )
    assert.throws(
        () => buildSendBody({ chatId: 'oc_x', userId: 'ou_y', text: 'hi' }),
        usage(/exactly one target/)
    )
})

test('buildSendBody supports files with or without text', () => {
    assert.deepEqual(
        buildSendBody({ chatId: 'oc_x', file: ['report.pdf'] }),
        { files: ['report.pdf'], chatId: 'oc_x' }
    )
    assert.deepEqual(
        buildSendBody({
            userId: 'ou_y',
            text: 'chart attached',
            file: ['out/chart.png', 'out/data.csv']
        }),
        {
            text: 'chart attached',
            files: ['out/chart.png', 'out/data.csv'],
            userId: 'ou_y'
        }
    )
    assert.throws(
        () =>
            buildSendBody({
                chatId: 'oc_x',
                file: ['a', 'b', 'c', 'd', 'e']
            }),
        usage(/at most 4/)
    )
})

// A real child process, for the exit code the shell sees.
test(
    'a channels usage mistake exits 5 before any request',
    { timeout: 60_000 },
    async (t) => {
        const dir = await mkdtemp(join(tmpdir(), 'mf-cli-channels-usage-'))
        t.after(() => rm(dir, { recursive: true, force: true }))
        const child = spawnMf(
            [
                '--api-url',
                'http://127.0.0.1:9/api',
                'channels',
                'send',
                'chn_1',
                '--chat-id',
                'oc_x'
            ],
            { HOME: dir, MF_CONFIG_DIR: dir, MF_API_TOKEN: 'nca_rt_env' }
        )
        child.stdin.end()
        let stderr = ''
        child.stderr.on('data', (data) => (stderr += data))
        const [code] = await once(child, 'close')
        assert.equal(code, 5)
        assert.equal(stderr, 'error: provide --text, --file, or both\n')
    }
)
