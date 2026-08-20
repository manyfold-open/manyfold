import { SLASH_COMMAND_NAMES } from './commands'

export interface ParsedSlashCommand {
    command: string
    args: string[]
    rest: string
}

const SLASH_RE = /^\s*\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i

export const KNOWN_COMMANDS = SLASH_COMMAND_NAMES

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
    if (typeof text !== 'string') return null
    const match = SLASH_RE.exec(text)
    if (!match) return null
    const command = match[1].toLowerCase()
    const rest = (match[2] ?? '').trim()
    const args = rest.length > 0 ? rest.split(/\s+/) : []
    return { command, args, rest }
}

export function isKnownSlashCommand(command: string): boolean {
    return KNOWN_COMMANDS.has(command.toLowerCase())
}
