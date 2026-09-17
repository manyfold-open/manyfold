import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse, stringify } from 'yaml'

const root = path.resolve(__dirname, '../../..')
type Step = { uses?: string; run?: string; with?: Record<string, string> }

test('required and ownership jobs select the exact test runtime and probe before installation', () => {
    assert.match(
        fs.readFileSync(path.join(root, '.node-test-version'), 'utf8').trim(),
        /^24\.\d+\.\d+$/
    )
    for (const file of ['ci.yml', 'daemon-lifecycle.yml']) {
        const workflow = parse(
            fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8')
        )
        const jobs = workflow.jobs as Record<string, { steps: Step[] }>
        let selected = 0
        for (const job of Object.values(jobs)) {
            for (const [index, step] of job.steps.entries()) {
                if (!step.uses?.startsWith('actions/setup-node@')) continue
                selected++
                assert.equal(
                    step.with?.['node-version-file'],
                    '.node-test-version'
                )
                assert.equal(step.with?.['node-version'], undefined)
                assert.equal(
                    job.steps[index + 1]?.run,
                    'node scripts/check-test-runtime.mjs'
                )
            }
        }
        assert.ok(selected > 0, `${file} lost the runtime selection`)
        if (file === 'daemon-lifecycle.yml')
            for (const event of ['push', 'pull_request'])
                for (const input of [
                    '.node-test-version',
                    'scripts/check-test-runtime.mjs'
                ])
                    assert.ok(workflow.on[event].paths.includes(input))
    }
})

test('a test-runtime-only commit selects every workspace and changes build cache signatures', (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'test-runtime-inputs-'))
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
    const write = (file: string, value: string | object) => {
        const target = path.join(cwd, file)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(
            target,
            typeof value === 'string' ? value : JSON.stringify(value)
        )
    }
    const git = (...args: string[]) =>
        execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: 'pipe'
        }).trim()
    const config = JSON.parse(
        fs.readFileSync(path.join(root, 'turbo.json'), 'utf8')
    )
    const manifest = JSON.parse(
        fs.readFileSync(path.join(root, 'package.json'), 'utf8')
    )
    write('package.json', {
        name: 'runtime-fixture',
        private: true,
        packageManager: manifest.packageManager
    })
    write('pnpm-workspace.yaml', stringify({ packages: ['packages/*'] }))
    write(
        'pnpm-lock.yaml',
        stringify({
            lockfileVersion: '9.0',
            importers: { '.': {}, 'packages/one': {}, 'packages/two': {} }
        })
    )
    write('turbo.json', config)
    write('.github/workflows/ci.yml', 'fixture workflow')
    write('.node-test-version', '24.20.0\n')
    write('scripts/check-test-runtime.mjs', 'fixture probe')
    write('.gitignore', '.turbo\n.cache\n')
    for (const name of ['one', 'two'])
        write(`packages/${name}/package.json`, {
            name: `@fixture/${name}`,
            scripts: { build: 'node --version' }
        })
    git('init', '-qb', 'main')
    git('config', 'user.name', 'Runtime fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    git('config', 'core.hooksPath', '/dev/null')
    git('add', '.')
    git('commit', '-qm', 'initial inputs')
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: cwd,
        CI: 'true',
        TURBO_TELEMETRY_DISABLED: '1',
        TURBO_CACHE_DIR: path.join(cwd, '.cache'),
        TURBO_SCM_BASE: git('rev-parse', 'HEAD'),
        TURBO_SCM_HEAD: 'HEAD'
    }
    delete env.NODE_TEST_CONTEXT
    const turbo = (...args: string[]) =>
        JSON.parse(
            execFileSync(path.join(root, 'node_modules/.bin/turbo'), args, {
                cwd,
                env,
                encoding: 'utf8',
                timeout: 30_000,
                killSignal: 'SIGKILL'
            })
        )
    assert.equal(
        turbo('ls', '--affected', '--output=json').packages.items.length,
        0
    )
    const hash = () =>
        turbo('run', 'build', '--filter=@fixture/one', '--dry=json').tasks[0]
            .hash
    const before = hash()
    write('.node-test-version', '24.20.1\n')
    git('commit', '-qam', 'test runtime only')
    assert.deepEqual(
        turbo('ls', '--affected', '--output=json')
            .packages.items.map((item: { name: string }) => item.name)
            .sort(),
        ['@fixture/one', '@fixture/two']
    )
    assert.notEqual(hash(), before)
})
