import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

// Every RPC to a machine runs under its awake hold (ADR-0038): a sprite
// suspends about a second after its last exec or task, and a daemon RPC is
// neither. HostDaemonAccess is the way to a machine. The files below reach
// the daemon registry directly, each for the reason beside it; any other file
// that does must work through a host session instead.
const ALLOWED: Record<string, string> = {
    'modules/agents/adapters/host-daemon-access.ts':
        'the entry: every session RPC and exec is sent from here',
    'modules/chat/adapters/daemon-exec-driver.ts':
        'the turn path, which holds the machine for the whole turn',
    'modules/chat/adapters/daemon-fenced-dispatch.service.ts':
        'the turn path, which holds the machine for the whole turn',
    'modules/chat/adapters/gateway-http-chat.adapter.ts':
        'the turn path, which holds the machine for the whole turn',
    'modules/chat/adapters/hermes.adapter.ts':
        'the turn path, which holds the machine for the whole turn',
    'modules/chat/adapters/openclaw.adapter.ts':
        'the turn path, which holds the machine for the whole turn',
    'modules/chat/recovery/recovery-fs.ts':
        'turn recovery, under the recovered turn\'s hold',
    'modules/chat/chat.service.ts':
        'turn.permission, answered inside a turn that holds the machine',
    'modules/daemon/daemon-exec-resume.service.ts':
        'turn recovery, under the recovered turn\'s hold',
    'modules/daemon/daemon-fs.ts':
        'config delivery, held by DaemonConfigDeliveryService (holdForDelivery)',
    'modules/daemon/daemon-host.service.ts':
        'daemon.update and herdr.update for self-owned computers, which never sleep',
    'modules/terminal/daemon-terminal.ts':
        'the pty: opened in a session, then held for as long as a tab is attached',
    'modules/agent-runtimes/auth/runtime-auth-profiles.service.ts':
        'auth profile calls, under the auth flow\'s own hold on the machine',
    'modules/agents/files/files-context.ts':
        'the daemon file path, which serves self-owned computers only today',
    'modules/backups/workspace-runtime.service.ts':
        'the daemon backup path, which serves self-owned computers only today',
    'modules/skills/skill-materializer.service.ts':
        'the daemon skill path, which serves self-owned computers only today'
}

const SRC = join(__dirname, '../src')

const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return sources(path)
        return path.endsWith('.ts') ? [path] : []
    })

// Files holding a DaemonRegistryService that call its rpc or streamRpc.
const directCallers = (): Set<string> => {
    const found = new Set<string>()
    for (const path of sources(SRC)) {
        const text = readFileSync(path, 'utf8')
        if (!text.includes('DaemonRegistryService')) continue
        const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
        const visit = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                ['rpc', 'streamRpc'].includes(node.expression.name.text) &&
                /(^|\.)(registry|daemonRegistry)$/.test(
                    node.expression.expression.getText(file)
                )
            )
                found.add(relative(SRC, path).split('\\').join('/'))
            ts.forEachChild(node, visit)
        }
        visit(file)
    }
    return found
}

test('only the allowed files send daemon RPCs outside a host session', () => {
    const callers = directCallers()
    assert.deepEqual(
        [...callers].filter((path) => !(path in ALLOWED)).sort(),
        [],
        'work on a machine through HostDaemonAccess.withHost instead'
    )
    assert.deepEqual(
        Object.keys(ALLOWED).filter((path) => !callers.has(path)).sort(),
        [],
        'an allowed file no longer calls the registry: drop its entry'
    )
})
