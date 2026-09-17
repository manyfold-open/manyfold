import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { GeminiCliAdapter } from '../../src/modules/chat/adapters/gemini-cli.adapter'
import type { ApiChatAdapterContext } from '../../src/modules/chat/chat-adapter'
import type { ExecStreamRequest } from '../../src/modules/chat/adapters/exec-driver'

const capture = async (
    mode: 'platform' | 'local' | 'profile',
    resume = false
) => {
    let request: ExecStreamRequest | undefined
    const adapter = new GeminiCliAdapter(
        {
            forAgent: async () => ({
                driver: {
                    stream: (value: ExecStreamRequest) => {
                        request = value
                        return {
                            stdout: (async function* () {})(),
                            stderr: (async function* () {})(),
                            result: Promise.resolve({
                                exitCode: 0,
                                stdout: '',
                                stderr: ''
                            }),
                            abort: () => {}
                        }
                    }
                },
                runtime: 'daemon',
                agent: { daemonId: 'fixture-daemon' },
                creds: {
                    googleApiKey: 'fixture-placeholder',
                    googleGeminiBaseUrl: 'http://127.0.0.1:1',
                    inferenceProtocol: 'google_generate_content'
                },
                resolvePriceScope: async () => ({
                    modelProviderId: 'fixture-provider',
                    modelProviderBuiltInId: null,
                    modelProviderManagedBrand: 'google'
                }),
                supportsExecResources: async () => true,
                authContext:
                    mode === 'profile'
                        ? {
                              framework: 'gemini-cli',
                              runtimeId: 'fixture-runtime',
                              profileId: 'fixture-profile',
                              bindingVersion: 1
                          }
                        : null
            })
        } as never,
        {} as never,
        {} as never
    )
    const context = {
        agentId: 'fixture-agent',
        messageId: 'fixture-message',
        framework: 'gemini-cli',
        runtimeKind: 'daemon',
        model: 'gemini-2.5-flash',
        modelOverride: null,
        modelConfig:
            mode === 'platform'
                ? { framework: 'gemini-cli', model: 'gemini-2.5-flash' }
                : null,
        runtimeLocalTuning: mode === 'platform' ? null : {},
        frameworkSessionRef: resume ? '__SESSION__' : null,
        history: []
    } as unknown as ApiChatAdapterContext
    for await (const event of adapter.sendMessage(context, {
        id: 'fixture-prompt',
        sessionId: 'fixture-session',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'Reply briefly.' }],
        createdAt: new Date().toISOString()
    }))
        void event
    assert.ok(request)
    return request
}

async function main() {
    assert.equal(
        process.env.RUN_GEMINI_PLATFORM_E2E,
        '1',
        'RUN_GEMINI_PLATFORM_E2E=1 is required; owned Docker fixture only'
    )
    assert.ok(process.argv[2], 'expected report directory')
    const reportDirectory = resolve(process.argv[2])
    await mkdir(reportDirectory, { recursive: true })
    const platform = await capture('platform')
    const resumed = await capture('platform', true)
    for (const mode of ['local', 'profile'] as const) {
        const native = await capture(mode)
        assert.equal(
            native.env,
            undefined,
            `${mode} must receive no platform credentials/settings`
        )
        assert.ok(
            !native.cmd.some((part) => part.includes('mf-gemini-platform-'))
        )
    }
    const image =
        process.env.GEMINI_CLI_FIXTURE_IMAGE || 'mf-acceptance-gemini:0.54.4'
    const exec = promisify(execFile)
    const imageId = (
        await exec('docker', ['image', 'inspect', image, '--format', '{{.Id}}'])
    ).stdout.trim()
    const container = 'mf-1275-gemini-' + randomBytes(6).toString('hex')
    try {
        const result = await new Promise<string>((done, fail) => {
            const child = spawn(
                'docker',
                [
                    'run',
                    '--rm',
                    '--init',
                    '-i',
                    '--network',
                    'none',
                    '--name',
                    container,
                    '--mount',
                    `type=bind,src=${join(__dirname, 'fixtures/gemini-platform-pricing.mjs')},dst=/fixture.mjs,readonly`,
                    image,
                    'node',
                    '/fixture.mjs'
                ],
                { stdio: ['pipe', 'pipe', 'pipe'] }
            )
            let stdout = '',
                stderr = ''
            child.stdout.on('data', (chunk) => {
                stdout += chunk
            })
            child.stderr.on('data', (chunk) => {
                stderr += chunk
            })
            const timer = setTimeout(() => child.kill('SIGKILL'), 150000)
            child.once('error', fail)
            child.once('close', (code) => {
                clearTimeout(timer)
                if (code !== 0)
                    fail(new Error(`Owned fixture exit ${code}: ${stderr}`))
                else done(stdout)
            })
            child.stdin.end(
                JSON.stringify({
                    platform: { cmd: platform.cmd, env: platform.env },
                    resumed: { cmd: resumed.cmd, env: resumed.env }
                })
            )
        })
        const report = {
            ...JSON.parse(result),
            imageId,
            image,
            nativeAndProfileNoInjection: true
        }
        assert.equal(report.cliVersion, '0.54.4')
        await writeFile(
            join(reportDirectory, 'result.json'),
            JSON.stringify(report, null, 2) + '\n'
        )
        console.log(JSON.stringify(report))
    } finally {
        await exec('docker', ['rm', '-f', container]).catch(
            (error: { stderr?: string }) => {
                if (!error.stderr?.includes('No such container')) throw error
            }
        )
    }
}
main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
