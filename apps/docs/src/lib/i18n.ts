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
    challenge: string
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
    copyPage: string
    copied: string
    headingLink: string
    openNav: string
    closeNav: string
    overview: string
    newerRelease: string
    olderRelease: string
    morePageActions: string
    viewAsMarkdown: string
    openInChatGpt: string
    openInClaude: string
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
    docs: 'Documentation',
    apiReference: 'API reference',
    // Footer only, and pointed at the app: the series keeps one permanent
    // address across editions, so the landing footer links it campaign or no
    // campaign and this one follows.
    challenge: 'Agent Challenge',
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
    // The third column's heading, and the only one now: the inline "Table of
    // contents" the API landing used to carry is the same list, and shipping
    // both meant one site naming the same object two ways.
    onThisPage: 'On this page',
    copyPage: 'Copy page',
    copied: 'Copied',
    headingLink: 'Copy link to this section',
    openNav: 'Open documentation navigation',
    closeNav: 'Close documentation navigation',
    overview: 'Overview',
    newerRelease: 'Newer release',
    olderRelease: 'Older release',
    morePageActions: 'More page actions',
    viewAsMarkdown: 'View as Markdown',
    openInChatGpt: 'Open in ChatGPT',
    openInClaude: 'Open in Claude',
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
        docs: '文档',
        apiReference: 'API 参考',
        challenge: 'Agent 挑战赛',
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
        copyPage: '复制页面',
        copied: '已复制',
        headingLink: '复制本节链接',
        openNav: '打开文档导航',
        closeNav: '关闭文档导航',
        overview: '概览',
        newerRelease: '更新的版本',
        olderRelease: '更旧的版本',
        morePageActions: '更多页面操作',
        viewAsMarkdown: '查看 Markdown',
        openInChatGpt: '在 ChatGPT 中打开',
            openInClaude: '在 Claude 中打开',
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

// A sidebar entry is one of three things, so the literals below can be read
// straight down as the tree the reader sees:
//
//   'getting-started'        a page in the docs collection, by slug
//   { title, ids: [...] }    a nested tier of collection pages
//   { title, file }          a build artifact that is not a page at all
//
// Only one level of nesting exists on purpose. Replicate goes three tiers deep
// (Guides > Run models > leaf) because its tree is large enough to need it;
// this one is not, and a third tier would cost a reader a click per page for
// nothing. Nesting is used only where the content already has that shape, so
// most groups stay flat.
//
// The file nodes are the machine-readable surface the build already ships and
// the UI never mentioned: llms.txt, llms-full.txt, the changelog feed. Their
// hrefs are written out per locale rather than run through localePath(),
// because they are not uniformly localized: llms.txt has a /zh twin and the
// changelog feed does not. A literal href cannot drift away from the route
// that actually answers.
type DocsSubgroup = { title: string; ids: string[] }
type DocsFile = { title: string; file: string }
type DocsNode = string | DocsSubgroup | DocsFile
type DocsGroup = { title: string; description: string; ids: DocsNode[] }

const isDocsFile = (node: DocsNode): node is DocsFile =>
    typeof node !== 'string' && 'file' in node

const isDocsSubgroup = (node: DocsNode): node is DocsSubgroup =>
    typeof node !== 'string' && 'ids' in node

// Every collection slug a group owns, at any depth. Nesting is a presentation
// concern; membership is not, so everything that asks "which group is this
// page in" goes through here rather than reading group.ids directly.
const groupSlugs = (group: DocsGroup): string[] =>
    group.ids.flatMap((node) =>
        typeof node === 'string'
            ? [node]
            : isDocsSubgroup(node)
              ? node.ids
              : []
    )

