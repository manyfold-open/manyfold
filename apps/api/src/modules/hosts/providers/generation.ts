import type {
    RuntimeHostPowerState,
    RuntimeHostProviderRef,
    RuntimeHostRow
} from '@manyfold/db'
import type { HostsService } from '../hosts.service'
import { StaleGenerationError } from './sandbox-provider'

// The fence every mutating adapter call runs under: the host's generation is
// re-read at the call, and a caller holding an older one is refused. Nothing
// is locked — two callers under the SAME generation both proceed, which is
// what idempotent create/bootstrap/destroy are for.
export const assertCurrentGeneration = async (
    hosts: Pick<HostsService, 'findById'>,
    host: Pick<RuntimeHostRow, 'id'>,
    generation: number
): Promise<RuntimeHostRow> => {
    const current = await hosts.findById(host.id)
    if (!current) throw new Error(`host ${host.id} not found`)
    if (generation < current.generation)
        throw new StaleGenerationError(host.id, generation, current.generation)
    return current
}

// provider_ref is the adapter's: only the adapter for the host's provider
// kind reads or writes it, and the core never interprets it. A patch merges
// into whatever the row holds now, so two adapter observations (a power poll
// writing podPhase, a create writing the ids) cannot erase each other.
export const patchProviderRef = async <T extends RuntimeHostProviderRef>(
    hosts: Pick<HostsService, 'findById' | 'setProviderRef'>,
    hostId: string,
    patch: Partial<T>
): Promise<void> => {
    const current = await hosts.findById(hostId)
    if (!current?.providerRef) return
    await hosts.setProviderRef(hostId, {
        ...current.providerRef,
        ...patch
    } as RuntimeHostProviderRef)
}

// A provider power observation on the host: powerChangedAt only moves when
// the state actually changes, so it reads as "since when".
export const recordPower = async (
    hosts: Pick<HostsService, 'findById' | 'patch'>,
    hostId: string,
    state: RuntimeHostPowerState
): Promise<RuntimeHostRow | null> => {
    const current = await hosts.findById(hostId)
    if (!current) return null
    if (current.powerState === state) return current
    return hosts.patch(hostId, { powerState: state, powerChangedAt: new Date() })
}
