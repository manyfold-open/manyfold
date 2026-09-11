import {
    AgentFramework,
    FrameworkDefaultVersionsSettings,
    FrameworkVersionSelection,
    VersionedFramework,
    blockedVersionMessage,
    blockedVersionRangesFor,
    findBlockedVersionRange,
    frameworkPrereleaseAllowed,
    isPrereleaseVersion,
    isVersionedFramework,
    resolveFrameworkRepo,
    selectFrameworkInstallVersion
} from '@manyfold/shared'
import { BadRequestException } from '@nestjs/common'

export interface ResolvedInstallVersion {
    selection: FrameworkVersionSelection
    repo: string | null
}

// The version a fresh install of `framework` gets: the caller's request, else
// the admin pin, else the newest release upstream — with the blocked windows
// and the prerelease opt-in applied. One function for agent create and for
// preparing a runtime on a bare sandbox, so the two cannot pick different
// builds for the same framework. A framework with no versioned CLI, or an
// unreachable catalog, resolves to `none` and keeps its built-in default.
export const resolveFrameworkInstallVersion = async (
    deps: {
        settings: FrameworkDefaultVersionsSettings
        latestForFresh: (
            framework: VersionedFramework
        ) => Promise<string | null>
    },
    framework: AgentFramework,
    requested?: string | null
): Promise<ResolvedInstallVersion> => {
    const { settings } = deps
    // Resolved from the SAME settings read as the version below. A separate
    // read could see a source switch land in between and hand the bootstrap
    // a tag that only exists on the repository it is no longer cloning.
    const repo = resolveFrameworkRepo(framework, settings)
    const adminDefault = settings.defaults[framework]
    const blocked = blockedVersionRangesFor(framework, settings)
    const allowPrerelease = frameworkPrereleaseAllowed(framework, settings)
    // A blocked pin is skipped rather than installed, so the catalog tier
    // has to be reachable to take over — fetch it whenever no usable pin
    // survives, not just when none was configured. A prerelease pin with the
    // opt-in off is skipped the same way and for the same reason.
    const pinUsable =
        !!adminDefault &&
        !findBlockedVersionRange(adminDefault, blocked) &&
        (allowPrerelease || !isPrereleaseVersion(adminDefault))
    const catalogLatest =
        !requested && !pinUsable && isVersionedFramework(framework)
            ? await deps.latestForFresh(framework)
            : null
    const selection = selectFrameworkInstallVersion({
        requested,
        adminDefault,
        catalogLatest,
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
    return { selection, repo }
}
