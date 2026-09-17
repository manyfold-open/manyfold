import * as headless from '@xterm/headless'
import * as serialize from '@xterm/addon-serialize'

// Both packages ship a CommonJS bundle with no exports map, so under Node's
// ESM loader their classes only exist on `default`; a bundler that takes
// the ESM build puts them on the namespace instead. Look in both places.
const pick = <T>(ns: object, name: string): T => {
    const record = ns as Record<string, unknown>
    const fallback = record.default as Record<string, unknown> | undefined
    return (record[name] ?? fallback?.[name]) as T
}

export const Terminal = pick<typeof headless.Terminal>(headless, 'Terminal')
export const SerializeAddon = pick<typeof serialize.SerializeAddon>(
    serialize,
    'SerializeAddon'
)
export type HeadlessTerminal = headless.Terminal
export type HeadlessSerializeAddon = serialize.SerializeAddon
