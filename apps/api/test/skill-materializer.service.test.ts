import type { SkillFramework } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ExecOptions,
    ExecResult,
    SpriteReadFileResult,
    SpriteRmOptions,
    SpriteWriteFileArgs,
    SpritesClient,
    SpritesLogger
} from '@manyfold/sprites'
import type { PodExec } from '../src/modules/k8s/pod-exec'
import type { DesiredSkill } from '../src/modules/skills/skill-materializer.service'
import { SkillMaterializerService } from '../src/modules/skills/skill-materializer.service'
import {
    isManagedSkillWorkspace,
    skillStoreKey
} from '../src/modules/skills/skill-utils'

const desiredSkill: DesiredSkill = {
    kind: 'github',
    userSkillId: 'user-skill-1',
    skillId: 'github:anthropics/skills@main:skills/pdf',
    installDir: 'pdf-toolkit',
    repoOwner: 'anthropics',
    repoName: 'skills',
    repoBranch: 'main',
    sourcePath: 'skills/pdf',
    revision: 'rev-2'
}

test('skillStoreKey stays within the install-dir length cap for a long skillId', () => {
    const key = skillStoreKey({
        skillId:
            'github:some-very-long-org-name/an-extremely-long-repository-name@main:skills/deeply/nested/path/to/a/skill',
        repoOwner: 'some-very-long-org-name',
        repoName: 'an-extremely-long-repository-name',
        repoBranch: 'main',
        sourcePath: 'skills/deeply/nested/path/to/a/skill',
        revision: 'rev-2'
    })
    assert.ok(key.length <= 64)
    assert.match(key, /^[a-z0-9][a-z0-9._-]{0,63}$/)
})

test('skillStoreKey re-keys when the revision changes (copy-on-write updates)', () => {
    const a = skillStoreKey(desiredSkill)
    const b = skillStoreKey({ ...desiredSkill, revision: 'rev-3' })
    assert.notEqual(a, b)
})

test('isManagedSkillWorkspace recognizes only managed workspaces', () => {
    assert.equal(
        isManagedSkillWorkspace('/home/sprite/.manyfold/workspaces/agent-1'),
        true
    )
    assert.equal(
        isManagedSkillWorkspace('/home/node/.nca/workspaces/abc'),
        true
    )
    // ADR-0014: daemon-host workspaces live under the profile root
    assert.equal(
        isManagedSkillWorkspace(
            '/Users/t/.manyfold/profiles/default/workspaces/agt_1'
        ),
        true
    )
    assert.equal(
        isManagedSkillWorkspace(
            '/Users/t/.manyfold/profiles/team-a/workspaces/agt_1'
        ),
        true
    )
    assert.equal(isManagedSkillWorkspace('/home/user/my-project'), false)
    assert.equal(
        isManagedSkillWorkspace(
            '/Users/t/.manyfold/profiles/Bad Name/workspaces/agt_1'
        ),
        false
    )
})

test('host store: downloads each skill once into ~/.manyfold/skills (claude-code)', async () => {
    const materializer = new TestMaterializer([desiredSkill])

    await materializer.materializeForSprite(input())

    const key = skillStoreKey(desiredSkill)
    const download = materializer
        .scripts()
        .find((script) => script.includes('codeload.github.com'))
    assert.ok(download)
    assert.ok(download.includes('tar.gz/rev-2'))
    assert.ok(download.includes('/home/test/.manyfold/skills'))
    assert.ok(
        materializer.statPaths.includes(
            `/home/test/.manyfold/skills/${key}/SKILL.md`
        )
    )
    // the new path keeps no `.skill-lock.json` — the workspace activation set is
    // the state — and never clones into the shared ~/.claude/skills
    assert.equal(materializer.writes.length, 0)
})

