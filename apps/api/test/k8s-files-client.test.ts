import { K8S_HOME_BASE } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent, FileRoot } from '@manyfold/db'

// k8s-files-client now defers to the K8S_INGRESS_SCHEME env (default 'https'
// in prod). Tests assume the legacy 'http' baseline.
process.env.K8S_INGRESS_SCHEME = 'http'

import {
    k8sDufsPathMappingForRoot,
    k8sListDir,
    k8sReadFile,
    k8sWriteFile,
    type K8sFilesTarget
} from '../src/modules/agents/files/k8s-files-client'

const agentId = 'agent-1'
const workspacePath = `${K8S_HOME_BASE}/.nca/workspaces/${agentId}`

const agentFor = (framework: Agent['framework']): Agent =>
    ({
        id: agentId,
        framework,
        mountPath: workspacePath
    }) as Agent

const codexAgent = agentFor('codex')

const root = (id: string, path: string): FileRoot => ({
    id,
    label: id,
    path,
    writable: true
})

const targetFor = (agent: Agent, fileRoot: FileRoot): K8sFilesTarget => ({
    runtimeId: 'runtime-1',
    primaryAgentId: agentId,
    ingressHost: 'agent-files.local',
    pathMapping: k8sDufsPathMappingForRoot(agent, fileRoot)
})

const withFetch = async (
    fetchImpl: typeof fetch,
    fn: () => Promise<void>
): Promise<void> => {
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
        await fn()
    } finally {
        globalThis.fetch = original
    }
}

const davFile = (size: number): string =>
    [
        '<D:multistatus>',
        '<D:response>',
        '<D:propstat>',
        '<D:prop>',
        `<D:getcontentlength>${size}</D:getcontentlength>`,
        '<D:getlastmodified>Tue, 28 Apr 2026 10:00:00 GMT</D:getlastmodified>',
        '</D:prop>',
        '</D:propstat>',
        '</D:response>',
        '</D:multistatus>'
    ].join('')

test('k8s DUFS mapping keeps display roots separate from served PVC paths', () => {
    const newWorkspacePath = `${K8S_HOME_BASE}/.manyfold/workspaces/${agentId}`
    const newPathAgent = {
        ...agentFor('codex'),
        workspacePath: newWorkspacePath,
        mountPath: newWorkspacePath
    } as Agent
    const cases: Array<[Agent, FileRoot, string]> = [
        // pre-rename agent whose stored workspace lives under ~/.nca
        [
            agentFor('codex'),
            root('workspace', workspacePath),
            `/workspaces/${agentId}`
        ],
        [
            newPathAgent,
            root('workspace', newWorkspacePath),
            `/workspaces/${agentId}`
        ],
        [
            agentFor('claude-code'),
            root('claude-home', `${K8S_HOME_BASE}/.claude`),
            '/state/claude'
        ],
        [
            agentFor('codex'),
            root('codex-home', `${K8S_HOME_BASE}/.codex`),
            '/state/codex'
        ],
        [
            agentFor('gemini-cli'),
            root('gemini-home', `${K8S_HOME_BASE}/.gemini`),
            '/state/gemini'
        ]
    ]

    for (const [agent, fileRoot, dufsPath] of cases) {
        assert.deepEqual(k8sDufsPathMappingForRoot(agent, fileRoot), {
            displayPath: fileRoot.path,
            dufsPath
        })
    }
})

test('k8s list maps workspace root under DUFS PVC root', async () => {
    const calls: Array<{ method: string; url: string }> = []
    await withFetch(
        (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({
                method: init?.method ?? 'GET',
                url: String(input)
            })
            return new Response(
                JSON.stringify({
                    href: '',
                    kind: 'Index',
                    paths: [
                        {
                            path_type: 'File',
                            name: 'notes.md',
                            mtime: 1_000,
                            size: 5
                        }
                    ]
                }),
                { status: 200 }
            )
        }) as typeof fetch,
        async () => {
            const entries = await k8sListDir(
                codexAgent,
                targetFor(codexAgent, root('workspace', workspacePath)),
                workspacePath
            )

            assert.deepEqual(calls, [
                {
                    method: 'GET',
                    url: `http://agent-files.local/api/agents/${agentId}/files/workspaces/${agentId}?json`
                }
            ])
            assert.equal(entries[0]?.name, 'notes.md')
        }
    )
})

test('k8s read maps claude home display path to PVC state', async () => {
    const calls: Array<{ method: string; url: string }> = []
    const filePath = `${K8S_HOME_BASE}/.claude/projects/session.jsonl`
    await withFetch(
        (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({
                method: init?.method ?? 'GET',
                url: String(input)
            })
            if (init?.method === 'PROPFIND')
                return new Response(davFile(4), { status: 200 })
            return new Response('pong', { status: 200 })
        }) as typeof fetch,
        async () => {
            const result = await k8sReadFile(
                targetFor(
                    agentFor('claude-code'),
                    root('claude-home', `${K8S_HOME_BASE}/.claude`)
                ),
                filePath
            )

            assert.equal(result?.size, 4)
            assert.deepEqual(calls, [
                {
                    method: 'PROPFIND',
                    url: `http://agent-files.local/api/agents/${agentId}/files/state/claude/projects/session.jsonl`
                },
                {
                    method: 'GET',
                    url: `http://agent-files.local/api/agents/${agentId}/files/state/claude/projects/session.jsonl`
                }
            ])
        }
    )
})

test('k8s write maps codex home display path to PVC state', async () => {
    const calls: Array<{ method: string; url: string }> = []
    await withFetch(
        (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({
                method: init?.method ?? 'GET',
                url: String(input)
            })
            return new Response('', { status: 201 })
        }) as typeof fetch,
        async () => {
            await k8sWriteFile(
                targetFor(
                    codexAgent,
                    root('codex-home', `${K8S_HOME_BASE}/.codex`)
                ),
                `${K8S_HOME_BASE}/.codex/config.toml`,
                Buffer.from('model = "gpt-5.4"')
            )

            // written to a sibling temp path and MOVEd into place so a failed
            // upload cannot clobber the existing config
            assert.deepEqual(calls, [
                {
                    method: 'PUT',
                    url: `http://agent-files.local/api/agents/${agentId}/files/state/codex/config.toml.mf-part`
                },
                {
                    method: 'MOVE',
                    url: `http://agent-files.local/api/agents/${agentId}/files/state/codex/config.toml.mf-part`
                }
            ])
        }
    )
})

test('k8s list maps gemini home display path to PVC state', async () => {
    const calls: Array<{ method: string; url: string }> = []
    await withFetch(
        (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({
                method: init?.method ?? 'GET',
                url: String(input)
            })
            return new Response(
                JSON.stringify({ href: '', kind: 'Index', paths: [] }),
                { status: 200 }
            )
        }) as typeof fetch,
        async () => {
            await k8sListDir(
                agentFor('gemini-cli'),
                targetFor(
                    agentFor('gemini-cli'),
                    root('gemini-home', `${K8S_HOME_BASE}/.gemini`)
                ),
                `${K8S_HOME_BASE}/.gemini`
            )

            assert.deepEqual(calls, [
                {
                    method: 'GET',
                    url: `http://agent-files.local/api/agents/${agentId}/files/state/gemini?json`
                }
            ])
        }
    )
})
