import { join } from 'node:path'
import type { CliChannel } from '@/channel'
import { resolveConfigDir } from '@/config'
import { readJsonState, writeProtectedJson } from '@/json-state'

// The update-channel preference must survive a cross-channel `mf update`, which
// swaps the binary's baked channel and therefore its config profile
// (config.json ↔ config.staging.json). So it lives in one profile-independent
// file rather than in the profile-scoped CliConfig.
export const updateChannelPrefPath = (): string =>
    join(resolveConfigDir(), 'update-channel.json')

export const loadUpdateChannelPref = async (): Promise<CliChannel | null> => {
    let parsed: unknown
    try {
        parsed = await readJsonState(updateChannelPrefPath())
    } catch {
        return null
    }
    if (typeof parsed !== 'object' || parsed === null) return null
    const channel = (parsed as { channel?: unknown }).channel
    return channel === 'stable' || channel === 'staging' ? channel : null
}

export const saveUpdateChannelPref = async (
    channel: CliChannel
): Promise<void> => writeProtectedJson(updateChannelPrefPath(), { channel })