test('host store: github download sparse-fetches the subtree, keeps a tarball fallback', async () => {
    const materializer = new TestMaterializer([desiredSkill])

    await materializer.materializeForSprite(input())

    const download = materializer
        .scripts()
        .find((script) => script.includes('codeload.github.com'))
    assert.ok(download)
    // fast path: sparse checkout of only the skill's own subtree (#341 Phase 2)
    assert.ok(download.includes('git sparse-checkout set "$path"'))
    assert.ok(download.includes('--filter=blob:none'))
    assert.ok(download.includes('github.com/anthropics/skills.git'))
    assert.ok(download.includes("path='skills/pdf'"))
    // fallback to the full-repo tarball is still present so nothing regresses
    assert.ok(download.includes('tar.gz/rev-2'))
})

test('host store: sweeps stale .tmp* leftovers before downloading', async () => {
    const materializer = new TestMaterializer([desiredSkill])

    await materializer.materializeForSprite(input())

    assert.ok(
        materializer
            .scripts()
            .some(
                (script) =>
                    script.includes("-name '.tmp*'") &&
                    script.includes('-mmin +60') &&
                    script.includes('/home/test/.manyfold/skills')
            )
    )
})

test('per-agent activation: symlinks the store skill into the workspace (claude-code)', async () => {
    const materializer = new TestMaterializer([desiredSkill])

    await materializer.materializeForSprite(input())

    const key = skillStoreKey(desiredSkill)
    const link = materializer
        .scripts()
        .find((script) => script.includes('ln -s'))
    assert.ok(link)
    // installDir (display name) decoupled from the identity+revision store key
    assert.ok(link.includes(`'/home/test/.manyfold/skills/${key}'`))
    assert.ok(
        link.includes(
            '/home/test/.manyfold/workspaces/agent-1/.claude/skills/pdf-toolkit'
        )
    )
})

test('per-agent activation: removes only our symlink for a no-longer-desired skill', async () => {
    const materializer = new TestMaterializer([desiredSkill])
    materializer.activationListing = 'stale-skill\tstale-key\n'

    await materializer.materializeForSprite(input())

    const remove = materializer
        .scripts()
        .find(
            (script) =>
                script.includes('stale-skill') && script.includes('rm -f')
        )
    assert.ok(remove)
    // guarded: only removes when the entry is a symlink we own
    assert.ok(remove.includes('[ -L'))
})

test('per-agent activation: re-links when the desired store key changes (revision bump)', async () => {
    const materializer = new TestMaterializer([desiredSkill])
    // workspace currently points at a stale store key for the same installDir
    materializer.activationListing = 'pdf-toolkit\tstale-key\n'

    await materializer.materializeForSprite(input())

    assert.ok(
        materializer.scripts().some((script) => script.includes('tar.gz/rev-2'))
    )
    const link = materializer
        .scripts()
        .find(
            (script) =>
                script.includes('ln -s') && script.includes('pdf-toolkit')
        )
    assert.ok(link)
})

test('per-agent activation: codex copies real dirs (no symlink) into .agents/skills', async () => {
    const materializer = new TestMaterializer([desiredSkill])

    await materializer.materializeForSprite(input('codex'))

    const copy = materializer
        .scripts()
        .find(
            (script) =>
                script.includes('cp -a') &&
                script.includes('/.agents/skills/pdf-toolkit')
        )
    assert.ok(copy)
    // a `.mf-skillkey` marker records which store key the copy came from
    assert.ok(copy.includes('.mf-skillkey'))
    // codex never gets a symlinked skill dir (openai/codex#11314)
    assert.ok(
        !materializer
            .scripts()
            .some(
                (script) =>
                    script.includes('ln -s') &&
                    script.includes('/.agents/skills/pdf-toolkit')
            )
    )
})

test('per-agent activation: gemini symlinks into .agents/skills', async () => {
    const materializer = new TestMaterializer([desiredSkill])

    await materializer.materializeForSprite(input('gemini-cli'))

    const link = materializer
        .scripts()
        .find(
            (script) =>
                script.includes('ln -s') &&
                script.includes('/.agents/skills/pdf-toolkit')
        )
    assert.ok(link)
})

test('migration: removes the legacy ~/.claude/skills clone that would shadow the symlink', async () => {
    const materializer = new TestMaterializer([desiredSkill])

    await materializer.materializeForSprite(input())

    const rmLegacy = materializer
        .scripts()
        .find(
            (script) =>
                script.includes('/home/test/.claude/skills/pdf-toolkit') &&
                script.includes('rm -rf') &&
                script.includes('! -L')
        )
    assert.ok(rmLegacy)
})

