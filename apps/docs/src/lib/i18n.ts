import type { CollectionEntry } from 'astro:content'
import {
    languageOptions as appLanguageOptions,
    type LanguageOption
} from '@manyfold/i18n'

export type Locale = 'en' | 'zh'
type ContentLanguageOption = LanguageOption & { code: Locale }

// Docs ship real content in English and Simplified Chinese only. The other
// app UI languages deliberately get no docs routes: reusing the full app
// language list generated English-fallback pages under /es/... etc. that
// self-canonicalized into the sitemap as duplicate content (#534). Requests
// to those old URLs 301 to the English path via public/_redirects.
const isContentLocale = (value: string): value is Locale =>
    value === 'en' || value === 'zh'

export const languageOptions: readonly ContentLanguageOption[] =
    appLanguageOptions.filter((option): option is ContentLanguageOption =>
        isContentLocale(option.code)
    )

export const defaultLocale: Locale = 'en'
export const locales = languageOptions.map((option) => option.code)
export const nonDefaultLocales = locales.filter(
    (locale) => locale !== defaultLocale
)

const localeMeta = Object.fromEntries(
    languageOptions.map((option) => [option.code, option])
) as Record<Locale, LanguageOption>

export const isLocale = (value: string | undefined): value is Locale =>
    Boolean(value && Object.prototype.hasOwnProperty.call(localeMeta, value))

export const localeOption = (locale: Locale): LanguageOption =>
    localeMeta[locale] ?? localeMeta[defaultLocale]

type UiCopy = {
    brand: string
    brandShort: string
    docs: string
    apiReference: string
    changelog: string
    status: string
    privacy: string
    terms: string
    languageLabel: string
    docsHome: string
    docsTitle: string
    docsDescription: string
    more: string
    homeTitle: string
    homeDescription: string
    homeEyebrow: string
    homeBody: string
    homeCtaDocs: string
    homeCardWorkspaceTitle: string
    homeCardWorkspaceBody: string
    homeCardModelTitle: string
    homeCardModelBody: string
    homeCardChannelsTitle: string
    homeCardChannelsBody: string
    changelogTitle: string
    changelogDescription: string
    changelogLead: string
    statusTitle: string
    statusDescription: string
    statusLead: string
    statusOk: string
    statusComing: string
    defaultDescription: string
    socialImageAlt: string
    searchPlaceholder: string
    searchLabel: string
    searchEmpty: string
    searchHintOpen: string
    consoleLabel: string
    loginLabel: string
    requestAccess: string
    themeToggle: string
    joinDiscord: string
    followX: string
    onThisPage: string
    previous: string
    next: string
    helpfulQuestion: string
    helpfulYes: string
    helpfulNo: string
    helpfulThanks: string
    changelogFilter: string
    changelogNoMatch: string
}

