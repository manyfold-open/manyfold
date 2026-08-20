import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Serving contract for the deployment-stale-chunk incident (#540): an
// existing hashed asset is JavaScript with a one-year immutable header; a
// hash deleted by a newer deploy is a real 404 with no long-lived caching —
// never the app shell as HTML 200 (which made Vite reject dynamic imports)
// and never negatively cached for a year. Runs the same caddy image as the
// production runtime stage, against both the web and the admin Caddyfile;
// admin-only edits skip this package's tests, so the structural half also
// lives in scripts/check-governance.mjs.

const IMMUTABLE = 'public, max-age=31536000, immutable'

const repoRoot = join(import.meta.dirname, '../../..')

const caddyImage = (app: string): string => {
    const dockerfile = readFileSync(
        join(repoRoot, `apps/${app}/Dockerfile`),
        'utf8'
    )
    const match = /FROM (caddy:\S+) AS runtime/.exec(dockerfile)
    assert.ok(match, `apps/${app}/Dockerfile has no caddy runtime stage`)
    return match[1]
}

const docker = (...args: string[]): string => {
    const result = spawnSync('docker', args, { encoding: 'utf8' })
    assert.equal(
        result.status,
        0,
        `docker ${args.slice(0, 2).join(' ')} failed: ${result.stderr}`
    )
    return result.stdout.trim()
}

const dockerAvailable =
    spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0

// CI must never skip this silently — a broken docker setup would otherwise
// read as "contract holds"
const skip = dockerAvailable
    ? false
    : process.env.CI
      ? assert.fail('docker is required in CI for the caddy contract test')
      : 'docker unavailable; caddy serving contract not verified'

type Server = { origin: string; stop: () => void }

const startCaddy = async (app: string, srvDir: string): Promise<Server> => {
    const image = caddyImage(app)
    docker('pull', '--quiet', image)
    const id = docker(
        'run',
        '--detach',
        '--rm',
        '--publish',
        '127.0.0.1:0:8080',
        '--volume',
        `${srvDir}:/srv:ro`,
        '--volume',
        `${join(repoRoot, `apps/${app}/Caddyfile`)}:/etc/caddy/Caddyfile:ro`,
        image
    )
    const stop = (): void => {
        spawnSync('docker', ['rm', '--force', id], { stdio: 'ignore' })
    }
    try {
        const address = docker('port', id, '8080/tcp').split('\n')[0]
        const origin = `http://${address}`
        for (let attempt = 0; ; attempt += 1) {
            try {
                await fetch(`${origin}/`)
                return { origin, stop }
            } catch {
                if (attempt >= 80) {
                    const logs = spawnSync('docker', ['logs', id], {
                        encoding: 'utf8'
                    })
                    assert.fail(
                        `caddy for ${app} never became ready: ${logs.stderr}`
                    )
                }
                await new Promise((resolve) => setTimeout(resolve, 250))
            }
        }
    } catch (error) {
        stop()
        throw error
    }
}

const writeFixtures = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'caddy-contract-'))
    for (const [name, content] of Object.entries(files)) {
        const filePath = join(dir, name)
        mkdirSync(join(filePath, '..'), { recursive: true })
        writeFileSync(filePath, content)
    }
    return dir
}

const assertNoLongLivedCache = (response: Response): void => {
    const cacheControl = response.headers.get('cache-control') ?? ''
    assert.ok(
        !cacheControl.includes('immutable'),
        `404 must not be immutable: ${cacheControl}`
    )
    assert.ok(
        !cacheControl.includes('max-age=31536000'),
        `404 must not carry a one-year max-age: ${cacheControl}`
    )
    assert.equal(cacheControl, 'no-cache')
}

