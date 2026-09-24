import type { ChatCapabilities } from '../chat'
import type { FrameworkCapability } from '../framework-capability'
import type { FrameworkUpgradeMode } from '../framework-versions'
import type { FrameworkRepoCandidate } from '../frameworkVersionSources'

export interface FrameworkVersionFacts {
    upgradeMode: FrameworkUpgradeMode
    // Frameworks whose version catalog AND install both come from a git repo.
    // The FIRST entry is the default: an unconfigured platform resolves to it,
    // and the api-side descriptor takes its `source.repo` from the same slot.
    //
    // Adding a candidate is a trust decision, not a configuration change: a
    // sprite clones it and then RUNS its build (`uv sync`, `npm ci`,
    // `npm run build`). Before adding one, confirm that (a)
    // `git ls-remote --tags <url>` serves the framework's built-in fallback
    // tag, and (b) the framework's clone path is driven by this slug.
    repoCandidates?: readonly FrameworkRepoCandidate[]
}

// Every static fact about one framework that more than one surface reads
// (ADR-0006, ADR-0034). Core frameworks declare theirs in ./core; an edition
// registers its own through registerFramework before anything reads the
// registry. Behaviour stays in each framework's own modules, and UI copy stays
// in i18n.
export interface FrameworkDefinition extends FrameworkCapability {
    id: string
    // This table, not an adapter's own getCapabilities(), is what the Web
    // renderer gates thinking and tool blocks on, and nothing in production
    // reads an adapter's declaration at all — so a row that disagrees with its
    // adapter drops blocks the server streamed and persisted, with nothing to
    // say so (#677). Both sides are kept honest by
    // apps/api/test/chat-capability-contract.test.ts, which asserts every row
    // field-for-field against the adapter the registry resolves for it.
    chat: ChatCapabilities
    // Absent for frameworks whose runtime carries no installable,
    // upgradeable version (the external-API frameworks).
    version?: FrameworkVersionFacts
    // Env names this framework's runtime owns. A user env entry with one of
    // these prefixes is flagged in the UI and never injected.
    reservedEnvPrefixes?: readonly string[]
}

export class UnknownFrameworkError extends Error {
    readonly code = 'framework_unavailable'

    constructor(readonly framework: string) {
        super(`framework '${framework}' is not available`)
        this.name = 'UnknownFrameworkError'
    }
}