test('migration: legacy clone cleanup targets the .agents dir for codex/gemini', async () => {
    const materializer = new TestMaterializer([desiredSkill])

    await materializer.materializeForSprite(input('codex'))

    const rmLegacy = materializer
        .scripts()
        .find(
            (script) =>
                script.includes('/home/test/.agents/skills/pdf-toolkit') &&
                script.includes('rm -rf') &&
                script.includes('! -L')
        )
    assert.ok(rmLegacy)
})

test('daemon: claude routes to host store + workspace symlink over the daemon RPC', async () => {
    const materializer = new TestMaterializer([desiredSkill])

    await materializer.materializeForDaemon(daemonInput())

    const key = skillStoreKey(desiredSkill)
    // same host store, downloaded over the daemon RPC
    assert.ok(
        materializer.daemonScripts.some(
            (s) =>
                s.includes('codeload.github.com') &&
                s.includes('/Users/daemon/.manyfold/skills')
        )
    )
    // symlinked into the agent's managed workspace
    assert.ok(
        materializer.daemonScripts.some(
            (s) =>
                s.includes('ln -s') &&
                s.includes(`/Users/daemon/.manyfold/skills/${key}`) &&
                s.includes(
                    '/Users/daemon/.manyfold/workspaces/agent-1/.claude/skills/pdf-toolkit'
                )
        )
    )
    // legacy cleanup targets the daemon's nca- prefixed home clone
    assert.ok(
        materializer.daemonScripts.some(
            (s) =>
                s.includes('/Users/daemon/.claude/skills/nca-pdf-toolkit') &&
                s.includes('rm -rf')
        )
    )
})

test('daemon: a registration-declared skills dir overrides the homeDir default (ADR-0014)', async () => {
    const declared = '/Users/daemon/.manyfold/profiles/default/skills'
    const materializer = new TestMaterializer(
        [desiredSkill],
        fakeDbWithSkillsDir(declared)
    )

    await materializer.materializeForDaemon(daemonInput())

    const key = skillStoreKey(desiredSkill)
    assert.ok(
        materializer.daemonScripts.some(
            (s) => s.includes('codeload.github.com') && s.includes(declared)
        )
    )
    assert.ok(
        materializer.daemonScripts.some(
            (s) => s.includes('ln -s') && s.includes(`${declared}/${key}`)
        )
    )
    assert.ok(
        materializer.daemonScripts.every(
            (s) => !s.includes('/Users/daemon/.manyfold/skills/')
        )
    )
})

test('daemon: codex copies the store skill into the workspace .agents/skills (no symlink) over the daemon RPC', async () => {
    const materializer = new TestMaterializer([desiredSkill])

    await materializer.materializeForDaemon(daemonInput('codex'))

    const key = skillStoreKey(desiredSkill)
    // same host store, downloaded over the daemon RPC
    assert.ok(
        materializer.daemonScripts.some(
            (s) =>
                s.includes('codeload.github.com') &&
                s.includes('/Users/daemon/.manyfold/skills')
        )
    )
    // codex activation uses real-dir copies (not symlinks) into the agent's
    // managed workspace, with a `.mf-skillkey` marker
    assert.ok(
        materializer.daemonScripts.some(
            (s) =>
                s.includes('cp -a') &&
                s.includes(`/Users/daemon/.manyfold/skills/${key}`) &&
                s.includes(
                    '/Users/daemon/.manyfold/workspaces/agent-1/.agents/skills/pdf-toolkit'
                ) &&
                s.includes('.mf-skillkey')
        )
    )
    assert.ok(
        !materializer.daemonScripts.some(
            (s) =>
                s.includes('ln -s') && s.includes('/.agents/skills/pdf-toolkit')
        )
    )
    // legacy cleanup targets the daemon's nca- prefixed home clone
    assert.ok(
        materializer.daemonScripts.some(
            (s) =>
                s.includes('/Users/daemon/.agents/skills/nca-pdf-toolkit') &&
                s.includes('rm -rf')
        )
    )
})

