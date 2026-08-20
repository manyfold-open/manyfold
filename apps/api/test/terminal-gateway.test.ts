import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import {
    defaultTerminalCwd,
    TerminalGateway
} from '../src/modules/terminal/terminal.gateway'

const baseAgent = {
    id: 'agent-1',
    mountPath: '/workspace'
}

type ResolveCwd = (
    agent: typeof baseAgent,
    rootId?: string,
    rawPath?: string
) => Promise<string | undefined>

const makeGateway = (
    statType: 'dir' | 'file' | null
): { resolveCwd: ResolveCwd; rootIdCalls: string[]; statCalls: string[] } => {
    const rootIdCalls: string[] = []
    const statCalls: string[] = []
    const files = {
        build: async (_agent: unknown, rootId?: string) => {
            rootIdCalls.push(rootId ?? '')
            return {
                mountPath: '/home/sprite/.codex',
                stat: async (path: string) => {
                    statCalls.push(path)
                    if (!statType) return null
                    return {
                        entry: {
                            name: path.split('/').at(-1) ?? 'codex',
                            type: statType,
                            size: 0,
                            mtime: 1,
                            mode: '755'
                        },
                        contentType: 'inode/directory'
                    }
                }
            }
        }
    }
    const gateway = new TerminalGateway(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        files as never
    )
    return {
        resolveCwd: (
            gateway as unknown as { resolveCwd: ResolveCwd }
        ).resolveCwd.bind(gateway),
        rootIdCalls,
        statCalls
    }
}

test('TerminalGateway resolveCwd accepts directories in the selected root', async () => {
    const harness = makeGateway('dir')

    const cwd = await harness.resolveCwd(
        baseAgent,
        'codex-home',
        '/home/sprite/.codex/sessions'
    )

    assert.equal(cwd, '/home/sprite/.codex/sessions')
    assert.deepEqual(harness.rootIdCalls, ['codex-home'])
    assert.deepEqual(harness.statCalls, ['/home/sprite/.codex/sessions'])
})

test('TerminalGateway resolveCwd rejects non-directories', async () => {
    const harness = makeGateway('file')

    await assert.rejects(
        () =>
            harness.resolveCwd(
                baseAgent,
                'codex-home',
                '/home/sprite/.codex/config.toml'
            ),
        BadRequestException
    )
})

test('TerminalGateway resolveCwd rejects missing paths', async () => {
    const harness = makeGateway(null)

    await assert.rejects(
        () =>
            harness.resolveCwd(
                baseAgent,
                'codex-home',
                '/home/sprite/.codex/missing'
            ),
        BadRequestException
    )
})

test('TerminalGateway resolveCwd rejects paths outside the selected root', async () => {
    const harness = makeGateway('dir')

    await assert.rejects(
        () =>
            harness.resolveCwd(baseAgent, 'codex-home', '/home/sprite/.claude'),
        ForbiddenException
    )
})

test('defaultTerminalCwd uses NarraNexus home root instead of lazy workspace', () => {
    const cwd = defaultTerminalCwd({
        ...baseAgent,
        framework: 'narranexus',
        runtime: 'sprites',
        workspacePath:
            '/home/sprite/.narranexus/data/workspaces/agt_1_mf_user_1',
        mountPath:
            '/home/sprite/.narranexus/data/workspaces/agt_1_mf_user_1',
        fileRoots: [
            {
                id: 'workspace',
                label: 'Workspace',
                path: '/home/sprite/.narranexus/data/workspaces/agt_1_mf_user_1',
                writable: true
            },
            {
                id: 'home',
                label: 'Home',
                path: '/home/sprite/.narranexus',
                writable: true
            }
        ]
    } as never)

    assert.equal(cwd, '/home/sprite/.narranexus')
})

test('defaultTerminalCwd falls back to NarraNexus data dir for old rows', () => {
    const cwd = defaultTerminalCwd({
        ...baseAgent,
        framework: 'narranexus',
        runtime: 'sprites',
        workspacePath:
            '/home/sprite/.narranexus/data/workspaces/agt_1_mf_user_1',
        mountPath:
            '/home/sprite/.narranexus/data/workspaces/agt_1_mf_user_1',
        fileRoots: []
    } as never)

    assert.equal(cwd, '/home/sprite/.narranexus/data')
})
