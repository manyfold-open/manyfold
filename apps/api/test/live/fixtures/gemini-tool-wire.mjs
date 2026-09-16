import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'gemini-wire-'))
const home = join(directory, 'home')
const workspace = join(directory, 'workspace')
await mkdir(join(home, '.gemini'), { recursive: true })
await mkdir(workspace)
await writeFile(
    join(home, '.gemini/settings.json'),
    JSON.stringify({
        security: { auth: { selectedType: 'gemini-api-key' } },
        general: { enableAutoUpdate: false },
        telemetry: { enabled: false },
        privacy: { usageStatisticsEnabled: false },
        model: { skipNextSpeakerCheck: true }
    })
)
let turn = 'fresh'
let calls = 0
const requests = []
const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    requests.push({ turn, path: request.url, contents: body.contents })
    if (request.url.includes('countTokens')) {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ totalTokens: 10 }))
        return
    }
    const parts =
        calls++ === 0
            ? [
                  {
                      functionCall: {
                          name: 'run_shell_command',
                          args: {
                              command: `printf gemini-wire-${turn}`,
                              description: 'Print a fixture marker'
                          }
                      }
                  }
              ]
            : [{ text: `completed-${turn}` }]
    const result = {
        candidates: [
            { content: { role: 'model', parts }, finishReason: 'STOP' }
        ],
        usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15
        }
    }
    if (request.url.includes('streamGenerateContent')) {
        response.setHeader('content-type', 'text/event-stream')
        response.end(`data: ${JSON.stringify(result)}\n\n`)
    } else {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(result))
    }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const run = (resume = false) =>
    new Promise((resolve, reject) => {
        const child = spawn(
            'gemini',
            [
                '--model',
                'gemini-2.5-flash',
                '--skip-trust',
                '--yolo',
                '--output-format',
                'stream-json',
                ...(resume ? ['--resume', 'latest'] : []),
                '-p',
                'Use run_shell_command to print the fixture marker, then reply briefly.'
            ],
            {
                cwd: workspace,
                env: {
                    PATH: process.env.PATH,
                    HOME: home,
                    GEMINI_API_KEY: randomBytes(24).toString('hex'),
                    GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${server.address().port}`,
                    NO_COLOR: '1'
                },
                stdio: ['ignore', 'pipe', 'pipe']
            }
        )
        let stdout = '',
            stderr = ''
        child.stdout.on('data', (data) => {
            stdout += data
        })
        child.stderr.on('data', (data) => {
            stderr += data
        })
        const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
        child.once('error', reject)
        child.once('close', (code, signal) => {
            clearTimeout(timer)
            if (code !== 0)
                reject(
                    new Error(JSON.stringify({ code, signal, stdout, stderr }))
                )
            else resolve({ stdout, stderr })
        })
    })
try {
    const version = JSON.parse(
        await readFile(
            '/usr/local/lib/node_modules/@google/gemini-cli/package.json',
            'utf8'
        )
    ).version
    assert.equal(version, '0.54.4')
    const fresh = await run()
    turn = 'resume'
    calls = 0
    const resumed = await run(true)
    const freshSession = JSON.parse(fresh.stdout.split('\n')[0]).session_id
    assert.equal(
        JSON.parse(resumed.stdout.split('\n')[0]).session_id,
        freshSession
    )
    assert.ok(
        JSON.stringify(
            requests.find((request) => request.turn === 'resume')?.contents
        ).includes('gemini-wire-fresh')
    )
    for (const [name, result] of [
        ['fresh', fresh],
        ['resume', resumed]
    ]) {
        const wire = result.stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        const tool = wire.find((event) => event.type === 'tool_use')
        const output = wire.find((event) => event.type === 'tool_result')
        assert.equal(tool.tool_name, 'run_shell_command')
        assert.equal(output.tool_id, tool.tool_id)
        assert.ok(String(output.output).includes(`gemini-wire-${name}`))
        assert.ok(
            requests.some(
                (request) =>
                    request.turn === name &&
                    JSON.stringify(request.contents).includes(
                        'functionResponse'
                    )
            )
        )
    }
    console.log(JSON.stringify({ version, fresh, resumed, requests }))
} finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
}
