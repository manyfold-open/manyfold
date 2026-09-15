import { frameworkCapability } from '@manyfold/shared'
import type { AgentFramework } from '@manyfold/shared'

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
//
// Names and logos are NOT redefined here: `lib/frameworkMeta` already owns
// both for the whole app, including the light/dark pairs some of them need.
// This file must not import it, though — frameworkMeta imports .svg assets,
// which Vite resolves and `tsx --test` cannot, and the grouping rules below
// are covered by a node:test suite.
export type FrameworkGroupId = 'onMachine' | 'connected'

export interface FrameworkEntry {
    framework: AgentFramework
    // What this thing is. Never a ranking of what it is good at.
    identityKey: string
    // Only set where the CLI carries its own vendor sign-in, so a subscription
    // the user already pays for is available. Worded "can use …" downstream.
    subscriptionKey?: string
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
                identityKey: 'web.agentNewV4.identity.claudeCode',
                subscriptionKey: 'web.agentNewV4.subscription.claude'
            },
            {
                framework: 'codex',
                identityKey: 'web.agentNewV4.identity.codex',
                subscriptionKey: 'web.agentNewV4.subscription.codex'
            },
            {
                framework: 'gemini-cli',
                identityKey: 'web.agentNewV4.identity.geminiCli',
                subscriptionKey: 'web.agentNewV4.subscription.gemini'
            },
            {
                framework: 'narranexus',
                identityKey: 'web.agentNewV4.identity.narranexus'
            },
            {
                framework: 'openclaw',
                identityKey: 'web.agentNewV4.identity.openclaw'
            },
            {
                framework: 'hermes',
                identityKey: 'web.agentNewV4.identity.hermes'
            }
        ]
    },
    {
        id: 'connected',
        titleKey: 'web.agentNewV4.type.connected',
        entries: [
            {
                framework: 'dify',
                identityKey: 'web.agentNewV4.identity.dify'
            },
            {
                framework: 'langflow',
                identityKey: 'web.agentNewV4.identity.langflow'
            },
            {
                framework: 'a2a',
                identityKey: 'web.agentNewV4.identity.a2a'
            }
        ]
    }
]

// Whether step ② asks about a machine or about a service the user already
// runs. Derived from the backend's own static facts so the split can't drift
// from `frameworkCapabilities`.
export const runsOnOurMachine = (framework: AgentFramework): boolean =>
    frameworkCapability(framework).kind !== 'external'

// Hermes is the one framework with no working directory to point at: it is a
// calendar-and-mail assistant, not something that opens a project. v1 has
// excluded it from the workspace field since the beginning and there is no
// capability flag for it, so the exception is named here rather than left as a
// bare literal wherever the field is drawn.
export const hasWorkspace = (framework: AgentFramework): boolean =>
    framework !== 'hermes'

// Only a CLI that carries its own vendor sign-in can run on the user's
// subscription. Step ③ says so in as many words rather than greying rows out.
export const canUseSubscription = (framework: AgentFramework): boolean =>
    frameworkCapability(framework).kind === 'coding'
