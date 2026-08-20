import { spawnSync } from 'node:child_process'
import {
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync
} from 'node:fs'
import path from 'node:path'
import { FONT_CACHE_ENV, fontCacheDir, sha256 } from './fonts'
import { APPS, LOCK_REL, repoRoot, socialAssetRel } from './paths'
import { ALIAS_FILE, POSTER_LOCALES, posterFile } from './poster'
import {
    CANONICAL_IMAGE,
    CANONICAL_PLATFORM,
    IMAGE_ENV,
    IMAGE_PLATFORM_ENV,
    makeScratch,
    removeScratch
} from './runtime'

// `just og-render` and `just og-verify` come through here. The default path is
// the pinned linux/amd64 image and nothing else, so a Docker-capable macOS
// arm64 workstation and a Linux box produce and check the same bytes. $CHROME
// is the documented escape hatch: it wins, it renders natively against the
// worktree, and it cannot produce a committable lock — see runtimeStamp in
// runtime.ts.

// The pnpm store survives between runs so a re-render is seconds rather than a
// cold install. It is content-addressed and the install is frozen, so it cannot
// change what comes out; `docker volume rm mf-og-pnpm-store` starts it clean.
const STORE_VOLUME = 'mf-og-pnpm-store'

// Exactly what a render is allowed to bring back. Anything else the container
// wrote stays in the container — the historical vN cards above all, because a
// client that cached one by URL has no way to learn its bytes moved.
export const outputPaths = (): string[] => [
    LOCK_REL,
    ...APPS.flatMap((app) =>
        [...POSTER_LOCALES.map(posterFile), ALIAS_FILE].map((file) =>
            socialAssetRel(app, file)
        )
    )
]

const capture = (command: string, args: string[]): string => {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 64
    })
    if (result.error) throw result.error
    if (result.status !== 0)
        throw new Error(
            `${command} ${args[0]} exited ${result.status ?? 'on a signal'}\n${result.stderr}`
        )
    return result.stdout
}

const stream = (command: string, args: string[]): number => {
    const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' })
    if (result.error) throw result.error
    return result.status ?? 1
}

// Tracked plus untracked-but-not-ignored: what a contributor sees in
// `git status`. Deliberately not `git archive`, which reads HEAD — an
// uncommitted edit to packages/i18n has to reach the container, or sourcing the
// copy from the catalog buys nothing. Ignored paths never appear, so .env,
// .vault, node_modules, .turbo, coverage and the host font cache stay on the
// host and the container resolves its own dependencies for its own
// architecture.
export const stagedFiles = (): string[] => {
    const present = (file: string): boolean => {
        try {
            // lstat, so a symlink stages as a symlink instead of being dropped
            // for pointing somewhere outside the tree.
            lstatSync(path.join(repoRoot, file))
            return true
        } catch {
            // Tracked in the index, gone from the worktree. tar stops at the
            // first missing path, and the container should see the deletion.
            return false
        }
    }
    return capture('git', [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard'
    ])
        .split('\0')
        .filter(Boolean)
        .filter(present)
}

const stageSource = (scratch: string): number => {
    const files = stagedFiles()
    const list = path.join(scratch, 'files.z')
    writeFileSync(list, files.join('\0'))
    const status = stream('tar', [
        '-czf',
        path.join(scratch, 'src.tgz'),
        '--no-xattrs',
        '--null',
        '-T',
        list
    ])
    if (status !== 0) throw new Error(`tar exited ${status}`)
    return files.length
}

// Seed the container's font cache from the host's, so a re-render does not
// re-fetch 2.2MB of CJK. One-way on purpose: `--verify` has to leave the
// worktree exactly as it found it, and .fonts lives inside it.
const stageFonts = (scratch: string): void => {
    const from = fontCacheDir()
    const to = path.join(scratch, 'fonts')
    mkdirSync(to, { recursive: true })
    if (!existsSync(from)) return
    for (const entry of readdirSync(from, { withFileTypes: true }))
        if (entry.isFile())
            copyFileSync(path.join(from, entry.name), path.join(to, entry.name))
}

const CONTAINER_SCRIPT = `
set -euo pipefail
mkdir -p /repo /scratch/out
tar xzf /scratch/src.tgz -C /repo
cd /repo
corepack enable
pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm-store
cd apps/web
pnpm exec tsx scripts/og/render.ts \${MF_OG_MODE}
if [ -s /scratch/outputs.z ]; then
    while IFS= read -r -d '' rel; do
        mkdir -p "/scratch/out/$(dirname "$rel")"
        cp "/repo/$rel" "/scratch/out/$rel"
    done < /scratch/outputs.z
fi
chown -R "$MF_OG_HOST_UID:$MF_OG_HOST_GID" /scratch/out
`

