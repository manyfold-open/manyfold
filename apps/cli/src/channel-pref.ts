import { join } from 'node:path'
import type { CliChannel } from '@/channel'
import { resolveConfigDir } from '@/config'
import { readJsonState, writeProtectedJson } from '@/json-state'

// The update-channel preference must survive a cross-channel `mf update`, which
// swaps the binary's baked channel and therefore its config profile. So it
// lives in one profile-independent file rather than in the profile-scoped
// CliConfig.
export const updateChannelPrefPath = (): string =>
    join(resolveConfigDir(), 'update-channel.json')

// Binaries before the dev rename persisted {"channel":"staging"} for what is
// now `dev`. Coerced on read so a user who opted into pre-release builds stays
// opted in. Not rewritten eagerly: load runs on the daemon startup path and on
// read-only filesystems; the next `mf update --channel` rewrites it.
const coerceChannel = (value: unknown): CliChannel | null => {
    if (value === 'stable') return 'stable'
    if (value === 'dev' || value === 'staging') return 'dev'
    return null
}

export const loadUpdateChannelPref = async (): Promise<CliChannel | null> => {
    let parsed: unknown
    try {
        parsed = await readJsonState(updateChannelPrefPath())
    } catch {
        return null
    }
    if (typeof parsed !== 'object' || parsed === null) return null
    return coerceChannel((parsed as { channel?: unknown }).channel)
}

export const saveUpdateChannelPref = async (
    channel: CliChannel
): Promise<void> => writeProtectedJson(updateChannelPrefPath(), { channel })