// Four sections, named for what a reader is doing: Start, Build, Connect, and
// then Reference for the things they look up rather than read.
//
// It was nine sections before, four of which held one or two pages, so the rail
// was 42 rows and a reader scanned nine labels to learn what the docs covered.
// The sections are verbs now and the old groups became the tier below them,
// which is the shape replicate.com/docs uses: four sections, the depth one
// level down, and a Reference that holds the HTTP API and the OpenAPI schema
// while every webhook how-to sits under Topics.
//
// Reference means generated or canonical, not "API-shaped". The endpoint pages
// come from a typed structure, the command reference from `mf --help`, and the
// three machine-readable files from the build, so that section is the part of
// the site nobody hand-writes. The API guides stay in Connect with the channel
// guides, because they answer the same question: how do I wire something
// external to an agent.
//
// Three tiers is the limit the renderer draws, so the old 'Supported channels'
// and 'Task guides' labels are gone: their parents are the collapsing unit now.
const defaultDocsGroups: DocsGroup[] = [
    {
        title: 'Start',
        description:
            'Understand the product, install mf, and create your first agent.',
        ids: ['getting-started', 'install', 'create-agent']
    },
    {
        title: 'Build',
        description:
            'Give an agent a workspace, a model and somewhere to run, then drive it from the terminal.',
        ids: [
            {
                title: 'Agents',
                ids: ['workspace', 'profiles', 'model-providers']
            },
            {
                title: 'Runtimes',
                ids: ['local-daemons', 'self-hosting', 'self-hosting-cli']
            },
            {
                title: 'CLI',
                ids: [
                    'cli',
                    'scripting',
                    'cli/agents',
                    'cli/runtimes',
                    'cli/automations',
                    'cli/backups',
                    'cli/skills',
                    'cli/usage',
                    'cli/a2a'
                ]
            }
        ]
    },
    {
        title: 'Connect',
        description:
            'Wire an agent to the tools your team already uses, and to your own applications.',
        ids: [
            {
                title: 'Channels',
                ids: [
                    'channels',
                    'channels/telegram',
                    'channels/slack',
                    'channels/lark',
                    'channels/discord',
                    'channels/matrix',
                    'channels/weixin',
                    'channels/line',
                    'channels/whatsapp',
                    'channels/linear',
                    'channels/github',
                    'channels/session-switching',
                    'channels/agent-send'
                ]
            },
            {
                title: 'API',
                ids: ['api-chat', 'api-conversations', 'api-a2a']
            }
        ]
    },
    {
        title: 'Reference',
        description:
            'Look up the exact shape of the API and the CLI, plus the machine-readable versions of these docs.',
        ids: [
            {
                title: 'CLI commands',
                ids: [
                    'cli/reference',
                    'cli/reference/auth',
                    'cli/reference/setup',
                    'cli/reference/login',
                    'cli/reference/whoami',
                    'cli/reference/agent',
                    'cli/reference/automations',
                    'cli/reference/backups',
                    'cli/reference/channels',
                    'cli/reference/files',
                    'cli/reference/connections',
                    'cli/reference/model-config',
                    'cli/reference/runtime',
                    'cli/reference/skills',
                    'cli/reference/usage',
                    'cli/reference/a2a',
                    'cli/reference/daemon',
                    'cli/reference/profile',
                    'cli/reference/update',
                    'cli/reference/version',
                    'cli/reference/help'
                ]
            },
            'faq',
            { title: 'llms.txt', file: '/llms.txt' },
            { title: 'llms-full.txt', file: '/llms-full.txt' },
            { title: 'Changelog feed', file: '/changelog/feed.xml' }
        ]
    }
]

