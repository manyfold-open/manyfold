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
    assert.equal(workflow.env.NARRANEXUS_REF, 'v1.15.0')
    assert.equal(
        workflow.env.NARRANEXUS_SHA,
        '5869502c9a405b3e762206ecd21ea16540d75794'
    )
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
    assert.ok(workflow.jobs.public.needs.includes('manyfold'))
    assert.ok(workflow.jobs.public.needs.includes('narranexus'))
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
