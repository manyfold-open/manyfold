import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentRuntimesService } from '../src/modules/agent-runtimes/agent-runtimes.service'

// A sandbox's daemon reports each CLI's `--version` line as printed. The
// runtime column the UI and the Update Center compare against the catalog
// holds only the version in it, the way the local runtime sync writes it.
test('detected versions reach a sandbox runtime as the version, not the line', async () => {
    const written: Array<Record<string, unknown>> = []
    const db = {
        update: () => ({
            set: (values: Record<string, unknown>) => ({
                where: async () => {
                    written.push(values)
                }
            })
        })
    }
    const service = new AgentRuntimesService(db as never, {} as never)

    await service.applyDetectedVersionsToHostRuntimes('sbx_1', [
        { framework: 'claude-code', version: '2.1.251 (Claude Code)' },
        { framework: 'codex', version: 'codex-cli 0.151.0' },
        { framework: 'pi', version: '0.87.1' },
        // nothing to compare: the column keeps what it had
        { framework: 'gemini-cli', version: 'command not found' },
        { framework: 'antigravity-cli', version: null }
    ])

    assert.deepEqual(
        written.map((values) => values.frameworkVersion),
        ['2.1.251', '0.151.0', '0.87.1']
    )
})
