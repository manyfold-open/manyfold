import {
    AgentFramework,
    FrameworkDefaultVersionsSettings,
    FrameworkVersionSelection,
    FrameworkVersionCatalogEntry,
    VersionedFramework,
    blockedVersionMessage,
    blockedVersionRangesFor,
    frameworkPrereleaseAllowed,
    frameworkRepoCandidates,
    frameworkUpgradeMode,
    isVersionedFramework,
    resolveFrameworkRepo,
    selectFrameworkInstallVersion
} from '@manyfold/shared'
import {
    BadRequestException,
    ServiceUnavailableException
} from '@nestjs/common'
import type { FrameworkReleaseArtifacts } from '@/modules/framework-versions/framework-version-registry'

export interface ResolvedInstallVersion {
    selection: FrameworkVersionSelection
    repo: string | null
    // A release-binary framework's digests for `selection.version`; null for
    // every other install.
    artifacts: FrameworkReleaseArtifacts | null
}

// The version a fresh install of `framework` gets: the caller's request, else
// the admin pin, else the newest release upstream — with the blocked windows
// and the prerelease opt-in applied. One function for agent create and for
// preparing a runtime on a bare sandbox, so the two cannot pick different
// builds for the same framework. Git installs require a catalog-admitted
// version/repository pair. npm/image installs retain their default fallback.
export const resolveFrameworkInstallVersion = async (
    deps: {
        settings: FrameworkDefaultVersionsSettings
        latestForFresh: (
            framework: VersionedFramework
        ) => Promise<string | null>
        catalogForFresh: (
            framework: VersionedFramework
        ) => Promise<FrameworkVersionCatalogEntry>
        releaseArtifacts: (
            framework: VersionedFramework,
            version: string
        ) => Promise<FrameworkReleaseArtifacts>
    },
    framework: AgentFramework,
    requested?: string | null
): Promise<ResolvedInstallVersion> => {
    const { settings } = deps
    const repo = resolveFrameworkRepo(framework, settings)
    const adminDefault = settings.defaults[framework]
    const blocked = blockedVersionRangesFor(framework, settings)
    const allowPrerelease = frameworkPrereleaseAllowed(framework, settings)
    let selection = selectFrameworkInstallVersion({
        requested,
        adminDefault,
        blocked,
        allowPrerelease
    })
    if (selection.source !== 'none' && selection.blockedBy)
        throw new BadRequestException(
            blockedVersionMessage(
                framework,
                selection.version,
                selection.blockedBy
            )
        )
    if (selection.source !== 'none' && selection.prereleaseNotAllowed)
        throw new BadRequestException(
            `${framework} version ${selection.version} is a pre-release; enable pre-release versions for ${framework} first`
        )
    if (!isVersionedFramework(framework))
        return { selection, repo, artifacts: null }
    if (repo) {
        let catalog: FrameworkVersionCatalogEntry
        try {
            catalog = await deps.catalogForFresh(framework)
        } catch {
            throw new ServiceUnavailableException(
                `${framework} version catalog is unavailable; refresh it before installing`
            )
        }
        // The catalog can observe a source switch after the settings above.
        // Its repository, never that earlier settings read, owns admission.
        const admittedRepo = catalog.sourceRepo
        if (
            !frameworkRepoCandidates(framework).some(
                (entry) => entry.repo === admittedRepo
            )
        )
            throw new ServiceUnavailableException(
                `${framework} version catalog has no admitted repository; refresh it before installing`
            )
        if (!catalog.fetchedAt && catalog.versions.length === 0)
            throw new ServiceUnavailableException(
                `${framework} version catalog is unavailable for ${admittedRepo}; refresh it before installing`
            )
        if (selection.source === 'none')
            selection = selectFrameworkInstallVersion({
                catalogLatest: catalog.latest,
                blocked,
                allowPrerelease
            })
        if (selection.source === 'none')
            throw new ServiceUnavailableException(
                `${framework} has no installable version in the ${admittedRepo} catalog; refresh it before installing`
            )
        if (!catalog.versions.includes(selection.version)) {
            if (selection.source === 'latest')
                throw new ServiceUnavailableException(
                    `${framework} latest version is not in the ${admittedRepo} catalog; refresh it before installing`
                )
            throw new BadRequestException(
                `${selection.source === 'admin' ? 'admin pin' : 'version'} "${selection.version}" is not in the ${admittedRepo} catalog; ${selection.source === 'admin' ? 'change or clear the admin pin' : 'choose a version from this repository'}`
            )
        }
        if (frameworkUpgradeMode(framework) !== 'binary')
            return { selection, repo: admittedRepo, artifacts: null }
        let artifacts: FrameworkReleaseArtifacts
        try {
            artifacts = await deps.releaseArtifacts(
                framework,
                selection.version
            )
        } catch (err) {
            throw new ServiceUnavailableException(
                `${framework} ${selection.version} release digests are unavailable: ${(err as Error).message}`
            )
        }
        return { selection, repo: admittedRepo, artifacts }
    }
    if (selection.source === 'none')
        selection = selectFrameworkInstallVersion({
            catalogLatest: await deps.latestForFresh(framework),
            blocked,
            allowPrerelease
        })
    return { selection, repo, artifacts: null }
}