const defaultUi: UiCopy = {
    brand: 'Manyfold',
    brandShort: 'Manyfold',
    docs: 'Guides',
    apiReference: 'API reference',
    changelog: 'Changelog',
    status: 'Status',
    privacy: 'Privacy',
    terms: 'Terms',
    languageLabel: 'Language',
    docsHome: 'Docs home',
    docsTitle: 'Docs',
    docsDescription:
        'Product guides for creating, configuring, and using Manyfold.',
    more: 'More',
    homeTitle: 'Create hosted AI agents with a workspace they can return to.',
    homeDescription:
        'Host AI agents in the cloud - Claude Code, Codex, OpenClaw, Hermes, and more.',
    homeEyebrow: 'Manyfold',
    homeBody:
        'Run Claude Code, Codex, Gemini CLI, OpenClaw, Hermes, and more from one product. Give each agent chat, files, terminal access, model settings, skills, and team channels.',
    homeCtaDocs: 'Read the docs',
    homeCardWorkspaceTitle: 'Agent workspace',
    homeCardWorkspaceBody:
        'Chat, files, terminal sessions, usage, and settings stay tied to the agent so work can resume later.',
    homeCardModelTitle: 'Model choice',
    homeCardModelBody:
        'Connect Anthropic, OpenAI, Google Gemini, OpenRouter, or managed model access per workspace and agent.',
    homeCardChannelsTitle: 'Team channels',
    homeCardChannelsBody:
        'Bring the same agent into Slack, Lark, Feishu, Telegram, Discord, Matrix, or the web workspace.',
    changelogTitle: 'Changelog',
    changelogDescription:
        'Follow Manyfold features, improvements, and fixes across the web app, API, CLI, and agent runtimes.',
    changelogLead: 'Release notes, newest first.',
    statusTitle: 'Status',
    statusDescription: 'Service status for Manyfold.',
    statusLead: 'Operational status of Manyfold services.',
    statusOk: 'All systems operational',
    statusComing: 'A real-time status board is coming.',
    defaultDescription: 'Manyfold - host and run AI agents in the cloud.',
    socialImageAlt: 'Manyfold — AI agent workspace',
    searchPlaceholder: 'Search docs…',
    searchLabel: 'Search documentation',
    searchEmpty: 'No matches found.',
    searchHintOpen: 'Press / or Ctrl K to search',
    consoleLabel: 'Console',
    loginLabel: 'Log in',
    requestAccess: 'Request access',
    themeToggle: 'Toggle theme',
    // "Discord", not "our Discord": the invite opens the NetMind.AI server.
    joinDiscord: 'Join Discord',
    followX: 'Follow on X',
    onThisPage: 'On this page',
    previous: 'Previous',
    next: 'Next',
    helpfulQuestion: 'Was this page helpful?',
    helpfulYes: 'Yes',
    helpfulNo: 'No',
    helpfulThanks: 'Thanks for the feedback!',
    changelogFilter: 'Filter changelog… (e.g. daemon, login, channels)',
    changelogNoMatch: 'No entries match your filter.'
}

const uiOverrides: Partial<Record<Locale, Partial<UiCopy>>> = {
    zh: {
        brand: 'Manyfold',
        brandShort: 'Manyfold',
        docs: '指南',
        apiReference: 'API 参考',
        changelog: '更新日志',
        status: '状态',
        privacy: '隐私',
        terms: '条款',
        languageLabel: '语言',
        joinDiscord: '加入 Discord',
        followX: '在 X 上关注',
        docsHome: '文档首页',
        docsTitle: '文档',
        docsDescription:
            '面向普通用户的产品指南，覆盖创建、配置和使用 Manyfold。',
        more: '更多',
        homeTitle: '创建可持续工作的云端 AI Agent 工作区。',
        homeDescription:
            '在云端托管 AI Agent，包括 Claude Code、Codex、OpenClaw、Hermes 等。',
        homeEyebrow: 'Manyfold',
        homeBody:
            '在一个产品里运行 Claude Code、Codex、Gemini CLI、OpenClaw、Hermes 等 Agent。为每个 Agent 提供聊天、文件、终端、模型设置、技能和团队渠道。',
        homeCtaDocs: '阅读文档',
        homeCardWorkspaceTitle: 'Agent 工作区',
        homeCardWorkspaceBody:
            '聊天、文件、终端会话、用量和设置都绑定到同一个 Agent，方便之后继续工作。',
        homeCardModelTitle: '模型选择',
        homeCardModelBody:
            '按工作区和 Agent 连接 Anthropic、OpenAI、Google Gemini、OpenRouter 或托管模型额度。',
        homeCardChannelsTitle: '团队渠道',
        homeCardChannelsBody:
            '把同一个 Agent 接入 Slack、Lark、飞书、Telegram、Discord、Matrix 或网页工作区。',
        changelogTitle: '更新日志',
        changelogDescription:
            '查看 Manyfold Web、API、CLI 和 Agent runtime 的新功能、改进与修复。',
        changelogLead: '最新版本排在最前。',
        statusTitle: '状态',
        statusDescription: 'Manyfold 服务状态。',
        statusLead: 'Manyfold 服务运行状态。',
        statusOk: '所有系统运行正常',
        statusComing: '实时状态页即将推出。',
        defaultDescription: 'Manyfold - 在云端托管和运行 AI Agent。',
        socialImageAlt: 'Manyfold — AI Agent 工作台',
        searchPlaceholder: '搜索文档…',
        searchLabel: '搜索文档',
        searchEmpty: '没有匹配的结果。',
        searchHintOpen: '按 / 或 Ctrl K 搜索',
        consoleLabel: '控制台',
        loginLabel: '登录',
        requestAccess: '申请使用',
        themeToggle: '切换主题',
        onThisPage: '本页内容',
        previous: '上一篇',
        next: '下一篇',
        helpfulQuestion: '这个页面有帮助吗？',
        helpfulYes: '有帮助',
        helpfulNo: '没帮助',
        helpfulThanks: '感谢你的反馈！',
        changelogFilter: '筛选更新日志…（如 daemon、login、channels）',
        changelogNoMatch: '没有符合筛选条件的记录。'
    }
}