test('SkillMaterializerService repairs stale sprite download network policy', async () => {
    const materializer = new TestMaterializer([desiredSkill])
    let writtenPolicy:
        | { rules: Array<{ domain: string; action: 'allow' | 'deny' }> }
        | undefined
    const client = {
        getNetworkPolicy: async () => ({
            rules: [
                { domain: '*', action: 'deny' as const },
                { domain: 'github.com', action: 'allow' as const }
            ]
        }),
        setNetworkPolicy: async (
            _name: string,
            policy: {
                rules: Array<{ domain: string; action: 'allow' | 'deny' }>
            }
        ) => {
            writtenPolicy = policy
        }
    } as unknown as SpritesClient

    await materializer.materializeForSprite({
        ...input(),
        client
    })

    assert.ok(
        writtenPolicy?.rules.some(
            (rule) =>
                rule.domain === 'codeload.github.com' && rule.action === 'allow'
        )
    )
})

test('SkillMaterializerService leaves open sprite network policy unchanged', async () => {
    const materializer = new TestMaterializer([desiredSkill])
    let wrotePolicy = false
    const client = {
        getNetworkPolicy: async () => ({ rules: [] }),
        setNetworkPolicy: async () => {
            wrotePolicy = true
        }
    } as unknown as SpritesClient

    await materializer.materializeForSprite({
        ...input(),
        client
    })

    assert.equal(wrotePolicy, false)
})

test('SkillMaterializerService takes the host-store then per-agent lock (two phases)', async () => {
    const events: string[] = []
    const materializer = new TestMaterializer(
        [desiredSkill],
        fakeDbWithLock(events)
    )

    await materializer.materializeForSprite(input())

    // Phase A (store population) under the host-store lock, then Phase B
    // (workspace activation) under the per-agent lock — never nested.
    assert.deepEqual(events, [
        'begin',
        'lock',
        'commit',
        'begin',
        'lock',
        'commit'
    ])
})

test('host store: one skill failing to download does not block its siblings', async () => {
    const sibling: DesiredSkill = {
        ...desiredSkill,
        userSkillId: 'user-skill-2',
        skillId: 'github:anthropics/skills@main:skills/docx',
        installDir: 'docx-toolkit',
        sourcePath: 'skills/docx',
        revision: 'rev-9'
    }
    const materializer = new TestMaterializer([desiredSkill, sibling])
    materializer.failDownloadRevision = 'rev-2' // desiredSkill (pdf) fails

    const outcomes = await materializer.materializeForSprite(input())

    // per-skill: the failing skill is reported failed, the sibling installed —
    // one bad download never aborts its co-desired siblings (#341 ④).
    assert.equal(
        outcomes.find((o) => o.userSkillId === 'user-skill-1')?.status,
        'failed'
    )
    assert.equal(
        outcomes.find((o) => o.userSkillId === 'user-skill-2')?.status,
        'installed'
    )
    // the good skill still gets activated…
    assert.ok(
        materializer
            .scripts()
            .some((s) => s.includes('ln -s') && s.includes('docx-toolkit'))
    )
    // …and the failed one is never activated (its store copy is missing).
    assert.ok(
        !materializer
            .scripts()
            .some((s) => s.includes('ln -s') && s.includes('pdf-toolkit'))
    )
})

test('per-agent activation: verifies the activated skill is loadable', async () => {
    const materializer = new TestMaterializer([desiredSkill])

    await materializer.materializeForSprite(input())

    // AC#4 + dangling-symlink guard ⑦: activation is followed by a test -e on
    // the workspace SKILL.md.
    assert.ok(
        materializer
            .scripts()
            .some(
                (s) =>
                    s.includes('test -e') &&
                    s.includes(
                        '/home/test/.manyfold/workspaces/agent-1/.claude/skills/pdf-toolkit/SKILL.md'
                    )
            )
    )
})

