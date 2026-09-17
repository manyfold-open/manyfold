import type { Command } from 'commander'
import { buildClient } from '@/client'
import { assertAgentPathStorageContract } from '@/storage-contract'

interface JsonOnlyOptions {
    json?: boolean
}

const emit = (data: unknown, opts: JsonOnlyOptions): void => {
    console.log(JSON.stringify(data, null, 2))
    // Always JSON for diagnostics — too noisy to format manually. `--json`
    // is accepted for parity with other commands but does not change output.
    void opts
}

export const registerAgentDiag = (cmd: Command, program: Command): void => {
    cmd.command('storage-usage <agentId>')
        .description('Report agent-owned path usage, separate from sandbox and account storage')
        .option('--json', 'emit raw JSON (default)', true)
        .action(async (agentId: string, opts: JsonOnlyOptions) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const res = await client.agents.storageUsage(agentId)
            assertAgentPathStorageContract(res)
            emit(res, opts)
        })
}
