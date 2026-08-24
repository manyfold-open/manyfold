import type { Locale } from '@/lib/i18n'

// Copy for the docs dashboard at /docs/ and /zh/docs/. It lives here rather
// than in i18n.ts because it is one page's worth of prose, and because the
// UiCopy record is already large enough that a landing page's worth of
// headings, cards and steps would drown the shared UI strings in it.
//
// The runtime cards and the section headings are signed off verbatim
// (docs-artifacts/spec-docs-dashboard.md). The ordered steps are not free
// copy either: every line restates what getting-started.md says under
// "First setup", plus the CLI line that page ends on, so the dashboard and
// the guide cannot describe two different first runs.

type RuntimeCard = {
    badge: string
    title: string
    body: string
    pick: string
}

type Step = {
    title: string
    body: string
    // Locale-less docs path; the page runs it through localePath().
    href: string
}

export type DashboardCopy = {
    title: string
    description: string
    heading: string
    deck: string
    ctaPrimary: string
    ctaSecondary: string
    runtimeHeading: string
    runtimeIntro: string
    runtimeMore: string
    runtimes: readonly RuntimeCard[]
    stepsHeading: string
    stepsIntro: string
    steps: readonly Step[]
    indexHeading: string
    indexIntro: string
    machineHeading: string
    machineIntro: string
    // Keyed by the file node's href with any locale prefix stripped, so the
    // notes attach to the same Reference entries the sidebar renders instead
    // of restating that list.
    machineNotes: Readonly<Record<string, string>>
    markdownTwinLabel: string
    markdownTwinNote: string
}

const en: DashboardCopy = {
    title: 'Documentation',
    description:
        'Run, connect, and orchestrate AI agents. Start with a hosted agent in a sandbox, or register your own computer and let an agent work in your repository.',
    heading: 'Manyfold documentation',
    deck: 'Run, connect, and orchestrate AI agents. Start with a hosted agent in a sandbox, or register your own computer and let an agent work in your repository.',
    ctaPrimary: 'Get started in 5 minutes',
    ctaSecondary: 'Which runtime do I need?',
    runtimeHeading: 'First decision: where does your agent run?',
    runtimeIntro:
        'Almost every setup question downstream depends on this one, so it goes first.',
    runtimeMore: 'Full comparison and how to choose',
    runtimes: [
        {
            badge: 'Default choice',
            title: 'Stateful sandbox',
            body: 'An isolated cloud workspace that pauses and resumes while keeping files and session state.',
            pick: 'Pick this if the work does not need your machine.'
        },
        {
            badge: 'Your machine',
            title: 'Self-owned computer',
            body: 'Runs on a Mac, Linux, or Windows machine you control, using its repository, tools, and network.',
            pick: 'Pick this for a local repository, CLI, GPU, or VPN.'
        },
        {
            badge: 'Always on',
            title: 'Cloud computer',
            body: 'A long-running Manyfold cloud computer for services, connectors, and scheduled workflows.',
            pick: 'Pick this when it has to stay online.'
        }
    ],
    stepsHeading: 'Then, in order',
    stepsIntro:
        'The first setup, in the order the getting started guide and the CLI install page describe it.',
    steps: [
        {
            title: 'Sign in',
            body: 'Sign in to Manyfold.',
            href: '/docs/getting-started/'
        },
        {
            title: 'Add a model provider',
            body: 'Add a model provider key in Settings -> Model providers, unless your workspace already has managed model access.',
            href: '/docs/model-providers/'
        },
        {
            title: 'Create your first agent',
            body: 'Create the agent from New agent, then choose its framework and runtime mode.',
            href: '/docs/create-agent/'
        },
        {
            title: 'Send the first task',
            body: 'Open the chat workspace and send the first task.',
            href: '/docs/workspace/'
        },
        {
            title: 'Install the CLI',
            body: 'For terminal access, install the CLI after signing in, then run mf login and mf whoami.',
            href: '/docs/install/'
        }
    ],
    indexHeading: 'Everything, by group',
    indexIntro:
        'The full tree, so a reader who already knows what they want does not have to guess a path.',
    machineHeading: 'For agents and scripts',
    machineIntro:
        'The whole corpus, in formats a model can read without scraping HTML.',
    machineNotes: {
        '/llms.txt': 'Grouped index of every page, one line each',
        '/llms-full.txt': 'Every page inlined as one document',
        '/changelog/feed.xml': 'Every release note as an RSS feed'
    },
    markdownTwinLabel: '<page>.md',
    markdownTwinNote: 'Markdown twin of any page, same URL plus .md'
}

