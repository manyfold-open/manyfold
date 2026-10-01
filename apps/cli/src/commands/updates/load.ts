import kleur from 'kleur'
import type { NcaClient } from '@manyfold/sdk'
import {
    emptyUpdateCenterInputs,
    frameworkDefinition,
    type AgentFramework,
    type UpdateCenterInputs
} from '@manyfold/shared'
import { normalizeCliError } from '@/output'

export type UpdateSource = keyof UpdateCenterInputs

export interface SourceError {
    source: UpdateSource
    code: string
    status?: number
    message: string
}

const SOURCE_LABELS: Record<UpdateSource, string> = {
    daemonHosts: 'computers',
    sandboxes: 'sandboxes',
    podHosts: 'cloud computers',
    runtimes: 'agent runtimes',
    frameworkCatalog: 'framework versions',
    skillGroups: 'installed skills',
    cliVersions: 'mf CLI versions'
}

export const frameworkLabel = (framework: AgentFramework): string =>
    frameworkDefinition(framework)?.displayName ?? framework

export type Settled<T> =
    | { ok: true; value: T }
    | { ok: false; error: unknown }

export const settle = <T>(request: () => Promise<T>): Promise<Settled<T>> =>
    request().then(
        (value): Settled<T> => ({ ok: true, value }),
        (error: unknown): Settled<T> => ({ ok: false, error })
    )

export const sourceError = (
    source: UpdateSource,
    error: unknown
): SourceError => {
    const { code, status, message } = normalizeCliError(error).error
    return { source, code, ...(status !== undefined ? { status } : {}), message }
}

// The same seven lists the web's Update Center joins. A source that fails
// leaves its category empty, as the page does, unless every one failed: then
// nothing loaded and the first failure is the answer.
export const loadUpdateCenter = async (
    client: NcaClient
): Promise<{ inputs: UpdateCenterInputs; errors: SourceError[] }> => {
    const [
        daemonHosts,
        sandboxes,
        podHosts,
        runtimes,
        frameworkCatalog,
        skillGroups,
        cliVersions
    ] = await Promise.all([
        settle(() => client.daemons.listHosts()),
        settle(() => client.sandboxes.list()),
        settle(() => client.podHosts.list()),
        settle(() => client.agentRuntimes.list()),
        settle(() => client.frameworkVersions.list()),
        settle(() => client.skills.installed()),
        settle(() => client.cliVersions.list())
    ])
    const settled = {
        daemonHosts,
        sandboxes,
        podHosts,
        runtimes,
        frameworkCatalog,
        skillGroups,
        cliVersions
    }
    const entries = Object.entries(settled) as Array<
        [UpdateSource, Settled<unknown>]
    >
    const failed = entries.filter(([, result]) => !result.ok)
    if (failed.length === entries.length) {
        const [, first] = failed[0]
        if (!first.ok) throw first.error
    }
    const errors: SourceError[] = []
    const inputs: Record<string, unknown> = { ...emptyUpdateCenterInputs }
    for (const [source, result] of entries)
        if (result.ok) inputs[source] = result.value
        else errors.push(sourceError(source, result.error))
    return { inputs: inputs as unknown as UpdateCenterInputs, errors }
}

export const warnLoadErrors = (errors: SourceError[]): void => {
    for (const error of errors)
        console.error(
            kleur.yellow(
                `warning: ${SOURCE_LABELS[error.source]} did not load: ${error.message}`
            )
        )
}