export const getUi = (locale: Locale): UiCopy => ({
    ...defaultUi,
    ...(uiOverrides[locale] ?? {})
})

// Deliberately a total Record over the shipped content locales rather than the
// Partial-override shape above: a missing key here would silently answer a
// Chinese reader in English, which defeats the point of the surface. This way
// it fails `astro check` instead.
type SupportLocale = 'en' | 'zh'

type SupportCopy = {
    supportNavLabel: string
    supportTitle: string
    supportDescription: string
    supportLead: string
    bubbleOpen: string
    bubbleClose: string
    panelTitle: string
    panelSubtitle: string
    greeting: string
    starterQuestions: readonly string[]
    composerPlaceholder: string
    composerLabel: string
    send: string
    stop: string
    newChat: string
    thinking: string
    srAnswering: string
    srAnswerReady: string
    srStopped: string
    stopped: string
    sourcesLabel: string
    sourceUnavailable: string
    feedbackLike: string
    feedbackDislike: string
    errorGeneric: string
    errorOffline: string
    errorUnavailable: string
    retry: string
    jumpToLatest: string
    disclaimer: string
}

const supportCopy: Record<SupportLocale, SupportCopy> = {
    en: {
        supportNavLabel: 'Ask AI',
        supportTitle: 'Ask Manyfold',
        supportDescription:
            'Ask questions about Manyfold and get answers from the docs.',
        supportLead:
            'Ask anything about creating agents, the CLI, channels, or billing. Answers cite the docs pages they came from.',
        bubbleOpen: 'Ask Manyfold',
        bubbleClose: 'Close chat',
        panelTitle: 'Ask Manyfold',
        panelSubtitle: 'Answers from the docs',
        greeting: 'Hi! Ask me anything about Manyfold.',
        starterQuestions: [
            'How do I create my first agent?',
            'How do I install the CLI?',
            'Which team channels are supported?'
        ],
        composerPlaceholder: 'Ask a question…',
        composerLabel: 'Your question',
        send: 'Send',
        stop: 'Stop',
        newChat: 'New chat',
        thinking: 'Thinking…',
        srAnswering: 'Answering your question.',
        srAnswerReady: 'Answer ready.',
        srStopped: 'Answer stopped.',
        stopped: 'Stopped.',
        sourcesLabel: 'Sources',
        sourceUnavailable: 'Not in the published docs',
        feedbackLike: 'Helpful',
        feedbackDislike: 'Not helpful',
        errorGeneric: 'Something went wrong. Please try again.',
        errorOffline: 'You appear to be offline. Check your connection.',
        errorUnavailable: 'The assistant is unavailable right now.',
        retry: 'Retry',
        jumpToLatest: 'Jump to latest',
        disclaimer: 'AI answers can be wrong. Check the linked docs pages.'
    },
    zh: {
        supportNavLabel: 'AI 问答',
        supportTitle: '问 Manyfold',
        supportDescription: '就 Manyfold 提问，从文档中获得答案。',
        supportLead:
            '关于创建 Agent、CLI、渠道或账单的问题都可以问。回答会标注引用的文档页面。',
        bubbleOpen: '问 Manyfold',
        bubbleClose: '关闭对话',
        panelTitle: '问 Manyfold',
        panelSubtitle: '答案来自文档',
        greeting: '你好！关于 Manyfold 的任何问题都可以问我。',
        starterQuestions: [
            '如何创建第一个 Agent？',
            '如何安装 CLI？',
            '支持哪些团队渠道？'
        ],
        composerPlaceholder: '输入你的问题…',
        composerLabel: '你的问题',
        send: '发送',
        stop: '停止',
        newChat: '新对话',
        thinking: '思考中…',
        srAnswering: '正在回答你的问题。',
        srAnswerReady: '回答完成。',
        srStopped: '回答已停止。',
        stopped: '已停止。',
        sourcesLabel: '参考来源',
        sourceUnavailable: '尚未发布到文档',
        feedbackLike: '有帮助',
        feedbackDislike: '没帮助',
        errorGeneric: '出错了，请重试。',
        errorOffline: '你似乎处于离线状态，请检查网络连接。',
        errorUnavailable: '助手当前不可用。',
        retry: '重试',
        jumpToLatest: '回到最新',
        disclaimer: 'AI 的回答可能有误，请对照引用的文档页面核实。'
    }
}

