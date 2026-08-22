import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Writable } from 'node:stream'
import { strFromU8, unzipSync } from 'fflate'
import { ExportBundleWriter } from '../src/modules/user-export/export-bundle'
import {
    REDACTED,
    redactExportValue
} from '../src/modules/user-export/export-redact'
import { ExportTokenService } from '../src/modules/user-export/export-token.service'

const noConfig = { get: () => undefined } as never

// The redaction contract behind the V-6 secret-free guarantee: a
// credential-shaped KEY is withheld at any depth, everything else passes
// through untouched. The pg V-6 test proves the pipeline end to end; this
// pins the classifier itself so a loosened regex fails fast and cheap.
test('redaction withholds credential-shaped keys at every depth', () => {
    const input = {
        envText: 'OPENAI_API_KEY=sk-live-x',
        a2aExposure: 'public',
        modelConfig: { provider: 'byo', apiKey: 'sk-live-y', model: 'gpt-5' },
        mcp: {
            servers: {
                docs: {
                    command: 'npx',
                    args: ['docs-mcp'],
                    env: { MCP_TOKEN: 'ldt_x' },
                    headers: { authorization: 'Bearer x' }
                }
            }
        },
        channel: {
            appId: 'cli_a1',
            verificationToken: 'v',
            encryptKey: 'e',
            subscriptionMode: 'websocket'
        },
        list: [{ botToken: 't', label: 'keep me' }]
    }
    const out = redactExportValue(input) as Record<string, never>
    const json = JSON.stringify(out)
    for (const secret of ['sk-live-x', 'sk-live-y', 'ldt_x', 'Bearer x'])
        assert.ok(!json.includes(secret), `${secret} must not survive`)
    assert.equal(out['envText'], REDACTED)
    assert.equal(out['a2aExposure'], 'public')
    const model = out['modelConfig'] as Record<string, unknown>
    assert.equal(model.apiKey, REDACTED)
    assert.equal(model.model, 'gpt-5')
    const server = (out['mcp'] as never)['servers']['docs'] as Record<
        string,
        unknown
    >
    assert.equal(server.env, REDACTED)
    assert.equal(server.headers, REDACTED)
    assert.equal(server.command, 'npx')
    assert.deepEqual(server.args, ['docs-mcp'])
    const channel = out['channel'] as Record<string, unknown>
    assert.equal(channel.verificationToken, REDACTED)
    assert.equal(channel.encryptKey, REDACTED)
    assert.equal(channel.appId, 'cli_a1')
    const item = (out['list'] as Array<Record<string, unknown>>)[0]
    assert.equal(item.botToken, REDACTED)
    assert.equal(item.label, 'keep me')
})

test('download tokens verify, expire, and reject tampering', () => {
    const service = new ExportTokenService(noConfig)
    const token = service.mint('uxp_1', new Date(Date.now() + 60_000))
    assert.equal(service.verify(token), 'uxp_1')
    // Expired at mint time never validates.
    assert.equal(
        service.verify(service.mint('uxp_1', new Date(Date.now() - 1000))),
        null
    )
    // A flipped signature bit dies in verify.
    const tampered = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')
    assert.equal(service.verify(tampered), null)
    assert.equal(service.verify('not-a-token'), null)
    assert.equal(service.verify(''), null)
})

test('bundle writer streams NDJSON and JSON entries into a real zip', async () => {
    const chunks: Buffer[] = []
    const out = new Writable({
        write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk))
            callback()
        }
    })
    const bundle = new ExportBundleWriter(out)
    const rows = bundle.entry('rows.ndjson')
    await rows.write({ n: 1 })
    await rows.write({ n: 2 })
    await rows.end()
    const empty = bundle.entry('empty.ndjson')
    await empty.end()
    await bundle.json('meta.json', { hello: 'world' })
    await bundle.finish()

    const zip = unzipSync(new Uint8Array(Buffer.concat(chunks)))
    assert.deepEqual(Object.keys(zip).sort(), [
        'empty.ndjson',
        'meta.json',
        'rows.ndjson'
    ])
    assert.deepEqual(
        strFromU8(zip['rows.ndjson'])
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
        [{ n: 1 }, { n: 2 }]
    )
    assert.equal(strFromU8(zip['empty.ndjson']), '')
    assert.deepEqual(JSON.parse(strFromU8(zip['meta.json'])), {
        hello: 'world'
    })
    assert.deepEqual(bundle.entryNames, [
        'rows.ndjson',
        'empty.ndjson',
        'meta.json'
    ])
})