test(
    'web caddy serves hashed assets immutable and misses as uncached 404s',
    { skip },
    async (t) => {
        const srv = writeFixtures({
            'index.html':
                '<!doctype html><html><body>fixture-marketing</body></html>',
            'app.html':
                '<!doctype html><html><body>fixture-app-shell</body></html>',
            '404.html': '<!doctype html><html><body>fixture-404</body></html>',
            'zh/index.html':
                '<!doctype html><html><body>fixture-zh-marketing</body></html>',
            'assets/index-TestHash.js': "console.log('web ok')"
        })
        const server = await startCaddy('web', srv)
        t.after(server.stop)

        const hit = await fetch(`${server.origin}/assets/index-TestHash.js`)
        assert.equal(hit.status, 200)
        assert.match(hit.headers.get('content-type') ?? '', /javascript/)
        assert.equal(hit.headers.get('cache-control'), IMMUTABLE)
        assert.equal(await hit.text(), "console.log('web ok')")

        const miss = await fetch(`${server.origin}/assets/index-Gone404x.js`)
        assert.equal(miss.status, 404)
        assertNoLongLivedCache(miss)
        const missBody = await miss.text()
        assert.ok(
            !missBody.includes('fixture-app-shell'),
            'a missing asset must never be served as the app shell'
        )
        assert.ok(missBody.includes('fixture-404'))

        const spa = await fetch(`${server.origin}/agents/abc/chat?sessionId=x`)
        assert.equal(spa.status, 200)
        assert.equal(spa.headers.get('x-robots-tag'), 'noindex, nofollow')
        assert.equal(spa.headers.get('cache-control'), 'no-cache')
        assert.ok((await spa.text()).includes('fixture-app-shell'))

        const marketing = await fetch(`${server.origin}/`)
        assert.equal(marketing.status, 200)
        assert.equal(marketing.headers.get('cache-control'), 'no-cache')
        assert.ok((await marketing.text()).includes('fixture-marketing'))

        const zhRedirect = await fetch(
            `${server.origin}/zh?stay=1&utm_source=seo`,
            { redirect: 'manual' }
        )
        assert.equal(zhRedirect.status, 308)
        assert.equal(
            zhRedirect.headers.get('location'),
            '/zh/?stay=1&utm_source=seo'
        )
        const zh = await fetch(`${server.origin}/zh/`)
        assert.equal(zh.status, 200)
        assert.ok((await zh.text()).includes('fixture-zh-marketing'))

        const unknown = await fetch(`${server.origin}/definitely/unknown`)
        assert.equal(unknown.status, 404)
        assert.ok((await unknown.text()).includes('fixture-404'))
    }
)

test(
    'admin caddy exempts assets from the SPA fallback and keeps it for routes',
    { skip },
    async (t) => {
        const srv = writeFixtures({
            'index.html':
                '<!doctype html><html><body>fixture-admin-shell</body></html>',
            'assets/admin-TestHash.js': "console.log('admin ok')"
        })
        const server = await startCaddy('admin', srv)
        t.after(server.stop)

        const hit = await fetch(`${server.origin}/assets/admin-TestHash.js`)
        assert.equal(hit.status, 200)
        assert.match(hit.headers.get('content-type') ?? '', /javascript/)
        assert.equal(hit.headers.get('cache-control'), IMMUTABLE)

        const miss = await fetch(`${server.origin}/assets/admin-Gone404x.js`)
        assert.equal(miss.status, 404)
        assertNoLongLivedCache(miss)
        assert.ok(
            !(await miss.text()).includes('fixture-admin-shell'),
            'a missing asset must never be served as the admin shell'
        )

        const route = await fetch(`${server.origin}/users/usr_abc`)
        assert.equal(route.status, 200)
        assert.equal(route.headers.get('cache-control'), 'no-cache')
        assert.ok((await route.text()).includes('fixture-admin-shell'))

        const shell = await fetch(`${server.origin}/index.html`)
        assert.equal(shell.status, 200)
        assert.equal(shell.headers.get('cache-control'), 'no-cache')
    }
)
