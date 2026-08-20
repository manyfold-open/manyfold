import { CommanderError, type Command } from 'commander'
import { resolveAccountScopeDenial } from '@/client'
import { buildProgram } from '@/program'
import {
    argvWantsJson,
    normalizeCliError,
    renderCliError,
    type CliErrorExtra
} from '@/output'
import { cleanupStaleUpdateArtifact } from '@/self-update'

const denialExtra = (
    denial: Awaited<ReturnType<typeof resolveAccountScopeDenial>>
): CliErrorExtra | undefined => {
    if (!denial) return undefined
    return {
        scopes: denial.scopes,
        ...(denial.consentUrl
            ? {
                  consentUrl: denial.consentUrl,
                  hint: `Grant the requested account scopes at ${denial.consentUrl}`
              }
            : {
                  hint: `Run mf auth ensure --scopes ${denial.scopes.join(',')}`
              })
    }
}

export const handleTopLevelError = async (
    program: Command,
    error: unknown,
    json: boolean
): Promise<number> => {
    const message = error instanceof Error ? error.message : String(error)
    const denial = await resolveAccountScopeDenial(
        message,
        program.opts<{
            account?: boolean
            agentId?: string
            apiUrl?: string
            token?: string
        }>()
    )
    const exitCode = renderCliError(
        { json, humanPrefix: 'cli Error: ' },
        error,
        denialExtra(denial)
    )
    process.exitCode = exitCode
    return exitCode
}

const configureCommander = (program: Command, json: boolean): void => {
    const configure = (command: Command): void => {
        command.exitOverride()
        if (json) command.configureOutput({ writeErr: () => {} })
        for (const child of command.commands) configure(child)
    }
    configure(program)
}

const isSuccessfulCommanderExit = (error: unknown): boolean =>
    error instanceof CommanderError && error.exitCode === 0

export const runCli = async (argv: string[] = process.argv): Promise<void> => {
    await cleanupStaleUpdateArtifact()
    const program = buildProgram()
    const json = argvWantsJson(argv)
    configureCommander(program, json)
    try {
        await program.parseAsync(argv)
    } catch (error) {
        if (isSuccessfulCommanderExit(error)) return
        if (!json && error instanceof CommanderError) {
            // Commander already wrote its usage error to stderr; only the
            // exit code needs the stable classification (usage = 5).
            process.exitCode = normalizeCliError(error).exitCode
            return
        }
        await handleTopLevelError(program, error, json)
    }
}
