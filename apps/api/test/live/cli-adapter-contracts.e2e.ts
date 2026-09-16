import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runAdapterWire } from '../adapter-wire-harness'
import { normalizeChatErrorPayload } from '../../src/modules/chat/chat-failure-cause'

const main = async (): Promise<void> => {
    assert.equal(
        process.env.RUN_CLI_ADAPTER_E2E,
        '1',
        'opt in with RUN_CLI_ADAPTER_E2E=1; isolated Docker fixture only'
    )
    assert.ok(process.argv[2], 'expected a report directory')
    const reportDirectory = resolve(process.argv[2])
    await mkdir(reportDirectory, { recursive: true })
    const exec = promisify(execFile)
    const image =
        process.env.GEMINI_CLI_FIXTURE_IMAGE || 'mf-acceptance-gemini:0.54.4'
    const inspected = await exec('docker', [
        'image',
        'inspect',
        image,
        '--format',
        '{{.Id}}'
    ])
    const imageId = inspected.stdout.trim()
    const expectedImageId =
        process.env.GEMINI_CLI_FIXTURE_IMAGE_ID ||
        (image === 'mf-acceptance-gemini:0.54.4'
            ? 'sha256:8ce6a516ebae47845efc74cd95f3aff506a8ad21465eadc0d1d67ef3c33579fc'
            : null)
    if (expectedImageId) assert.equal(imageId, expectedImageId)
    const container = 'mf-adapter-contract-' + randomBytes(5).toString('hex')
    const report: {
        image: string
        imageId: string
        cliVersion?: string
        cases: string[]
        pass?: boolean
        cleaned?: boolean
    } = {
        image,
        imageId,
        cases: []
    }
    try {
        const fixture = join(__dirname, 'fixtures/gemini-tool-wire.mjs')
        const result = await exec(
            'docker',
            [
                'run',
                '--rm',
                '--name',
                container,
                '--network',
                'none',
                '-v',
                `${fixture}:/fixture.mjs:ro`,
                image,
                'node',
                '/fixture.mjs'
            ],
            {
                timeout: 150000,
                maxBuffer: 16 * 1024 * 1024,
                killSignal: 'SIGKILL'
            }
        )
        const captured = JSON.parse(result.stdout)
        report.cliVersion = captured.version
        await writeFile(
            join(reportDirectory, 'gemini-capture.json'),
            result.stdout
        )
        for (const name of ['fresh', 'resumed']) {
            const wire: string = captured[name].stdout
            await writeFile(
                join(reportDirectory, `gemini-${name}.ndjson`),
                wire
            )
            const records = wire
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line))
            const call = records.find((record) => record.type === 'tool_use')
            const result = records.find(
                (record) => record.type === 'tool_result'
            )
            for (const resume of [false, true]) {
                const { events, calls } = await runAdapterWire(
                    'gemini-cli',
                    wire,
                    {
                        resume,
                        sessionRef: records[0].session_id
                    }
                )
                assert.deepEqual(
                    events.filter(
                        (event) =>
                            event.type === 'tool_call' ||
                            event.type === 'tool_result'
                    ),
                    [
                        {
                            type: 'tool_call',
                            toolCallId: call.tool_id,
                            toolName: call.tool_name,
                            args: call.parameters
                        },
                        {
                            type: 'tool_result',
                            toolCallId: call.tool_id,
                            result: result.output
                        }
                    ]
                )
                assert.equal(events.at(-1)?.type, 'done')
                assert.equal(calls.length, 1)
            }
            report.cases.push(
                `published Gemini ${captured.version} ${name}: actual tool execution, correlated call/result, dispatch and resume replay`
            )
        }
        for (const [kind, detail, expected] of [
            [
                'overload',
                'stream disconnected before completion: Our servers are currently overloaded. Please try again later.',
                'provider_overloaded'
            ],
            [
                'throttle',
                'exceeded retry limit, last status: 429 Too Many Requests',
                'rate_limited'
            ]
        ]) {
            const child = spawn(
                process.execPath,
                [
                    join(__dirname, 'fixtures/codex-failure-shim.mjs'),
                    'exec',
                    '--json',
                    '-'
                ],
                {
                    env: {
                        PATH: process.env.PATH,
                        RUN_CODEX_FAILURE_FIXTURE: '1',
                        CODEX_FIXTURE_FAILURE: kind
                    },
                    stdio: ['ignore', 'pipe', 'pipe']
                }
            )
            let stderr = ''
            let stdout = ''
            child.stdout.on('data', (data) => {
                stdout += data
            })
            child.stderr.on('data', (data) => {
                stderr += data
            })
            const exitCode = await new Promise<number | null>(
                (resolve, reject) => {
                    child.once('error', reject)
                    child.once('close', resolve)
                }
            )
            assert.equal(exitCode, 1)
            const wire = stdout
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line))
            assert.equal(wire.at(-1).error.message, detail)
            await writeFile(
                join(reportDirectory, `codex-${kind}.ndjson`),
                stdout
            )
            for (const resume of [false, true]) {
                const { events, calls } = await runAdapterWire(
                    'codex',
                    stdout,
                    {
                        resume,
                        stderr,
                        sessionRef: wire[0].thread_id,
                        exitCode: exitCode!
                    }
                )
                const terminal = events.find((event) => event.type === 'error')
                assert.ok(terminal?.type === 'error')
                const path = join(
                    reportDirectory,
                    `codex-${kind}-${resume ? 'resume' : 'fresh'}.json`
                )
                await writeFile(
                    path,
                    JSON.stringify(
                        normalizeChatErrorPayload({
                            type: 'error',
                            error: terminal.error
                        }),
                        null,
                        2
                    )
                )
                const readback = JSON.parse(await readFile(path, 'utf8'))
                assert.equal(readback.error.cause, expected)
                assert.equal(readback.error.retryable, true)
                assert.equal(calls.length, 1)
                report.cases.push(
                    `controlled Codex exit 1 ${kind} ${resume ? 'resume' : 'fresh'}: normalized terminal file readback retains retryable cause`
                )
            }
        }
        report.pass = true
    } finally {
        const remaining = await exec('docker', [
            'ps',
            '-aq',
            '--filter',
            `name=^/${container}$`
        ])
        if (remaining.stdout.trim())
            await exec('docker', ['rm', '-f', '-v', container])
        report.cleaned = true
        await writeFile(
            join(reportDirectory, 'result.json'),
            JSON.stringify(report, null, 2)
        )
    }
    console.log(JSON.stringify(report))
}

void main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