test('SkillMaterializerService materializes k8s Codex skills through home config symlink', async () => {
    const materializer = new TestMaterializer([desiredSkill])

    await materializer.materializeForK8sPod({
        agentId: 'agent-1',
        runtimeId: 'runtime-1',
        userId: 'user-1',
        framework: 'codex',
        exec: {} as PodExec,
        homeDir: '/home/node'
    })

    assert.ok(
        materializer.k8sScripts.some((script) =>
            script.includes("mkdir -p '/home/node/.agents/skills'")
        )
    )
    assert.ok(
        materializer.k8sScripts.some((script) =>
            script.includes(
                'codeload.github.com/anthropics/skills/tar.gz/rev-2'
            )
        )
    )
    assert.equal(
        materializer.k8sWrites[0].absPath,
        '/home/node/.agents/.skill-lock.json'
    )
    const lock = JSON.parse(materializer.k8sWrites[0].body)
    assert.equal(lock.skills['pdf-toolkit'].skillId, desiredSkill.skillId)
    assert.deepEqual(materializer.loadDesiredCalls, ['agent-1'])
})

test('SkillMaterializerService materializes Hermes skills under HERMES_HOME', async () => {
    const materializer = new TestMaterializer([desiredSkill])

    await materializer.materializeForK8sPod({
        agentId: 'agent-1',
        runtimeId: 'runtime-1',
        userId: 'user-1',
        framework: 'hermes',
        exec: {} as PodExec,
        homeDir: '/home/node/.hermes'
    })

    assert.ok(
        materializer.k8sScripts.some((script) =>
            script.includes("mkdir -p '/home/node/.hermes/skills'")
        )
    )
    assert.ok(
        materializer.k8sScripts.some((script) =>
            script.includes("'/home/node/.hermes/skills/pdf-toolkit/SKILL.md'")
        )
    )
    assert.equal(
        materializer.k8sWrites[0].absPath,
        '/home/node/.hermes/.skill-lock.json'
    )
    const lock = JSON.parse(materializer.k8sWrites[0].body)
    assert.equal(lock.skills['pdf-toolkit'].skillId, desiredSkill.skillId)
    assert.deepEqual(materializer.loadDesiredCalls, ['agent-1'])
})

test('SkillMaterializerService materializes named Hermes profile skills under profile home', async () => {
    const materializer = new TestMaterializer([desiredSkill])

    await materializer.materializeForK8sPod({
        agentId: 'agent-profile',
        runtimeId: 'runtime-1',
        userId: 'user-1',
        framework: 'hermes',
        exec: {} as PodExec,
        homeDir: '/home/node/.hermes/profiles/research'
    })

    assert.ok(
        materializer.k8sScripts.some((script) =>
            script.includes(
                "mkdir -p '/home/node/.hermes/profiles/research/skills'"
            )
        )
    )
    assert.equal(
        materializer.k8sWrites[0].absPath,
        '/home/node/.hermes/profiles/research/.skill-lock.json'
    )
    assert.deepEqual(materializer.loadDesiredCalls, ['agent-profile'])
})

test('SkillMaterializerService materializes every Hermes profile for a k8s runtime', async () => {
    const materializer = new TestMaterializer(
        [desiredSkill],
        fakeDbWithAgents([
            { id: 'agent-default', internalId: 'default' },
            { id: 'agent-research', internalId: 'research' }
        ])
    )

    await materializer.materializeK8sRuntimeAgents({
        runtimeId: 'runtime-hermes',
        userId: 'user-1',
        framework: 'hermes',
        exec: {} as PodExec,
        homeDir: '/home/node/.hermes'
    })

    assert.deepEqual(materializer.loadDesiredCalls, [
        'agent-default',
        'agent-research'
    ])
    assert.deepEqual(
        materializer.k8sWrites.map((write) => write.absPath),
        [
            '/home/node/.hermes/.skill-lock.json',
            '/home/node/.hermes/profiles/research/.skill-lock.json'
        ]
    )
})