export const getSupportUi = (locale: Locale): SupportCopy =>
    locale === 'zh' ? supportCopy.zh : supportCopy.en

type DocsGroup = { title: string; description: string; ids: string[] }

const defaultDocsGroups: DocsGroup[] = [
    {
        title: 'Start',
        description: 'Understand the product and create your first agent.',
        ids: ['getting-started', 'create-agent']
    },
    {
        title: 'CLI',
        description:
            'Install mf, manage Manyfold from a terminal, and connect self-owned computers.',
        ids: [
            'cli',
            'install',
            'profiles',
            'scripting',
            'cli-agents',
            'cli-runtimes',
            'cli-automations',
            'cli-backups',
            'cli-skills',
            'cli-usage',
            'cli-a2a',
            'cli-reference',
            'local-daemons'
        ]
    },
    {
        title: 'Use',
        description:
            'Connect providers, work in the agent workspace, and review common questions.',
        ids: ['model-providers', 'workspace', 'faq']
    },
    {
        title: 'Self-hosting',
        description:
            'Run the open-source stack on your own infrastructure and operate it.',
        ids: ['self-hosting', 'self-hosting-cli']
    },
    {
        title: 'API',
        description:
            'Call agents through OpenAI-compatible chat and conversation APIs, or the A2A protocol.',
        ids: ['api-chat', 'api-conversations', 'api-a2a']
    },
    {
        title: 'Channels',
        description: 'Connect agents to the tools your team already uses.',
        ids: [
            'channels',
            'channels/telegram',
            'channels/slack',
            'channels/lark',
            'channels/discord',
            'channels/matrix',
            'channels/weixin',
            'channels/linear',
            'channels/github',
            'channels/session-switching'
        ]
    }
]