const requireDocker = (): void => {
    const probe = spawnSync('docker', ['version', '--format', '{{.Server.Os}}'])
    if (probe.error || probe.status !== 0)
        throw new Error(
            'the canonical social-card renderer needs a running Docker daemon\n' +
                `  it renders in ${CANONICAL_IMAGE}\n` +
                `  on ${CANONICAL_PLATFORM} — the one runtime whose bytes are committable\n` +
                '  to render outside it anyway, point CHROME at a Chromium executable; that\n' +
                '  output is reviewable, and `pnpm social-card:check` will refuse to accept it'
        )
}

const containerRun = (scratch: string, verify: boolean): number => {
    requireDocker()
    console.log(`staging ${stageSource(scratch)} tracked and untracked files`)
    stageFonts(scratch)
    if (!verify)
        writeFileSync(
            path.join(scratch, 'outputs.z'),
            outputPaths()
                .map((rel) => `${rel}\0`)
                .join('')
        )
    console.log(`${CANONICAL_IMAGE}\n  platform ${CANONICAL_PLATFORM}`)
    return stream('docker', [
        'run',
        '--rm',
        '--platform',
        CANONICAL_PLATFORM,
        '--pull',
        'missing',
        '-v',
        `${scratch}:/scratch`,
        '-v',
        `${STORE_VOLUME}:/pnpm-store`,
        '-e',
        `MF_OG_MODE=${verify ? '--verify' : ''}`,
        '-e',
        `MF_OG_HOST_UID=${process.getuid?.() ?? 0}`,
        '-e',
        `MF_OG_HOST_GID=${process.getgid?.() ?? 0}`,
        '-e',
        `${FONT_CACHE_ENV}=/scratch/fonts`,
        '-e',
        `${IMAGE_ENV}=${CANONICAL_IMAGE}`,
        '-e',
        `${IMAGE_PLATFORM_ENV}=${CANONICAL_PLATFORM}`,
        '-e',
        'CI=1',
        CANONICAL_IMAGE,
        'bash',
        '-c',
        CONTAINER_SCRIPT
    ])
}

const walk = (dir: string, base = ''): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
            ? walk(path.join(dir, entry.name), `${base}${entry.name}/`)
            : [`${base}${entry.name}`]
    )

// The container renders into its own copy of the repo. Only the lock, the
// current-version cards and the alias come home, and only if the container
// produced that set exactly — no more, no fewer.
const collectOutputs = (scratch: string): void => {
    const from = path.join(scratch, 'out')
    const expected = [...outputPaths()].sort()
    const produced = existsSync(from) ? walk(from).sort() : []
    if (produced.join('|') !== expected.join('|'))
        throw new Error(
            'the container did not produce the set of files a render is allowed to write\n' +
                `  expected: ${expected.join(', ')}\n` +
                `  produced: ${produced.join(', ') || '(nothing)'}`
        )
    for (const rel of expected) {
        const to = path.resolve(repoRoot, rel)
        if (!to.startsWith(`${repoRoot}${path.sep}`))
            throw new Error(`${rel} resolves outside the repository`)
        mkdirSync(path.dirname(to), { recursive: true })
        copyFileSync(path.join(from, rel), to)
        console.log(`  ${rel}`)
    }
}

// `--verify` says the committed cards are the canonical ones; it has no licence
// to change them while finding out. Rather than assert that, measure it.
const worktreeFingerprint = (): string =>
    [
        capture('git', ['status', '--porcelain']),
        ...outputPaths().map((rel) => {
            const at = path.join(repoRoot, rel)
            return `${rel} ${existsSync(at) ? sha256(readFileSync(at)) : 'absent'}`
        })
    ].join('\n')

const main = async (): Promise<void> => {
    const verify = process.argv.includes('--verify')
    const override = process.env.CHROME?.trim()
    if (override) {
        // #625's own acceptance criterion: an explicit override wins. It runs
        // the renderer here, against the worktree, with no container involved.
        console.log(
            `CHROME=${override}\n` +
                '  rendering natively: the override wins over the canonical container'
        )
        const { runRender } = await import('./render')
        await runRender(verify)
        return
    }
    const scratch = makeScratch()
    const before = verify ? worktreeFingerprint() : ''
    try {
        const status = containerRun(scratch, verify)
        if (verify) {
            if (worktreeFingerprint() !== before)
                throw new Error('`--verify` changed the worktree; it must not')
            if (status === 0) console.log('the worktree is untouched')
            process.exitCode = status
            return
        }
        if (status !== 0)
            throw new Error(`the canonical render exited ${status}`)
        collectOutputs(scratch)
    } finally {
        removeScratch(scratch)
    }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
    await main()
