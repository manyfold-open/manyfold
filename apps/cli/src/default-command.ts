import type { Command } from 'commander'
import { UsageError } from '@/usage-error'

// A group's default subcommand is handed every word that names no sibling, so
// a mistyped subcommand ran the default instead of failing.
export const refuseStrayWords = (command: Command): void => {
    const [word] = command.args
    if (word === undefined) return
    const group = command.parent
    const names = group?.commands.map((sibling) => sibling.name()) ?? []
    const known =
        names.length > 1
            ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
            : names.join('')
    throw new UsageError(
        `unknown command '${word}': mf ${group?.name()} has ${known}`
    )
}
