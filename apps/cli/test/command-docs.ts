import type { Command, Option } from 'commander'

export interface DocumentedInvocation {
    line: number
    source: string
    argv: string[]
}

const shellWords = (source: string): string[] =>
    source.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) ?? []

const invocationFromLine = (
    source: string,
    line: number
): DocumentedInvocation | undefined => {
    const withoutComment = source.replace(/\s+#.*$/, '').trim()
    const match = /\bmf(?:\.exe)?\s+(.+)$/.exec(withoutComment)
    if (!match) return undefined
    const command = match[1]
        .replace(/\s+\d*>{1,2}\s*.*$/, '')
        .replace(/\s+(?:&&|\|\||[|;])\s*.*$/, '')
        .replace(/\)\s*["']?;?\s*(?:then)?\s*$/, '')
        .trim()
    if (!command) return undefined
    return {
        line,
        source: withoutComment,
        argv: shellWords(command)
    }
}

export const markdownInvocations = (
    markdown: string
): DocumentedInvocation[] => {
    const invocations: DocumentedInvocation[] = []
    let inShellFence = false
    let pendingLine: number | undefined
    let pendingParts: string[] = []

    for (const [index, source] of markdown.split('\n').entries()) {
        const line = index + 1
        if (/^```(?:sh|bash|shell)\s*$/.test(source.trim())) {
            inShellFence = true
            continue
        }
        if (source.trim() === '```') {
            inShellFence = false
            pendingLine = undefined
            pendingParts = []
            continue
        }
        if (!inShellFence || source.trimStart().startsWith('#')) continue

        const trimmed = source.trim()
        if (!trimmed && pendingLine === undefined) continue
        if (pendingLine === undefined) pendingLine = line

        const continued = trimmed.endsWith('\\')
        pendingParts.push(continued ? trimmed.slice(0, -1).trimEnd() : trimmed)
        if (continued) continue

        const invocation = invocationFromLine(
            pendingParts.join(' '),
            pendingLine
        )
        if (invocation) invocations.push(invocation)
        pendingLine = undefined
        pendingParts = []
    }
    return invocations
}

const matchingOption = (
    command: Command,
    token: string
): Option | undefined => {
    for (
        let current: Command | null = command;
        current;
        current = current.parent
    ) {
        const options = [
            ...current.options,
            ...current.createHelp().visibleOptions(current)
        ]
        const option = options.find(
            (candidate) =>
                candidate.short === token ||
                candidate.long === token ||
                (candidate.long !== undefined &&
                    token.startsWith(`${candidate.long}=`))
        )
        if (option) return option
    }
    return undefined
}

export const validateCommandPath = (program: Command, argv: string[]): void => {
    let current = program
    let index = 0
    let positionalIndex = 0
    const usedOptions = new Set<Option>()
    while (index < argv.length) {
        const token = argv[index]
        if (token.startsWith('-')) {
            const option = matchingOption(current, token)
            if (!option) throw new Error(`unknown option '${token}'`)
            usedOptions.add(option)
            if (!token.includes('=') && option.required) {
                if (index + 1 >= argv.length)
                    throw new Error(`missing value for option '${token}'`)
                index += 2
            } else if (
                !token.includes('=') &&
                option.optional &&
                index + 1 < argv.length &&
                !argv[index + 1].startsWith('-')
            ) {
                index += 2
            } else {
                index += 1
            }
            continue
        }

        const child = current.commands.find(
            (command) =>
                command.name() === token || command.aliases().includes(token)
        )
        if (child) {
            current = child
            positionalIndex = 0
            index += 1
            continue
        }

        const registeredArguments = current.registeredArguments
        const lastArgument = registeredArguments.at(-1)
        const argument =
            registeredArguments[positionalIndex] ??
            (lastArgument?.variadic ? lastArgument : undefined)
        if (argument) {
            positionalIndex += 1
            index += 1
            continue
        }
        if (current.commands.length > 0)
            throw new Error(
                `unknown subcommand '${token}' under '${current.name()}'`
            )
        throw new Error(
            `unexpected argument '${token}' for '${current.name()}'`
        )
    }

    if ([...usedOptions].some((option) => option.long === '--help')) return

    const missingArgument = current.registeredArguments
        .slice(positionalIndex)
        .find((argument) => argument.required)
    if (missingArgument)
        throw new Error(`missing required argument '${missingArgument.name()}'`)

    for (
        let command: Command | null = current;
        command;
        command = command.parent
    ) {
        const missingOption = command.options.find(
            (option) => option.mandatory && !usedOptions.has(option)
        )
        if (missingOption)
            throw new Error(`missing required option '${missingOption.flags}'`)
    }
}
