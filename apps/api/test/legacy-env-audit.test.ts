import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { LEGACY_CONFIG_ALIASES } from '../src/common/config-alias'
import { LegacyEnvAuditService } from '../src/modules/legacy-env-audit/legacy-env-audit.service'

const config = (values: Record<string, string | undefined>): never =>
    ({ get: (key: string) => values[key] }) as unknown as never

test('scan reports a set alias and whether the canonical shadows it', () => {
    const service = new LegacyEnvAuditService(
        config({ NCA_ADMIN_URL: 'https://admin.example.test' })
    )
    assert.deepEqual(service.scan(), [
        {
            key: 'NCA_ADMIN_URL',
            canonical: 'MF_ADMIN_URL',
            canonicalSet: false
        }
    ])

    const shadowed = new LegacyEnvAuditService(
        config({
            NCA_ADMIN_URL: 'https://admin.example.test',
            MF_ADMIN_URL: 'https://admin.example.test'
        })
    )
    assert.deepEqual(shadowed.scan(), [
        { key: 'NCA_ADMIN_URL', canonical: 'MF_ADMIN_URL', canonicalSet: true }
    ])
})

test('scan ignores unset, empty and whitespace-only aliases', () => {
    const service = new LegacyEnvAuditService(
        config({ NCA_WEB_URL: '', WEB_BASE_URL: '   ' })
    )
    assert.deepEqual(service.scan(), [])
})

test('bootstrap emits one telemetry event per hit, key names only', () => {
    const events: Array<{ name: string; attrs: Record<string, unknown> }> = []
    const telemetry = {
        event: (name: string, attrs: Record<string, unknown>) => {
            events.push({ name, attrs })
        }
    } as never
    const service = new LegacyEnvAuditService(
        config({
            NCA_WEB_URL: 'https://legacy.example.test',
            MF_WEB_URL: 'https://canonical.example.test'
        }),
        telemetry
    )
    service.onApplicationBootstrap()
    assert.deepEqual(events, [
        {
            name: 'config.legacy_env.in_use',
            attrs: {
                key: 'NCA_WEB_URL',
                canonical: 'MF_WEB_URL',
                canonicalSet: true
            }
        }
    ])
    for (const event of events)
        assert.ok(
            !JSON.stringify(event.attrs).includes('example.test'),
            'events must carry key names, never values'
        )
})

// On-sandbox / cross-process NCA_ surfaces that are deliberately outside the
// audit (the rationale lives on LEGACY_CONFIG_ALIASES in config-alias.ts).
const EXCLUDED_TOKENS = new Set([
    // sprite shell exports and block markers (legacy-inventory §9)
    'NCA_API_URL',
    'NCA_AGENT_ID',
    'NCA_TASK_NAME',
    'NCA_SHELL_ENV_START',
    'NCA_SHELL_ENV_END',
    // protocol sentinels (__NCA_MISSING__ / __NCA_STORAGE_SEP__)
    'NCA_MISSING__',
    'NCA_STORAGE_SEP__',
    // bootstrap/home-probe parses sandbox probe OUTPUT, not API env
    'NCA_HOME',
    // vite dev/build process variables (the API process never sees them);
    // NCA_ENV is the regex's view of VITE_NCA_ENV
    'NCA_DEV_HOST',
    'NCA_DEV_API_TARGET',
    'NCA_ENV'
])

const walk = (dir: string, files: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) walk(full, files)
        else if (full.endsWith('.ts')) files.push(full)
    }
    return files
}

test('every NCA_ token in api/packages sources is either audited or excluded', () => {
    const roots = [path.resolve('src')]
    const packagesRoot = path.resolve('..', '..', 'packages')
    for (const entry of readdirSync(packagesRoot)) {
        const srcDir = path.join(packagesRoot, entry, 'src')
        try {
            if (statSync(srcDir).isDirectory()) roots.push(srcDir)
        } catch {
            continue
        }
    }

    const audited = new Set(
        LEGACY_CONFIG_ALIASES.flatMap((entry) => [...entry.aliases])
    )
    const corpus: string[] = []
    const unknown = new Map<string, string>()
    for (const root of roots) {
        for (const file of walk(root)) {
            const text = readFileSync(file, 'utf8')
            corpus.push(text)
            for (const match of text.matchAll(/NCA_[A-Z_]+/g)) {
                const token = match[0]
                if (!audited.has(token) && !EXCLUDED_TOKENS.has(token))
                    unknown.set(token, file)
            }
        }
    }
    assert.deepEqual(
        [...unknown.entries()],
        [],
        'a new NCA_ key must join LEGACY_CONFIG_ALIASES (so the startup audit sees it) or EXCLUDED_TOKENS (with a reason)'
    )

    const everything = corpus.join('\n')
    for (const alias of audited)
        assert.ok(
            everything.includes(alias),
            `stale table entry: ${alias} is audited but no source reads it`
        )
})
