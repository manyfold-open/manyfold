#!/usr/bin/env node
// Boot the BUILT api against a scratch database and require that it actually
// serves /api/health, then shut it down.
//
// WHY this exists: `pnpm check` + `pnpm lint` + `pnpm test` never instantiate the
// Nest container, so a provider whose dependencies cannot be resolved passes CI
// and fails at DEPLOY time — as a crash loop, which takes the environment down
// instead of failing the deploy cleanly. That happened on 2026-07-25 (a service
// added to ChatModule needed a provider its module did not export, plus a
// constructor param that was a bare function and therefore had no DI token).
//
// Usage: DATABASE_URL=postgres://… node scripts/smoke-boot-api.mjs
// Assumes `apps/api` is already built (dist/main.js) and migrated.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'apps/api/dist/main.js')
const port = Number(process.env.SMOKE_PORT ?? 3999)
const bootTimeoutMs = Number(process.env.SMOKE_BOOT_TIMEOUT_MS ?? 120_000)

if (!process.env.DATABASE_URL) {
    console.error('smoke-boot: DATABASE_URL is required')
    process.exit(1)
}
if (!existsSync(entry)) {
    console.error(`smoke-boot: ${entry} not found — build apps/api first`)
    process.exit(1)
}

// Boot from an EMPTY directory: ConfigModule reads `.env` from the CWD, so
// running in apps/api would let a developer's local .env satisfy variables that
// CI does not have — the gate would then pass locally and fail in CI, which is
// precisely the failure it exists to prevent.
const cwd = mkdtempSync(join(tmpdir(), 'mf-smoke-boot-'))

const child = spawn(process.execPath, [entry], {
    cwd,
    env: {
        ...process.env,
        PORT: String(port),
        // Boot-time hard requirement, validated as base64-encoded 32 bytes.
        // Generated per run: nothing is encrypted here, and a hardcoded key in
        // the repo would just be a footgun waiting to be copied somewhere real.
        API_CRYPTO_KEY:
            process.env.API_CRYPTO_KEY ?? randomBytes(32).toString('base64'),
        NODE_ENV: process.env.NODE_ENV ?? 'production'
        // MF_K8S_GATEWAY_URL/TOKEN are deliberately NOT injected: booting
        // without them is the regression this gate now proves (GatewayExecClient
        // used to throw from its constructor inside a @Global module).
    },
    stdio: ['ignore', 'pipe', 'pipe']
})

let output = ''
const record = (chunk) => {
    const text = chunk.toString()
    output += text
    process.stdout.write(text)
}
child.stdout.on('data', record)
child.stderr.on('data', record)

let exited = null
child.on('exit', (code, signal) => {
    exited = { code, signal }
})

const fail = (reason) => {
    console.error(`\nsmoke-boot FAILED: ${reason}`)
    // The DI error Nest prints is the whole point of this check, so surface it
    // even when it scrolled past the tail of a long boot log.
    const diagnostic = output
        .split('\n')
        .filter((line) => /can't resolve|UnknownDependencies|ERROR/.test(line))
        .slice(-8)
    if (diagnostic.length > 0)
        console.error(`\n--- boot diagnostics ---\n${diagnostic.join('\n')}`)
    if (!child.killed) child.kill('SIGKILL')
    process.exit(1)
}

const healthy = async () => {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
            signal: AbortSignal.timeout(3000)
        })
        if (!res.ok) return false
        const body = await res.json()
        return body?.status === 'ok'
    } catch {
        return false
    }
}

const deadline = Date.now() + bootTimeoutMs
for (;;) {
    if (exited)
        fail(
            `the api exited during boot (code=${exited.code} signal=${exited.signal})`
        )
    if (await healthy()) break
    if (Date.now() >= deadline)
        fail(`/api/health did not report ok within ${bootTimeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 1000))
}

console.log('\nsmoke-boot OK: the api booted and /api/health reported ok')
child.kill('SIGTERM')
// SIGTERM triggers the graceful-shutdown path (which blocks on open sockets by
// design), so do not wait on it — the check is the successful boot.
setTimeout(() => {
    if (!exited) child.kill('SIGKILL')
    process.exit(0)
}, 3000).unref()
