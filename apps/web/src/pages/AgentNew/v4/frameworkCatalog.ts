import { frameworkCapability } from '@manyfold/shared'
import type { AgentFramework } from '@manyfold/shared'
import {
    ClaudeCodeColor,
    CodexColor,
    DifyColor,
    GeminiCLIColor,
    HermesAgentMono,
    OpenClawColor,
    type IconType
} from '@/lib/brandIcons'
import { NetworkIcon, PlugIcon, WorkflowIcon } from '@/components/icons'
import type { LucideIcon } from '@/components/icons'

// Step ① groups the nine frameworks by ONE fact: does it need a machine from
// us, or does it connect to a service the user already runs. That boundary is
// binary, has no exceptions, and is exactly where step ② forks — machines on
// one side, services on the other — so the group heading previews the next
// question.
//
// It deliberately does NOT group by ability ("writes code" / "assistant and
// orchestration"). The nine are not mutually exclusive that way: Claude Code
// orchestrates, OpenClaw writes code. A group asserts exclusivity, a row
// attribute does not — so ability claims stay out of both the headings and the
// row lines, which say what the thing *is* (whose CLI, what shape of service).
//
// It also does not group by billing. A subscription is something the three
// coding CLIs *can* use, not something they must — Claude Code runs just as
// well on managed billing — so that is a row attribute, worded "can use".
export type FrameworkGroupId = 'onMachine' | 'connected'

export interface FrameworkEntry {
    framework: AgentFramework
    label: string
    // What this thing is. Never a ranking of what it is good at.
    identityKey: string
    // Only set where the CLI carries its own vendor sign-in, so a subscription
    // the user already pays for is available. Worded "can use …" downstream.
    subscriptionKey?: string
    Mark?: IconType
    FallbackIcon?: LucideIcon
}

export interface FrameworkGroup {
    id: FrameworkGroupId
    titleKey: string
    entries: FrameworkEntry[]
}

export const FRAMEWORK_GROUPS: FrameworkGroup[] = [
    {
        id: 'onMachine',
        titleKey: 'web.agentNewV4.type.onMachine',
        entries: [
            {
                framework: 'claude-code',
                label: 'Claude Code',
                identityKey: 'web.agentNewV4.identity.claudeCode',
                subscriptionKey: 'web.agentNewV4.subscription.claude',
                Mark: ClaudeCodeColor
            },
            {
                framework: 'codex',
                label: 'Codex',
                identityKey: 'web.agentNewV4.identity.codex',
                subscriptionKey: 'web.agentNewV4.subscription.codex',
                Mark: CodexColor
            },
            {
                framework: 'gemini-cli',
                label: 'Gemini CLI',
                identityKey: 'web.agentNewV4.identity.geminiCli',
                subscriptionKey: 'web.agentNewV4.subscription.gemini',
                Mark: GeminiCLIColor
            },
            {
                framework: 'openclaw',
                label: 'OpenClaw',
                identityKey: 'web.agentNewV4.identity.openclaw',
                Mark: OpenClawColor
            },
            {
                framework: 'hermes',
                label: 'Hermes',
                identityKey: 'web.agentNewV4.identity.hermes',
                Mark: HermesAgentMono
            },
            {
                framework: 'narranexus',
                label: 'NarraNexus',
                identityKey: 'web.agentNewV4.identity.narranexus',
                FallbackIcon: NetworkIcon
            }
        ]
    },
    {
        id: 'connected',
        titleKey: 'web.agentNewV4.type.connected',
        entries: [
            {
                framework: 'dify',
                label: 'Dify',
                identityKey: 'web.agentNewV4.identity.dify',
                Mark: DifyColor
            },
            {
                framework: 'langflow',
                label: 'Langflow',
                identityKey: 'web.agentNewV4.identity.langflow',
                FallbackIcon: WorkflowIcon
            },
            {
                framework: 'a2a',
                label: 'A2A',
                identityKey: 'web.agentNewV4.identity.a2a',
                FallbackIcon: PlugIcon
            }
        ]
    }
]

const ENTRY_BY_FRAMEWORK = new Map<AgentFramework, FrameworkEntry>(
    FRAMEWORK_GROUPS.flatMap((group) =>
        group.entries.map((entry) => [entry.framework, entry] as const)
    )
)

export const frameworkLabel = (framework: AgentFramework): string =>
    ENTRY_BY_FRAMEWORK.get(framework)?.label ?? framework

// Whose account the sign-in belongs to. A user signs in to Claude, not to
// "Claude Code" — the CLI is only what carries the sign-in — so step ③ names
// the vendor rather than reusing the row label from step ①.
const VENDOR_LABEL: Partial<Record<AgentFramework, string>> = {
    'claude-code': 'Claude',
    codex: 'ChatGPT',
    'gemini-cli': 'Google'
}

export const vendorLabel = (framework: AgentFramework): string =>
    VENDOR_LABEL[framework] ?? frameworkLabel(framework)

// Whether step ② asks about a machine or about a service the user already
// runs. Derived from the backend's own static facts so the split can't drift
// from `frameworkCapabilities`.
export const runsOnOurMachine = (framework: AgentFramework): boolean =>
    frameworkCapability(framework).kind !== 'external'

// Only a CLI that carries its own vendor sign-in can run on the user's
// subscription. Step ③ says so in as many words rather than greying rows out.
export const canUseSubscription = (framework: AgentFramework): boolean =>
    frameworkCapability(framework).kind === 'coding'