const docsGroupOverrides: Partial<Record<Locale, DocsGroup[]>> = {
    zh: [
        {
            title: '开始',
            description: '了解产品并创建第一个 Agent。',
            ids: ['getting-started', 'create-agent']
        },
        {
            title: 'CLI',
            description: '安装 mf、通过终端管理 Manyfold，并连接自有计算机。',
            ids: [
                'cli',
                'install',
                'profiles',
                'scripting',
                'cli-agents',
                'cli-runtimes',
                'cli-automations',
                'cli-backups',
                'cli-skills',
                'cli-usage',
                'cli-a2a',
                'cli-reference',
                'local-daemons'
            ]
        },
        {
            title: '使用',
            description: '连接模型提供方、使用 Agent 工作区，并查看常见问题。',
            ids: ['model-providers', 'workspace', 'faq']
        },
        {
            title: '自托管',
            description: '在自己的基础设施上运行并运维开源版。',
            ids: ['self-hosting', 'self-hosting-cli']
        },
        {
            title: 'API',
            description:
                '通过 OpenAI 兼容的 Chat / Conversation API 或 A2A 协议调用 Agent。',
            ids: ['api-chat', 'api-conversations', 'api-a2a']
        },
        {
            title: '渠道',
            description: '把 Agent 接入团队已经在使用的沟通工具。',
            ids: [
                'channels',
                'channels/telegram',
                'channels/slack',
                'channels/lark',
                'channels/discord',
                'channels/matrix',
                'channels/weixin',
                'channels/linear',
                'channels/github',
                'channels/session-switching'
            ]
        }
    ]
}

export const docsGroupsFor = (locale: Locale): DocsGroup[] =>
    docsGroupOverrides[locale] ?? defaultDocsGroups

type DocsEntry = CollectionEntry<'docs'>

export const localePath = (locale: Locale, path: string): string => {
    const normalized = path.startsWith('/') ? path : `/${path}`
    if (locale === defaultLocale) return normalized
    if (normalized === '/') return `/${locale}`
    return `/${locale}${normalized}`
}

export const parseLocalePath = (
    pathname: string
): { locale: Locale; path: string } => {
    const [firstSegment, ...rest] = pathname.split('/').filter(Boolean)
    const hasTrailingSlash = pathname.length > 1 && pathname.endsWith('/')

    if (isLocale(firstSegment) && firstSegment !== defaultLocale) {
        return {
            locale: firstSegment,
            path:
                rest.length > 0
                    ? `/${rest.join('/')}${hasTrailingSlash ? '/' : ''}`
                    : '/'
        }
    }

    return { locale: defaultLocale, path: pathname || '/' }
}

export const alternateLocalePath = (
    pathname: string,
    targetLocale: Locale
): string => {
    const { path } = parseLocalePath(pathname)
    return localePath(targetLocale, path)
}

const localizedContentLocales = new Set<Locale>(['zh'])

export const contentLocaleFor = (locale: Locale): Locale =>
    locale === defaultLocale || localizedContentLocales.has(locale)
        ? locale
        : defaultLocale

export const entryLocale = (entry: DocsEntry): Locale => {
    const [firstSegment] = entry.id.split('/')
    return isLocale(firstSegment) && firstSegment !== defaultLocale
        ? firstSegment
        : defaultLocale
}

export const entrySlug = (entry: DocsEntry): string => {
    const [firstSegment, ...rest] = entry.id.split('/')
    return isLocale(firstSegment) && firstSegment !== defaultLocale
        ? rest.join('/')
        : entry.id
}

export const entryHref = (
    entry: DocsEntry,
    locale: Locale = entryLocale(entry)
): string => localePath(locale, `/docs/${entrySlug(entry)}/`)

export const filterDocsByLocale = (
    entries: DocsEntry[],
    locale: Locale
): DocsEntry[] =>
    entries
        .filter((entry) => entryLocale(entry) === contentLocaleFor(locale))
        .sort((a, b) => a.data.order - b.data.order)

export const groupDocs = (entries: DocsEntry[], locale: Locale) => {
    const bySlug = new Map(entries.map((entry) => [entrySlug(entry), entry]))
    const groups = docsGroupsFor(locale)
    const groupedIds = new Set(groups.flatMap((group) => group.ids))
    const grouped = groups
        .map((group) => ({
            ...group,
            entries: group.ids
                .map((id) => bySlug.get(id))
                .filter((entry): entry is DocsEntry => Boolean(entry))
        }))
        .filter((group) => group.entries.length > 0)
    const remaining = entries.filter(
        (entry) => !groupedIds.has(entrySlug(entry))
    )

    return { grouped, remaining }
}
