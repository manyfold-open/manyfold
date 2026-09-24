import type { AgentFramework } from '@manyfold/shared'
import { frameworkLabel } from '@/lib/frameworkMeta'

// Whose account a sign-in belongs to. A user signs in to Claude, not to
// "Claude Code" — the CLI is only what carries the sign-in — so step ③ and
// the button that starts a sign-in both name the vendor rather than the
// product picked in step ①.
//
// It lives apart from `frameworkCatalog` because it reaches `frameworkMeta`,
// which imports .svg assets that `tsx --test` cannot load, and the catalog's
// grouping rules are covered by a node:test suite.
// pi signs in to whichever vendor its /login is pointed at; these are the
// subscriptions people come to it with.
const VENDOR_LABEL: Partial<Record<AgentFramework, string>> = {
    'claude-code': 'Claude',
    codex: 'ChatGPT',
    'gemini-cli': 'Google',
    pi: 'Claude, ChatGPT or Copilot'
}

export const vendorLabel = (framework: AgentFramework): string =>
    VENDOR_LABEL[framework] ?? frameworkLabel(framework)
