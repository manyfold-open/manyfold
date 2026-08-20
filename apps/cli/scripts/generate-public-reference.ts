#!/usr/bin/env -S node --import tsx
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Argument, Command, Option } from 'commander'
import { buildProgram } from '../src/program'

const here = dirname(fileURLToPath(import.meta.url))
const docsDir = resolve(here, '../../docs/src/content/docs')
const packageVersion = (
    JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')) as {
        version: string
    }
).version
const referenceVersion = packageVersion

interface ReferenceCopy {
    frontmatterTitle: string
    frontmatterDescription: string
    title: string
    lead: string
    generated: string
    installedHelp: string
    globalOptions: string
    usage: string
    arguments: string
    options: string
    subcommands: string
    command: string
    aliases: string
    argument: string
    purpose: string
    required: string
    defaultValue: string
}

const copy: Record<'en' | 'zh', ReferenceCopy> = {
    en: {
        frontmatterTitle: 'CLI command reference',
        frontmatterDescription:
            'Search the complete mf command tree, arguments, and options.',
        title: 'CLI command reference',
        lead: 'This page is generated from the same Commander tree as the mf binary. It documents the current public command surface; the installed binary remains authoritative for its own version.',
        generated: 'Generated from',
        installedHelp:
            'Run `mf <command> --help` to confirm syntax for the version installed on your machine.',
        globalOptions: 'Global options',
        usage: 'Usage',
        arguments: 'Arguments',
        options: 'Options',
        subcommands: 'Subcommands',
        command: 'Command',
        aliases: 'Aliases',
        argument: 'Argument',
        purpose: 'Purpose',
        required: 'Required.',
        defaultValue: 'Default'
    },
    zh: {
        frontmatterTitle: 'CLI 命令参考',
        frontmatterDescription:
            '搜索完整的 mf command tree、argument 和 option。',
        title: 'CLI 命令参考',
        lead: '本页由 mf binary 使用的同一份 Commander tree 生成，记录当前公开 command surface；command 和 option description 保留 binary 中的英文原文以避免漂移。已安装 binary 的自身版本始终是最终依据。',
        generated: '生成自',
        installedHelp:
            '运行 `mf <command> --help`，确认当前机器已安装版本的准确语法。',
        globalOptions: 'Global option',
        usage: '用法',
        arguments: 'Argument',
        options: 'Option',
        subcommands: 'Subcommand',
        command: '命令',
        aliases: 'Alias',
        argument: '参数',
        purpose: '用途',
        required: '必填。',
        defaultValue: '默认值'
    }
}

const escapeTable = (value: string): string =>
    value.replaceAll('|', '\\|').replaceAll('\n', ' ')

const commandParts = (command: Command): string[] => {
    const parts: string[] = []
    let current: Command | null = command
    while (current?.parent) {
        parts.unshift(current.name())
        current = current.parent
    }
    return parts
}

const commandPath = (command: Command): string =>
    ['mf', ...commandParts(command)].join(' ')

const commandAnchor = (command: Command): string =>
    commandPath(command).replaceAll(' ', '-')

const argumentTerm = (argument: Argument): string => {
    const suffix = argument.variadic ? '...' : ''
    return argument.required
        ? `<${argument.name()}${suffix}>`
        : `[${argument.name()}${suffix}]`
}

const visibleCommands = (command: Command): Command[] => {
    if (command.parent === null) return [...command.commands]
    const visible = new Set(command.createHelp().visibleCommands(command))
    return command.commands.filter((child) => visible.has(child))
}

const visibleOptions = (command: Command): Option[] =>
    command.createHelp().visibleOptions(command)

const usage = (command: Command): string => {
    const hasOptions = visibleOptions(command).some(
        (option) => option.long !== '--help'
    )
    const args = command.registeredArguments.map(argumentTerm)
    const child = visibleCommands(command).length > 0 ? ['[command]'] : []
    return [
        commandPath(command),
        ...(hasOptions ? ['[options]'] : []),
        ...args,
        ...child
    ].join(' ')
}

