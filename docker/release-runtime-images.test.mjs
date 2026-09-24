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
    assert.deepEqual(workflow.jobs.public.needs, ['base', 'manyfold'])
    // The public check covers exactly the images this workflow publishes.
    const packages = workflow.jobs.manyfold.strategy.matrix.include.map(
        (entry) => entry.package
    )
    const publicCheck = workflow.jobs.public.steps.find((step) => step.run).run
    assert.ok(
        publicCheck.includes(
            `for package in ${['base', ...packages].join(' ')};`
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