const zh: DashboardCopy = {
    title: '文档',
    description:
        '运行、连接并编排 AI agent。可以先在一个 sandbox 里启动一个托管 agent，或者注册你自己的电脑，让 agent 在你的代码仓库里工作。',
    heading: 'Manyfold 文档',
    deck: '运行、连接并编排 AI agent。可以先在一个 sandbox 里启动一个托管 agent，或者注册你自己的电脑，让 agent 在你的代码仓库里工作。',
    ctaPrimary: '5 分钟快速上手',
    ctaSecondary: '我该选哪个 runtime？',
    runtimeHeading: '第一个决策：你的 agent 跑在哪里？',
    runtimeIntro: '几乎所有下游的配置问题都取决于这一个决定，所以它排在最前面。',
    runtimeMore: '完整对比与选择方法',
    runtimes: [
        {
            badge: '默认选择',
            title: '有状态 sandbox',
            body: '一个可以暂停和恢复的隔离云端 workspace，同时保留文件和会话状态。',
            pick: '如果这项工作用不到你自己的电脑，选这个。'
        },
        {
            badge: '你的电脑',
            title: '自有电脑',
            body: '运行在你自己掌控的 Mac、Linux 或 Windows 电脑上，使用它的代码仓库、工具和网络。',
            pick: '本地代码仓库、CLI、GPU 或 VPN，选这个。'
        },
        {
            badge: '常驻在线',
            title: '云端电脑',
            body: '一台长期运行的 Manyfold 云端电脑，用于服务、连接器和定时工作流。',
            pick: '需要一直保持在线时，选这个。'
        }
    ],
    stepsHeading: '然后，按顺序',
    stepsIntro: '第一次设置的顺序，来自快速开始和安装 CLI 这两个页面。',
    steps: [
        {
            title: '登录',
            body: '登录 Manyfold。',
            href: '/docs/getting-started/'
        },
        {
            title: '添加模型提供方',
            body: '在 Settings -> Model providers 添加模型提供方密钥，除非你的工作区已经有托管模型额度。',
            href: '/docs/model-providers/'
        },
        {
            title: '创建第一个 Agent',
            body: '从 New agent 创建第一个 Agent，并选择 Agent 框架和运行模式。',
            href: '/docs/create-agent/'
        },
        {
            title: '发送第一个任务',
            body: '打开聊天工作区并发送第一个任务。',
            href: '/docs/workspace/'
        },
        {
            title: '安装 CLI',
            body: '如果需要在终端中使用，请在登录后安装 CLI，然后运行 mf login 和 mf whoami。',
            href: '/docs/install/'
        }
    ],
    indexHeading: '全部内容，按分组',
    indexIntro: '完整的路由树，让已经知道目标的读者不必猜路径。',
    machineHeading: '面向 agent 和脚本',
    machineIntro: '整个文档语料库，提供无需抓取 HTML 就能读取的格式，方便模型直接使用。',
    machineNotes: {
        '/llms.txt': '按分组列出所有页面的索引，每页一行',
        '/llms-full.txt': '把所有页面合并成一份完整文档',
        '/changelog/feed.xml': '以 RSS 输出全部发布记录'
    },
    markdownTwinLabel: '<page>.md',
    markdownTwinNote: '任何页面的 Markdown 版本，同一个 URL 加上 .md'
}

export const dashboardCopyFor = (locale: Locale): DashboardCopy =>
    locale === 'zh' ? zh : en

// The Reference file nodes carry a locale prefix in their href (/zh/llms.txt),
// while the notes above are keyed by the unprefixed route. One place to strip
// it, so a new locale does not need a second copy of every note.
export const machineNoteFor = (
    copy: DashboardCopy,
    href: string
): string | undefined => copy.machineNotes[href.replace(/^\/zh(?=\/)/, '')]
