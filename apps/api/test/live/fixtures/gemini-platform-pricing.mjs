import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { watch } from 'node:fs'
import {
    mkdtemp,
    mkdir,
    readFile,
    writeFile,
    rm,
    readdir,
    stat
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let input = ''
for await (const chunk of process.stdin) input += chunk
const launches = JSON.parse(input)
const root = await mkdtemp(join(tmpdir(), 'gemini-platform-fixture-'))
const home = join(root, 'home'),
    workspace = join(root, 'workspace'),
    temporary = join(root, 'tmp')
await mkdir(join(home, '.gemini'), { recursive: true })
await mkdir(workspace)
await mkdir(temporary)
const native = JSON.stringify({
    security: { auth: { selectedType: 'oauth-personal' } },
    telemetry: { enabled: false },
    privacy: { usageStatisticsEnabled: false },
    general: { enableAutoUpdate: false },
    model: { skipNextSpeakerCheck: true }
})
const nativePath = join(home, '.gemini/settings.json')
await writeFile(nativePath, native)
await writeFile(
    join(workspace, 'GEMINI.md'),
    'The fixture-instruction-marker must remain in context.'
)
const key = randomBytes(32).toString('hex')
const explicitSystem = join(root, 'system.json')
const defaultSystem = '/etc/gemini-cli/settings.json'
const policy = {
    tools: { exclude: ['run_shell_command'] },
    general: { preferredEditor: 'vim' }
}
let mode = 'normal',
    requests = [],
    activeChild,
    runSequence = 0
const runs = new Map()
const childPids = new Set()
const server = createServer(async (request, response) => {
    const running = runs.get(request.url.split('/')[1])
    assert.ok(running)
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    requests.push({
        path: request.url,
        contents: body.contents,
        systemInstruction: body.systemInstruction ?? body.system_instruction,
        tools: body.tools,
        bodyKeys: Object.keys(body),
        markerPresent: JSON.stringify(body).includes(
            'fixture-instruction-marker'
        ),
        authenticated: request.headers['x-goog-api-key'] === key
    })
    if (running.inspect) {
        running.inspect = false
        const dirs = (await readdir(temporary)).filter((name) =>
            name.startsWith('mf-gemini-platform-')
        )
        assert.equal(dirs.length, 1)
        const directory = join(temporary, dirs[0]),
            file = join(directory, 'settings.json')
        assert.equal((await stat(directory)).mode & 0o777, 0o700)
        assert.equal((await stat(file)).mode & 0o777, 0o600)
        const raw = await readFile(file, 'utf8')
        assert.ok(!raw.includes(key), 'no actual API key in temporary settings')
        const settings = JSON.parse(raw)
        assert.deepEqual(settings.tools, policy.tools)
        assert.deepEqual(settings.general, policy.general)
        const pids = (
            await readFile(
                `/proc/${running.child.pid}/task/${running.child.pid}/children`,
                'utf8'
            )
        )
            .trim()
            .split(/\s+/)
            .filter(Boolean)
        for (const pid of pids) childPids.add(pid)
        running.started()
    }
    if (running.mode === 'cancel') return
    if (running.mode === 'error') {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(
            JSON.stringify({
                error: {
                    code: 400,
                    status: 'INVALID_ARGUMENT',
                    message: 'fixture request rejected'
                }
            })
        )
        return
    }
    const payload = request.url.includes('countTokens')
        ? { totalTokens: 10 }
        : {
              candidates: [
                  {
                      content: {
                          role: 'model',
                          parts: [{ text: 'fixture-reply' }]
                      },
                      finishReason: 'STOP'
                  }
              ],
              usageMetadata: {
                  promptTokenCount: 10,
                  candidatesTokenCount: 5,
                  totalTokenCount: 15
              }
          }
    response.setHeader(
        'content-type',
        request.url.includes('streamGenerateContent')
            ? 'text/event-stream'
            : 'application/json'
    )
    response.end(
        request.url.includes('streamGenerateContent')
            ? `data: ${JSON.stringify(payload)}\n\n`
            : JSON.stringify(payload)
    )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const settingsCreated = () =>
    new Promise((resolve, reject) => {
        let checking = false
        const finish = (error) => {
            clearTimeout(timer)
            watcher.close()
            if (error) reject(error)
            else resolve()
        }
        const check = async () => {
            if (checking) return
            checking = true
            try {
                for (const name of await readdir(temporary)) {
                    if (!name.startsWith('mf-gemini-platform-')) continue
                    if (
                        await stat(
                            join(temporary, name, 'settings.json')
                        ).catch(() => null)
                    ) {
                        finish()
                        return
                    }
                }
            } catch (error) {
                finish(error)
            } finally {
                checking = false
            }
        }
        const watcher = watch(
            temporary,
            { recursive: true },
            () => void check()
        )
        const timer = setTimeout(
            () =>
                finish(
                    new Error(
                        'launcher did not reach its owned temporary settings'
                    )
                ),
            10000
        )
        void check()
    })
const run = async ({
    resume,
    system = explicitSystem,
    outcome = 'success',
    openInput = false
} = {}) => {
    const launch = resume ? launches.resumed : launches.platform
    const command = launch.cmd.map((part) =>
        part === '__SESSION__' ? resume : part
    )
    let began
    const started = new Promise((resolve) => {
        began = resolve
    })
    const runId = String(++runSequence)
    const running = { mode, child: null, inspect: true, started: began }
    runs.set(runId, running)
    const ready = openInput ? settingsCreated() : null
    const requestsBefore = requests.length
    const completed = new Promise((resolve, reject) => {
        activeChild = spawn(command[0], command.slice(1), {
            cwd: workspace,
            env: {
                PATH: process.env.PATH,
                HOME: home,
                TMPDIR: temporary,
                NO_COLOR: '1',
                ...launch.env,
                GEMINI_API_KEY: key,
                GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${server.address().port}/${runId}`,
                ...(system ? { GEMINI_CLI_SYSTEM_SETTINGS_PATH: system } : {})
            },
            stdio: ['pipe', 'pipe', 'pipe']
        })
        let stdout = '',
            stderr = ''
        activeChild.stdout.on('data', (chunk) => {
            stdout += chunk
        })
        activeChild.stderr.on('data', (chunk) => {
            stderr += chunk
        })
        const timer = setTimeout(() => activeChild.kill('SIGKILL'), 45000)
        activeChild.once('error', reject)
        activeChild.once('close', (code, signal) => {
            clearTimeout(timer)
            resolve({ code, signal, stdout, stderr })
        })
        running.child = activeChild
        activeChild.stdin.on('error', () => {})
        if (openInput) activeChild.stdin.write('Unfinished fixture prompt')
        else activeChild.stdin.end('Reply with the fixture marker.')
    })
    if (outcome === 'cancelled') {
        await Promise.race([
            ready ?? started,
            completed.then(() => {
                throw new Error(
                    'launcher exited before the controlled cancellation'
                )
            })
        ])
        if (openInput)
            assert.equal(
                (
                    await readFile(
                        `/proc/${activeChild.pid}/task/${activeChild.pid}/children`,
                        'utf8'
                    )
                ).trim(),
                ''
            )
        activeChild.kill('SIGTERM')
    }
    let exitTimer
    const result = await Promise.race([
        completed,
        new Promise((_, reject) => {
            exitTimer = setTimeout(
                async () => {
                    const evidence = {
                        openInput,
                        mode,
                        pid: activeChild.pid,
                        waiting: await readFile(
                            `/proc/${activeChild.pid}/wchan`,
                            'utf8'
                        ).catch(() => 'gone'),
                        directories: (await readdir(temporary)).filter((name) =>
                            name.startsWith('mf-gemini-platform-')
                        )
                    }
                    activeChild.kill('SIGKILL')
                    reject(
                        new Error(
                            `cancellation exceeded the owned launcher exit budget: ${JSON.stringify(evidence)}`
                        )
                    )
                },
                outcome === 'cancelled' ? 2500 : 50000
            )
        })
    ]).finally(() => clearTimeout(exitTimer))
    if (openInput) {
        assert.equal(requests.length, requestsBefore)
        assert.equal(result.code, 143)
    }
    assert.ok(
        !result.stdout.includes(key) && !result.stderr.includes(key),
        'no API key in output'
    )
    if (outcome === 'success') assert.equal(result.code, 0, result.stderr)
    else assert.notEqual(result.code, 0)
    assert.deepEqual(
        (await readdir(temporary)).filter((name) =>
            name.startsWith('mf-gemini-platform-')
        ),
        [],
        `temporary settings cleaned after ${outcome}`
    )
    assert.equal(await readFile(nativePath, 'utf8'), native)
    for (const pid of childPids)
        await assert.rejects(stat(`/proc/${pid}`), { code: 'ENOENT' })
    childPids.clear()
    server.closeAllConnections()
    return result
}
try {
    await writeFile(explicitSystem, JSON.stringify(policy))
    await run({ openInput: true, outcome: 'cancelled' })
    const fresh = await run()
    const session = fresh.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((event) => event.type === 'init')?.session_id
    assert.ok(session)
    const resumed = await run({ resume: session })
    assert.ok(resumed.stdout.includes(session))
    const completions = requests.filter((request) =>
        request.path.includes('streamGenerateContent')
    )
    assert.ok(
        completions.length >= 2 &&
            completions.every((request) => request.authenticated)
    )
    assert.ok(
        JSON.stringify(completions.at(-1).contents).includes('fixture-reply')
    )
    assert.ok(
        completions.some((request) => request.markerPresent),
        JSON.stringify(
            completions.map((request) => ({
                keys: request.bodyKeys,
                markerPresent: request.markerPresent
            }))
        )
    )
    assert.ok(
        completions.every(
            (request) =>
                !JSON.stringify(request.tools).includes('run_shell_command')
        ),
        'original system tool exclusion remains effective'
    )
    assert.equal(await readFile(explicitSystem, 'utf8'), JSON.stringify(policy))
    await mkdir('/etc/gemini-cli', { recursive: true })
    await writeFile(defaultSystem, JSON.stringify(policy))
    await run({ system: null })
    assert.equal(await readFile(defaultSystem, 'utf8'), JSON.stringify(policy))
    for (const constraint of [
        { security: { auth: { enforcedType: 'oauth-personal' } } },
        { model: { name: 'system-only-model' } }
    ]) {
        const previous = requests.length
        await writeFile(
            explicitSystem,
            JSON.stringify({ ...policy, ...constraint })
        )
        await run({ outcome: 'policy-error' })
        assert.equal(
            requests.length,
            previous,
            'policy conflict stops before any model request'
        )
    }
    await writeFile(explicitSystem, JSON.stringify(policy))
    mode = 'error'
    await run({ outcome: 'error' })
    mode = 'cancel'
    await run({ outcome: 'cancelled' })
    console.log(
        JSON.stringify({
            cliVersion: JSON.parse(
                await readFile(
                    '/usr/local/lib/node_modules/@google/gemini-cli/package.json',
                    'utf8'
                )
            ).version,
            pass: true,
            cases: [
                'production launcher fresh/resume',
                'native settings and context preserved',
                'explicit/default system policy preserved',
                'enforced auth/model conflicts reject before model request',
                'temporary directory 0700 and file 0600 without keys',
                'open-stdin cancellation before child spawn',
                'success/error/cancel cleanup and child reaping'
            ]
        })
    )
} finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
}
