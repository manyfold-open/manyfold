import 'tsconfig-paths/register'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Agent } from '@manyfold/db'
import {
    buildMeasureScript,
    parseMeasureOutput,
    type MeasureTarget
} from '@/modules/agents/sprite-storage/sprite-storage.service'

const docker = process.env.STORAGE_SCRIPT_DOCKER === '1'
test(
    'generated Linux measurement script resolves actual paths and keeps nested/alias attribution conservative',
    { skip: process.platform !== 'linux' && !docker, timeout: 20_000 },
    async (t) => {
        const root = await mkdtemp(
            path.join(tmpdir(), 'manyfold-storage-script-')
        )
        t.after(() => rm(root, { recursive: true, force: true }))
        const child = path.join(root, 'foo', "config 'quoted'\nline\n")
        const grandchild = path.join(child, 'nested')
        const other = path.join(root, 'foobar')
        for (const directory of [grandchild, other])
            await mkdir(directory, { recursive: true })
        await writeFile(path.join(root, 'foo', 'workspace'), Buffer.alloc(1000))
        await writeFile(path.join(child, 'config'), Buffer.alloc(2000))
        await writeFile(
            path.join(grandchild, 'nested-config'),
            Buffer.alloc(3000)
        )
        await writeFile(path.join(other, 'other-workspace'), Buffer.alloc(4000))
        const target: MeasureTarget = {
            host: {} as never,
            hostAgents: [
                { id: 'agent-a', workspacePath: path.join(root, 'foo') },
                { id: 'agent-b', workspacePath: other }
            ] as Agent[],
            homes: [
                {
                    framework: 'openclaw',
                    homeDir: child,
                    agentIds: ['agent-a']
                },
                {
                    framework: 'hermes',
                    homeDir: grandchild,
                    agentIds: ['agent-a']
                },
                {
                    framework: 'codex',
                    homeDir: `~/foo/${path.basename(child)}/`,
                    agentIds: ['agent-a']
                }
            ]
        }
        const run = (script: string) => {
            const result = docker
                ? spawnSync(
                      'docker',
                      [
                          'run',
                          '--rm',
                          '--network',
                          'none',
                          '--label',
                          'manyfold.task=1282-script',
                          '--mount',
                          `type=bind,src=${root},dst=${root}`,
                          '-e',
                          `HOME=${root}`,
                          'node:24-bookworm-slim',
                          'bash',
                          '-c',
                          script
                      ],
                      { encoding: 'utf8', timeout: 10_000 }
                  )
                : spawnSync('bash', ['-c', script], {
                      env: { PATH: process.env.PATH, HOME: root },
                      encoding: 'utf8',
                      timeout: 10_000
                  })
            assert.ifError(result.error)
            assert.equal(result.status, 0, result.stderr)
            return result.stdout
        }
        const output = run(buildMeasureScript(target))
        const result = parseMeasureOutput(target, output)
        assert.equal(result.measuredVia, 'df')
        assert.equal(
            result.attributionComplete,
            true,
            JSON.stringify({ result, output })
        )
        assert.equal(result.homes[0].path, child)
        assert.equal(
            result.homes[2].path,
            child,
            'tilde and trailing slash resolve from actual HOME'
        )
        const [workspace, separate] = result.workspaces
        const [config, nested, alias] = result.homes
        assert.equal(workspace.attributedBytes, workspace.bytes - config.bytes)
        assert.equal(nested.attributedBytes, nested.bytes)
        assert.equal(
            (config.attributedBytes ?? 0) + (alias.attributedBytes ?? 0),
            config.bytes - nested.bytes
        )
        assert.equal(
            separate.attributedBytes,
            separate.bytes,
            '/foo does not contain /foobar'
        )
        assert.equal(
            [...result.workspaces, ...result.homes].reduce(
                (sum, entry) => sum + entry.attributedBytes!,
                0
            ),
            workspace.bytes + separate.bytes
        )

        const link = path.join(root, 'config-link')
        await symlink(child, link)
        const incomplete = {
            ...target,
            homes: [
                ...target.homes,
                { framework: 'codex', homeDir: link },
                { framework: 'hermes', homeDir: path.join(root, 'missing') }
            ]
        }
        const partial = parseMeasureOutput(
            incomplete,
            run(buildMeasureScript(incomplete))
        )
        assert.equal(
            partial.measuredVia,
            'df',
            'failed du never fabricates zero or invalidates an authoritative rootfs reading'
        )
        assert.equal(partial.attributionComplete, false)
        assert.equal(
            partial.homes.find((home) => home.path === link)?.attributedBytes,
            null,
            'du does not dereference a final symlink, so it cannot claim target bytes'
        )
        assert.equal(
            partial.homes.some((home) => home.path?.endsWith('/missing')),
            false
        )
    }
)