const docsGroupOverrides: Partial<Record<Locale, DocsGroup[]>> = {
    zh: [
        {
            title: '开始',
            description: '了解产品、安装 mf，并创建第一个 Agent。',
            ids: ['getting-started', 'install', 'create-agent']
        },
        {
            title: '构建',
            description: '给 Agent 配置 workspace、模型和运行位置，然后用终端驱动它。',
            ids: [
                {
                    title: 'Agent',
                    ids: ['workspace', 'profiles', 'model-providers']
                },
                {
                    title: 'Runtime',
                    ids: ['local-daemons', 'self-hosting', 'self-hosting-cli']
                },
                {
                    title: 'CLI',
                    ids: [
                        'cli',
                        'scripting',
                        'cli/agents',
                        'cli/runtimes',
                        'cli/automations',
                        'cli/backups',
                        'cli/skills',
                        'cli/usage',
                        'cli/a2a'
                    ]
                }
            ]
        },
        {
            title: '连接',
            description: '把 Agent 接入团队已经在使用的工具，以及你自己的应用。',
            ids: [
                {
                    title: '渠道',
                    ids: [
                        'channels',
                        'channels/telegram',
                        'channels/slack',
                        'channels/lark',
                        'channels/discord',
                        'channels/matrix',
                        'channels/weixin',
                        'channels/line',
                        'channels/whatsapp',
                        'channels/linear',
                        'channels/github',
                        'channels/session-switching',
                        'channels/agent-send'
                    ]
                },
                {
                    title: 'API',
                    ids: ['api-chat', 'api-conversations', 'api-a2a']
                }
            ]
        },
        {
            title: '参考',
            description: '查阅 API 与 CLI 的确切形状，以及这份文档的机器可读版本。',
            ids: [
                {
                    title: 'CLI 命令',
                    ids: [
                        'cli/reference',
                        'cli/reference/auth',
                        'cli/reference/setup',
                        'cli/reference/login',
                        'cli/reference/whoami',
                        'cli/reference/agent',
                        'cli/reference/automations',
                        'cli/reference/backups',
                        'cli/reference/channels',
                        'cli/reference/files',
                        'cli/reference/connections',
                        'cli/reference/model-config',
                        'cli/reference/runtime',
                        'cli/reference/skills',
                        'cli/reference/usage',
                        'cli/reference/a2a',
                        'cli/reference/daemon',
                        'cli/reference/profile',
                        'cli/reference/update',
                        'cli/reference/version',
                        'cli/reference/help'
                    ]
                },
                'faq',
                { title: 'llms.txt', file: '/zh/llms.txt' },
                { title: 'llms-full.txt', file: '/zh/llms-full.txt' },
                { title: '更新日志 RSS', file: '/changelog/feed.xml' }
            ]
        }
    ]
}

export const docsGroupsFor = (locale: Locale): DocsGroup[] =>
    docsGroupOverrides[locale] ?? defaultDocsGroups

// The sidebar group a doc belongs to, in that locale's wording. Used as the
// eyebrow line on a page's generated OG card, so a link shared into Slack says
// which part of the docs it came from before the title is even read. Returns
// undefined for a doc in no group, which the caller labels generically rather
// than guessing.
// A collection id carries the locale directory for non-default locales, so a
// Chinese page is `zh/cli-agents` while every group in docsGroupOverrides.zh
// lists the bare `cli-agents`. Comparing ids directly matched nothing for all
// 33 Chinese pages: no eyebrow rendered on any of them, and every Chinese OG
// card fell back to the literal word "Documentation". Both this and entrySlug
// need the same stripping, and keeping two copies of it is what let them
// drift, so they share one.
const bareSlug = (id: string): string => {
    const [firstSegment, ...rest] = id.split('/')
    return isLocale(firstSegment) && firstSegment !== defaultLocale
        ? rest.join('/')
        : id
}

export const groupTitleFor = (
    entry: { id: string },
    locale: Locale
): string | undefined =>
    docsGroupsFor(locale).find((group) =>
        groupSlugs(group).includes(bareSlug(entry.id))
    )?.title

// A locale-independent anchor for a group, so /docs/#agents is the same target
// on the English and the Chinese dashboard and a breadcrumb can point at it.
// A group has no page of its own, and an intermediate BreadcrumbList item
// without a URL is the kind of thing Google quietly drops the whole trail
// over, so the middle crumb needs somewhere real to go: the dashboard's
// grouped index, at that group's heading.
//
// The key comes from the default-locale wording, found by shared membership
// rather than by position in the array. The two arrays are in the same order
// today, and if that ever slips, position would hand back a confidently wrong
// anchor while membership hands back none.
//
// Prefixed, because the bare keys collide: the dashboard already publishes
// <h2 id="runtimes"> for its runtime cards, and a section named Runtimes would
// have taken the same id on the same page.
const asciiKey = (prefix: string, title: string): string =>
    `${prefix}-${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')}`

export const groupKeyForTitle = (
    title: string,
    locale: Locale
): string | undefined => {
    const group = docsGroupsFor(locale).find((g) => g.title === title)
    if (!group) return undefined
    const slugs = new Set(groupSlugs(group))
    const canonical = defaultDocsGroups.find((g) =>
        groupSlugs(g).some((slug) => slugs.has(slug))
    )
    return canonical ? asciiKey('group', canonical.title) : undefined
}

