import type { AgentFramework } from './constants'

export interface FrameworkRepoCandidate {
    // GitHub `owner/name`. Doubles as the id an admin selection stores and as
    // the only input to the clone URL, so the version catalog and the install
    // clone are structurally incapable of naming different repositories.
    repo: string
    label: string
    note?: string
}

// Frameworks whose version catalog AND install both come from a git repo. The
// FIRST entry is the default: an unconfigured platform resolves to it, and the
// api-side descriptor takes its `source.repo` from the same slot.
//
// Adding a candidate is a trust decision, not a configuration change: a sprite
// clones it and then RUNS its build (`uv sync`, `npm ci`, `npm run build`).
// Before adding one, confirm that (a) `git ls-remote --tags <url>` serves the
// framework's built-in fallback tag, and (b) the framework's clone path is
// driven by this slug. Hermes fails (b) — its bootstrap pipes NousResearch's
// own install.sh, which clones a repository hardcoded inside that script — so
// it must keep exactly one candidate until that path takes a slug.
export const HERMES_REPO_CANDIDATES: readonly FrameworkRepoCandidate[] = [
    { repo: 'NousResearch/hermes-agent', label: 'NousResearch (upstream)' }
]

export const NARRANEXUS_REPO_CANDIDATES: readonly FrameworkRepoCandidate[] = [
    {
        repo: 'NetMindAI-Open/NarraNexus',
        label: 'NetMindAI-Open',
        note: 'The public NarraNexus release line.'
    },
    {
        repo: 'protagolabs/NarraNexus',
        label: 'protagolabs',
        note: 'Carries additional patch and historical tags that the public line never published.'
    }
]

const CANDIDATES: Partial<
    Record<AgentFramework, readonly FrameworkRepoCandidate[]>
> = {
    hermes: HERMES_REPO_CANDIDATES,
    narranexus: NARRANEXUS_REPO_CANDIDATES
}

export const frameworkRepoCandidates = (
    framework: unknown
): readonly FrameworkRepoCandidate[] =>
    CANDIDATES[framework as AgentFramework] ?? []

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
 * candidates. Measured on github [2026-08-12]: narranexus `v1.15.0` is
 * 5869502c on NetMindAI-Open and e2083c28 on protagolabs.
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