test('SkillMaterializerService scans Hermes skills with python fallback', async () => {
    const materializer = new TestMaterializer([])
    materializer.k8sExecResult = {
        exitCode: 0,
        stdout: JSON.stringify([
            {
                installDir: 'runtime-skill',
                name: 'Runtime Skill',
                description: 'Created by Hermes',
                sourcePath: 'runtime-skill'
            }
        ]),
        stderr: ''
    }

    const items = await materializer.scanHermesSkillsForTest(
        '/home/node/.hermes',
        3_000
    )

    assert.equal(items.length, 1)
    assert.equal(items[0].installDir, 'runtime-skill')
    assert.equal(items[0].name, 'Runtime Skill')
    assert.match(materializer.k8sScripts[0], /candidate in python3 python/)
    assert.match(
        materializer.k8sScripts[0],
        /\/opt\/hermes\/hermes-agent\/\.venv\/bin\/python/
    )
    assert.match(
        materializer.k8sScripts[0],
        /HERMES_SCAN_SKILLS="\$root" "\$py" - <<'MF_HERMES_SCAN_PY'/
    )
})

class TestMaterializer extends SkillMaterializerService {
    lock: string | null = null
    skillMdExists = false
    activationListing = ''
    daemonScripts: string[] = []
    daemonListing = ''
    execs: ExecOptions[] = []
    rms: Array<{ absPath: string; recursive: boolean }> = []
    writes: Array<{ absPath: string; body: string }> = []
    statPaths: string[] = []
    loadDesiredCalls: string[] = []
    k8sScripts: string[] = []
    k8sWrites: Array<{ absPath: string; body: string }> = []
    k8sExecResult?: { exitCode: number; stdout: string; stderr: string }
    failDownloadRevision?: string

    constructor(
        private readonly desired: DesiredSkill[],
        db: unknown = fakeDbWithLock()
    ) {
        super(db as never, {} as never, {} as never, {} as never, {} as never)
    }

    installScripts(): string[] {
        return this.execs
            .map((exec) => exec.cmd[2] ?? '')
            .filter((script) => script.includes('codeload.github.com'))
    }

    scripts(): string[] {
        return this.execs.map((exec) => exec.cmd[2] ?? '')
    }

    scanHermesSkillsForTest(
        profileHome: string,
        timeoutMs: number
    ): Promise<
        Array<{
            installDir: string
            name: string
            description: string | null
            sourcePath: string
        }>
    > {
        return this.scanHermesSkills({} as PodExec, profileHome, timeoutMs)
    }

    protected override async loadDesired(
        agentId: string
    ): Promise<DesiredSkill[]> {
        this.loadDesiredCalls.push(agentId)
        return this.desired
    }

    protected override async execSprite(
        _client: SpritesClient,
        _spriteName: string,
        opts: ExecOptions
    ): Promise<ExecResult> {
        this.execs.push(opts)
        const script = opts.cmd[2] ?? ''
        // The activation-scan script (`for e in "$dir"/*`) is the only one that
        // reads existing entries; feed it the configured listing.
        if (script.includes('for e in '))
            return { exitCode: 0, stdout: this.activationListing, stderr: '' }
        // Simulate a download failure for a specific revision so per-skill
        // isolation can be exercised.
        if (
            this.failDownloadRevision &&
            script.includes('codeload.github.com') &&
            script.includes(`tar.gz/${this.failDownloadRevision}`)
        )
            return { exitCode: 1, stdout: '', stderr: 'download failed' }
        return { exitCode: 0, stdout: '', stderr: '' }
    }