const optionDescription = (option: Option, labels: ReferenceCopy): string => {
    const parts = [option.description]
    if (option.mandatory) parts.push(labels.required)
    if (
        option.defaultValue !== undefined &&
        option.defaultValue !== false &&
        option.defaultValue !== true
    )
        parts.push(
            `${labels.defaultValue}: \`${String(option.defaultValue)}\`.`
        )
    return parts.filter(Boolean).join(' ')
}

const renderArguments = (command: Command, labels: ReferenceCopy): string[] => {
    if (command.registeredArguments.length === 0) return []
    return [
        `**${labels.arguments}**`,
        '',
        `| ${labels.argument} | ${labels.purpose} |`,
        '| --- | --- |',
        ...command.registeredArguments.map(
            (argument) =>
                `| \`${escapeTable(argumentTerm(argument))}\` | ${escapeTable(argument.description || '')} |`
        ),
        ''
    ]
}

const renderOptions = (command: Command, labels: ReferenceCopy): string[] => {
    const options = visibleOptions(command)
    if (options.length === 0) return []
    return [
        `**${labels.options}**`,
        '',
        `| ${labels.options} | ${labels.purpose} |`,
        '| --- | --- |',
        ...options.map(
            (option) =>
                `| \`${escapeTable(option.flags)}\` | ${escapeTable(optionDescription(option, labels))} |`
        ),
        ''
    ]
}

const renderSubcommands = (
    command: Command,
    labels: ReferenceCopy
): string[] => {
    const children = visibleCommands(command)
    if (children.length === 0) return []
    return [
        `**${labels.subcommands}**`,
        '',
        `| ${labels.command} | ${labels.purpose} |`,
        '| --- | --- |',
        ...children.map(
            (child) =>
                `| [\`${escapeTable(commandPath(child))}\`](#${commandAnchor(child)}) | ${escapeTable(child.description())} |`
        ),
        ''
    ]
}

const renderCommand = (command: Command, labels: ReferenceCopy): string[] => {
    const depth = commandParts(command).length
    const heading = '#'.repeat(Math.min(6, depth + 1))
    const aliases = command.aliases()
    const lines = [
        `<a id="${commandAnchor(command)}"></a>`,
        `${heading} \`${commandPath(command)}\``,
        '',
        command.description(),
        '',
        `**${labels.usage}:** \`${usage(command)}\``,
        ''
    ]
    if (aliases.length > 0)
        lines.push(
            `**${labels.aliases}:** ${aliases.map((alias) => `\`${alias}\``).join(', ')}`,
            ''
        )
    lines.push(
        ...renderArguments(command, labels),
        ...renderOptions(command, labels),
        ...renderSubcommands(command, labels)
    )
    for (const child of visibleCommands(command))
        lines.push(...renderCommand(child, labels))
    return lines
}

export const renderPublicReference = (locale: 'en' | 'zh'): string => {
    const labels = copy[locale]
    const program = buildProgram()
    const lines = [
        '---',
        `title: ${labels.frontmatterTitle}`,
        `description: ${labels.frontmatterDescription}`,
        'order: 12',
        '---',
        '',
        `# ${labels.title}`,
        '',
        labels.lead,
        '',
        `**${labels.generated}:** \`mf ${referenceVersion}\``,
        '',
        labels.installedHelp,
        '',
        `## ${labels.globalOptions}`,
        '',
        `**${labels.usage}:** \`mf [options] [command]\``,
        '',
        ...renderOptions(program, labels)
    ]
    for (const command of visibleCommands(program))
        lines.push(...renderCommand(command, labels))
    return `${lines.join('\n').trim()}\n`
}

export const publicReferencePaths = {
    en: resolve(docsDir, 'cli-reference.md'),
    zh: resolve(docsDir, 'zh/cli-reference.md')
} as const

export const writePublicReferences = (): void => {
    writeFileSync(publicReferencePaths.en, renderPublicReference('en'), 'utf8')
    writeFileSync(publicReferencePaths.zh, renderPublicReference('zh'), 'utf8')
}

const isMain =
    process.argv[1] !== undefined &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
    writePublicReferences()
    const enLines = readFileSync(publicReferencePaths.en, 'utf8').split(
        '\n'
    ).length
    console.log(
        `public-reference: ✓ mf ${referenceVersion} (${enLines} lines per locale)`
    )
}
