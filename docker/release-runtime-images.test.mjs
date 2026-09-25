import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'

const workflow = parse(
    fs.readFileSync('.github/workflows/release-runtime-images.yml', 'utf8')
)

test('runtime image release publishes every immutable runner dependency', () => {
    assert.equal(workflow.permissions.packages, 'write')
    assert.equal(workflow.env.IMAGE_OWNER, 'manyfold-open')
    assert.equal(workflow.env.MF_CLI_VERSION, '0.34.0')
    assert.deepEqual(
        workflow.jobs.manyfold.strategy.matrix.include,
        [
            ['claude-code', 'claude-code'],
            ['codex', 'codex'],
            ['gemini-cli', 'gemini-cli'],
            ['pi', 'pi'],
            ['openclaw', 'openclaw'],
            ['hermes', 'hermes'],
            ['mf-runner', 'runner']
        ].map(([directory, packageName]) => ({
            directory,
            package: packageName
        }))
    )
    const rendered = JSON.stringify(workflow)
    assert.doesNotMatch(rendered, /:latest/)
    assert.match(rendered, /MF_RUNTIME_BASE=/)
    assert.deepEqual(workflow.jobs.public.needs, ['base', 'manyfold', 'host'])
    // The public check covers exactly the images this workflow publishes.
    const packages = workflow.jobs.manyfold.strategy.matrix.include.map(
        (entry) => entry.package
    )
    const publicCheck = workflow.jobs.public.steps.find((step) => step.run).run
    assert.ok(
        publicCheck.includes(
            `for package in ${['base', 'host', ...packages].join(' ')};`
        )
    )
    for (const directory of workflow.jobs.manyfold.strategy.matrix.include.map(
        (entry) => entry.directory
    )) {
        const dockerfile = fs.readFileSync(
            `docker/${directory}/Dockerfile`,
            'utf8'
        )
        assert.match(
            dockerfile,
            /ARG MF_RUNTIME_BASE=mf-runtime-base:debian-bookworm\nFROM \$\{MF_RUNTIME_BASE\}/
        )
    }
})

// CI here runs with zero repository secrets (SECURITY.md), so the pushes
// authenticate with the workflow's own token, and only this repository runs
// them.
test('runtime image release publishes with the workflow token alone', () => {
    const secrets = JSON.stringify(workflow).match(/secrets\.\w+/g)
    assert.deepEqual([...new Set(secrets)], ['secrets.GITHUB_TOKEN'])
    assert.equal(
        workflow.jobs.base.if,
        "github.repository == 'manyfold-open/manyfold'"
    )
})

// ADR-0035: a pod host's image carries no framework, and nothing it provides
// may live under /home/node, where the host's PVC is mounted over it.
test('the pod host image is generic and keeps its own files out of the home volume', () => {
    const dockerfile = fs.readFileSync('docker/host/Dockerfile', 'utf8')
    const job = workflow.jobs.host
    assert.equal(job.needs, 'base')
    const build = job.steps.find((step) => step.id === 'build').with
    assert.equal(build.context, 'docker/host')
    assert.equal(build.file, 'docker/host/Dockerfile')
    assert.doesNotMatch(
        dockerfile,
        /@anthropic-ai\/claude-code|@openai\/codex|@google\/gemini-cli|pi-coding-agent|openclaw@|hermes-agent/
    )
    assert.match(dockerfile, /MISE_DATA_DIR=\/opt\/mise/)
    assert.match(dockerfile, /MISE_GLOBAL_CONFIG_FILE=\/opt\/mise\//)
    assert.match(dockerfile, /MF_INSTALL_DIR=\/opt\/manyfold\/bin/)
    assert.match(dockerfile, /NPM_CONFIG_PREFIX=\/home\/node\/\.local/)
    assert.match(dockerfile, /PATH="\/home\/node\/\.local\/bin:/)
    assert.match(
        dockerfile,
        /COPY --chmod=755 mf-host-boot\.sh \/usr\/local\/bin\/mf-host-boot/
    )
    assert.match(dockerfile, /CMD \["mf-host-boot"\]/)
    assert.doesNotMatch(dockerfile, /COPY[^\n]*\/home\/node/)
})

test('the pod host image starts with an mf the API accepts', () => {
    const dockerfile = fs.readFileSync('docker/host/Dockerfile', 'utf8')
    const pinned = dockerfile.match(/ARG MF_CLI_VERSION=(\d+)\.(\d+)\.(\d+)\n/)
    assert.ok(pinned, 'MF_CLI_VERSION must pin a stable x.y.z release')
    const floor = fs
        .readFileSync('packages/shared/src/daemon.ts', 'utf8')
        .match(/DAEMON_MIN_CLI_VERSION = '(\d+)\.(\d+)\.(\d+)'/)
    const [a, b] = [pinned.slice(1), floor.slice(1)].map((parts) =>
        parts.map(Number)
    )
    const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
    assert.ok(
        cmp >= 0,
        `mf ${a.join('.')} is below the daemon floor ${b.join('.')}`
    )
})