    protected override async runDaemonBash(
        _daemonId: string,
        bashScript: string,
        _timeoutMs: number
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        this.daemonScripts.push(bashScript)
        // legacy lock probe → absent (66); activation scan → listing; store
        // presence probe (`test -f`) → absent (1) so the skill downloads.
        if (bashScript.includes('|| exit 66; cat'))
            return { exitCode: 66, stdout: '', stderr: '' }
        if (bashScript.includes('for e in '))
            return { exitCode: 0, stdout: this.daemonListing, stderr: '' }
        if (/^test -f /.test(bashScript))
            return { exitCode: 1, stdout: '', stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
    }

    protected override async spriteReadFile(): Promise<SpriteReadFileResult | null> {
        if (!this.lock) return null
        const bytes = Buffer.from(this.lock)
        return {
            stream: (async function* (): AsyncGenerator<Buffer> {
                yield bytes
            })(),
            size: bytes.length,
            contentType: 'application/json',
            done: Promise.resolve()
        }
    }

    protected override async spriteStatFile(
        _client: SpritesClient,
        _spriteName: string,
        absPath: string
    ): Promise<{ size: number; contentType: string } | null> {
        this.statPaths.push(absPath)
        if (absPath.endsWith('/SKILL.md') && this.skillMdExists)
            return { size: 1, contentType: 'text/markdown' }
        return null
    }

    protected override async spriteWriteFile(
        _client: SpritesClient,
        _spriteName: string,
        args: SpriteWriteFileArgs
    ): Promise<void> {
        const chunks: Buffer[] = []
        if (Buffer.isBuffer(args.body)) {
            chunks.push(args.body)
        } else {
            for await (const chunk of args.body) chunks.push(chunk)
        }
        this.writes.push({
            absPath: args.absPath,
            body: Buffer.concat(chunks).toString('utf8')
        })
    }

    protected override async spriteRm(
        _client: SpritesClient,
        _spriteName: string,
        absPath: string,
        opts?: SpriteRmOptions
    ): Promise<void> {
        this.rms.push({ absPath, recursive: !!opts?.recursive })
    }

    protected override async runK8sExec(
        _exec: PodExec,
        opts: { cmd: string[]; timeoutMs: number }
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const script = opts.cmd[2] ?? ''
        this.k8sScripts.push(script)
        if (this.k8sExecResult) return this.k8sExecResult
        if (script.includes('|| exit 66; cat'))
            return { exitCode: 66, stdout: '', stderr: '' }
        if (script.startsWith('test -f '))
            return { exitCode: 1, stdout: '', stderr: '' }
        const write = script.match(
            /printf '%s' '([^']+)' \| base64 -d > '([^']+)'/
        )
        if (write) {
            this.k8sWrites.push({
                absPath: write[2],
                body: Buffer.from(write[1], 'base64').toString('utf8')
            })
        }
        return { exitCode: 0, stdout: '', stderr: '' }
    }
}

const input = (framework: SkillFramework = 'claude-code') => ({
    agentId: 'agent-1',
    runtimeId: 'runtime-1',
    userId: 'user-1',
    framework,
    spriteName: 'sprite-1',
    client: {} as SpritesClient,
    logger: logger(),
    homeDir: '/home/test'
})

const daemonInput = (framework: SkillFramework = 'claude-code') => ({
    agentId: 'agent-1',
    runtimeId: 'runtime-1',
    userId: 'user-1',
    framework,
    daemonId: 'daemon-1',
    homeDir: '/Users/daemon',
    workspacePath: '/Users/daemon/.manyfold/workspaces/agent-1'
})

const fakeDbWithSkillsDir = (skillsDir: string): unknown => ({
    ...(fakeDbWithLock() as Record<string, unknown>),
    select: () => ({
        from: () => ({
            where: () => ({ limit: async () => [{ skillsDir }] })
        })
    })
})

const fakeDbWithAgents = (
    rows: Array<{ id: string; internalId: string }>
): unknown => ({
    ...(fakeDbWithLock() as Record<string, unknown>),
    select: () => ({
        from() {
            return this
        },
        where() {
            return Promise.resolve(rows)
        }
    })
})

const fakeDbWithLock = (events: string[] = []): unknown => ({
    update: () => ({ set: () => ({ where: async () => [] }) }),
    // declaredSkillsDir host lookup — no ADR-0014 declared dir by default, so
    // the daemon store falls back to the homeDir-derived path.
    select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) })
    }),
    transaction: async <T>(
        fn: (tx: {
            execute: (query: unknown) => Promise<unknown[]>
        }) => Promise<T>
    ): Promise<T> => {
        events.push('begin')
        try {
            const result = await fn({
                execute: async () => {
                    events.push('lock')
                    return []
                }
            })
            events.push('commit')
            return result
        } catch (err) {
            events.push('rollback')
            throw err
        }
    }
})

const logger = (): SpritesLogger => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
})