// The tier between a section and a page: Channels inside Connect, CLI inside
// Build. The breadcrumb carries it because without it a channel page's trail
// reads `Guides / Connect / Telegram` and loses the word that says what kind of
// thing Telegram is here. Same membership lookup as the section key, so the
// anchor is the same on both locales' dashboards.
export const subgroupFor = (
    entry: { id: string },
    locale: Locale
): { title: string; anchor: string } | undefined => {
    const slug = bareSlug(entry.id)
    const localised = docsGroupsFor(locale)
        .flatMap((group) => group.ids)
        .find((node) => isDocsSubgroup(node) && node.ids.includes(slug))
    if (!localised || !isDocsSubgroup(localised)) return undefined
    const canonical = defaultDocsGroups
        .flatMap((group) => group.ids)
        .find((node) => isDocsSubgroup(node) && node.ids.includes(slug))
    if (!canonical || !isDocsSubgroup(canonical)) return undefined
    return {
        title: localised.title,
        anchor: asciiKey('subgroup', canonical.title)
    }
}

// The same anchor, reached from a rendered subgroup rather than from a page,
// for the dashboard's grouped index.
export const subgroupAnchorForTitle = (
    title: string,
    locale: Locale
): string | undefined => {
    const localised = docsGroupsFor(locale)
        .flatMap((group) => group.ids)
        .find((node) => isDocsSubgroup(node) && node.title === title)
    if (!localised || !isDocsSubgroup(localised)) return undefined
    const first = localised.ids[0]
    const canonical = defaultDocsGroups
        .flatMap((group) => group.ids)
        .find((node) => isDocsSubgroup(node) && node.ids.includes(first))
    return canonical && isDocsSubgroup(canonical)
        ? asciiKey('subgroup', canonical.title)
        : undefined
}

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

export const entrySlug = (entry: DocsEntry): string => bareSlug(entry.id)

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

// What the sidebar renders, one node per visible row. `entries` on a group
// stays the flat depth-first list every other consumer already expects
// (llms.txt, llms-full.txt), so nesting is additive: it changes the shape of
// the nav and nothing else.
export type DocsNavNode =
    | { kind: 'entry'; entry: DocsEntry }
    | { kind: 'subgroup'; title: string; entries: DocsEntry[] }
    | { kind: 'file'; title: string; href: string }
    // A page that is not a collection entry: the API reference and its
    // endpoints, which are generated from a typed structure rather than from
    // markdown. Same-tab, unlike 'file', which is a raw artifact that opens in
    // a new tab with an outbound arrow.
    | {
          kind: 'page'
          title: string
          href: string
          nested: boolean
          // Whether the rows nested under this one are its children, so it
          // stays marked while a reader is on one of them. Opt-in, not inferred
          // from the path: /docs/ is a prefix of every documentation URL, and
          // inferring it there marked the Overview row on every page.
          ancestor?: boolean
          // An endpoint's method pill. Optional because the reference landing
          // is a page without a method.
          badge?: { label: string; className: string }
      }

export const groupDocs = (entries: DocsEntry[], locale: Locale) => {
    const bySlug = new Map(entries.map((entry) => [entrySlug(entry), entry]))
    const groups = docsGroupsFor(locale)
    const groupedIds = new Set(groups.flatMap(groupSlugs))
    const lookup = (ids: string[]): DocsEntry[] =>
        ids
            .map((id) => bySlug.get(id))
            .filter((entry): entry is DocsEntry => Boolean(entry))

    const grouped = groups
        .map((group) => {
            const nodes = group.ids.flatMap((node): DocsNavNode[] => {
                if (typeof node === 'string') {
                    const entry = bySlug.get(node)
                    return entry ? [{ kind: 'entry', entry }] : []
                }
                if (isDocsFile(node)) {
                    return [
                        { kind: 'file', title: node.title, href: node.file }
                    ]
                }
                const children = lookup(node.ids)
                return children.length > 0
                    ? [{ kind: 'subgroup', title: node.title, entries: children }]
                    : []
            })

            return {
                title: group.title,
                description: group.description,
                nodes,
                entries: nodes.flatMap((node) =>
                    node.kind === 'entry'
                        ? [node.entry]
                        : node.kind === 'subgroup'
                          ? node.entries
                          : []
                )
            }
        })
        .filter((group) => group.nodes.length > 0)

    const remaining = entries.filter(
        (entry) => !groupedIds.has(entrySlug(entry))
    )

    return { grouped, remaining }
}
