import type { AgentFramework } from './frameworks/core'
import { frameworkDefinition } from './frameworks/registry'

export interface FrameworkRepoCandidate {
    // GitHub `owner/name`. Doubles as the id an admin selection stores and as
    // the only input to the clone URL, so the version catalog and the install
    // clone are structurally incapable of naming different repositories.
    repo: string
    label: string
    note?: string
}

// Declared per framework on its definition (FrameworkVersionFacts); read
// here so the catalog and the clone share one lookup.
export const frameworkRepoCandidates = (
    framework: unknown
): readonly FrameworkRepoCandidate[] =>
    frameworkDefinition(framework)?.version?.repoCandidates ?? []

export const defaultFrameworkRepo = (framework: unknown): string | null =>
    frameworkRepoCandidates(framework)[0]?.repo ?? null

/**
 * The single decision point for "which repository does this framework come
 * from". Both the catalog fetch and the clone resolve through it, so an admin's
 * pick cannot leave the picker showing one repository's tags while the install
 * clones another — the candidates publish different tag sets, so a split would
 * offer versions that do not exist where they are fetched from.
 *
 * Switching also changes WHAT a shared version number means, not only which
 * versions exist: the same tag can point at different commits in two
 * candidates.
 *
 * A slug that is no longer on the list — removed in a later deploy while the
 * settings row still names it — falls back to the default rather than being
 * honoured. The allowlist has to stay revocable.
 */
export const resolveFrameworkRepo = (
    framework: unknown,
    settings?: {
        sourceRepos?: Partial<Record<AgentFramework, string>>
    } | null
): string | null => {
    const candidates = frameworkRepoCandidates(framework)
    if (!candidates.length) return null
    const chosen = settings?.sourceRepos?.[framework as AgentFramework]?.trim()
    return (candidates.find((c) => c.repo === chosen) ?? candidates[0]).repo
}

const SLUG_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/

/**
 * Derived, never stored. A candidate carrying its own URL could point at a
 * different org than its slug — the exact split this module exists to prevent.
 *
 * The character class admits no whitespace, quote, `;`, `$`, backtick, `&`,
 * `|`, parenthesis, redirection or newline, so a slug that passes cannot carry
 * a shell metacharacter into the `git clone` this URL is interpolated into.
 */
export const frameworkRepoCloneUrl = (repo: string): string => {
    const value = repo.trim()
    if (!SLUG_RE.test(value) || value.includes('..'))
        throw new Error(`invalid framework repo slug: ${repo}`)
    return `https://github.com/${value}.git`
}
