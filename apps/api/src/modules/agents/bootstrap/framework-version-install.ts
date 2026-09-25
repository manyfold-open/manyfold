import {
    VersionedFramework,
    parseProbedSemver,
    shouldInstallFrameworkVersion,
    type FrameworkInstallSource
} from '@manyfold/shared'
import {
    execSprite,
    type ExecOptions,
    type ExecResult,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import {
    BootstrapError,
    type BootstrapContext
} from '@/modules/agents/bootstrap/framework-bootstrap'
import {
    buildNpmLatestInstallShell,
    buildNpmUpgradeShell,
    frameworkVersionDescriptor
} from '@/modules/framework-versions/framework-version-registry'

const INSTALL_TIMEOUT_MS = 180_000
const PROBE_TIMEOUT_MS = 30_000

// Seam so tests can fake the sprite exec transport (mirrors SandboxesService.exec).
export type SpriteExec = (
    client: SpritesClient,
    spriteName: string,
    opts: ExecOptions,
    logger?: SpritesLogger
) => Promise<ExecResult>

// What installing a framework needs from the machine it runs on: a way to run
// a login-shell script, and somewhere to report an install that degraded. A
// sprite runs the script through execSprite; a pod host through its pod exec
// (ADR-0035). Both hand it the same staged-install shells.
export interface HostScriptRunner {
    run(script: string, timeoutMs: number): Promise<ExecResult>
    warn(event: string, fields: Record<string, unknown>): void
}

export interface FrameworkInstallRequest {
    frameworkVersion?: string | null
    frameworkVersionSource?: FrameworkInstallSource
    execTimeoutMs?: number
}

export const spriteScriptRunner = (
    ctx: BootstrapContext,
    exec: SpriteExec = execSprite
): HostScriptRunner => ({
    run: (script, timeoutMs) =>
        exec(
            ctx.client,
            ctx.spriteName,
            { cmd: ['bash', '-lc', script], stdin: '', timeoutMs },
            ctx.logger
        ),
    warn: (event, fields) =>
        ctx.logger.warn(event, { spriteName: ctx.spriteName, ...fields })
})

/**
 * Bring an npm-installed coding-agent CLI to `ctx.frameworkVersion` on a fresh
 * sprite, and report the version that ended up on PATH.
 */
export const installFrameworkVersion = (
    ctx: BootstrapContext,
    framework: VersionedFramework,
    exec: SpriteExec = execSprite
): Promise<string | null> =>
    installFrameworkVersionOn(spriteScriptRunner(ctx, exec), ctx, framework)

/**
 * Bring an npm-installed coding-agent CLI to `request.frameworkVersion` on a
 * host, and report the version that ended up on PATH.
 *
 * A host's image may already carry a binary at `~/.local/bin/<bin>` that is
 * behind npm (claude-code releases most days), and a pod host carries none at
 * all. The caller resolves a target and this installs it, using the same
 * staged-install shell as the upgrade flow (see buildNpmUpgradeShell: isolated
 * `--prefix`, candidate validated, then an atomic symlink swap — a failed
 * install never breaks the CLI on PATH).
 *
 * Failure policy follows `request.frameworkVersionSource`:
 *  - 'explicit' / 'admin' — someone asked for this version; failing to install
 *    it is a hard BootstrapError.
 *  - 'latest' — the implicit default; log and keep the binary already there,
 *    because "can I create an agent" must not hinge on npm registry
 *    availability. With no binary at all, the install is fatal either way.
 */
export const installFrameworkVersionOn = async (
    runner: HostScriptRunner,
    request: FrameworkInstallRequest,
    framework: VersionedFramework
): Promise<string | null> => {
    const descriptor = frameworkVersionDescriptor(framework)
    const probe = () =>
        probeVersion(runner, request, descriptor.probeShell)
    const installed = await probe()
    const target = request.frameworkVersion?.replace(/^v/, '') ?? null
    const asked =
        request.frameworkVersionSource === 'explicit' ||
        request.frameworkVersionSource === 'admin'

    if (!target) {
        // No resolvable target. A present binary is good enough; a missing one
        // means this host has no CLI at all, so fall back to the dist-tag.
        if (installed) return installed
        const result = await runInstall(
            runner,
            request,
            buildNpmLatestInstallShell(descriptor)
        )
        if (result.exitCode !== 0)
            throw new BootstrapError(
                `${framework}-install-version`,
                `install ${framework}@latest failed (exit ${result.exitCode}): ${result.stderr.slice(0, 512)}`
            )
        return probe()
    }

    if (!shouldInstallFrameworkVersion(installed, target)) return installed

    // buildNpmUpgradeShell only accepts a bare `x.y.z`, and an npm `latest`
    // dist-tag is not guaranteed to be one — `openclaw` ships its patch counter
    // as `2026.7.1-2`, and the coding CLIs publish preview tags. A target we
    // cannot build a shell for is the same class of problem as an install that
    // fails, so it takes the same policy instead of escaping as a raw Error.
    let shell: string
    try {
        shell = buildNpmUpgradeShell(descriptor, target)
    } catch (err) {
        return failOrDegrade(runner, framework, {
            asked,
            target,
            installed,
            detail: `unusable target version: ${(err as Error).message}`
        })
    }

    const result = await runInstall(runner, request, shell)
    if (result.exitCode !== 0)
        return failOrDegrade(runner, framework, {
            asked,
            target,
            installed,
            detail: `install ${framework}@${target} failed (exit ${result.exitCode}): ${result.stderr.slice(0, 512)}`
        })

    const effective = await probe()
    // A binary already at ~/.local/bin is PATH-first; if the symlink didn't
    // take, the host still runs the old CLI. Fail loud for an asked-for version.
    if (asked && effective !== target)
        throw new BootstrapError(
            `${framework}-install-version`,
            `installed ${framework}@${target} but the host reports ${effective ?? 'unknown'}`
        )
    if (effective !== target)
        runner.warn(`${framework}.install.latest.mismatch`, {
            target,
            effective
        })
    return effective
}

// The one place the failure policy lives: an asked-for version (user dto / admin
// pin) that can't be installed is fatal; the implicit latest keeps whatever the
// host already ships so agent creation survives a bad upstream release — but a
// host with nothing to keep has no agent to create, so it fails too.
const failOrDegrade = (
    runner: HostScriptRunner,
    framework: VersionedFramework,
    info: {
        asked: boolean
        target: string
        installed: string | null
        detail: string
    }
): string | null => {
    if (info.asked || !info.installed)
        throw new BootstrapError(`${framework}-install-version`, info.detail)
    runner.warn(`${framework}.install.latest.failed`, {
        target: info.target,
        installed: info.installed,
        detail: info.detail
    })
    return info.installed
}

// Normalises a rejected exec (transport error / timeout) into a non-zero result
// so both failure policies below read one shape.
const runInstall = async (
    runner: HostScriptRunner,
    request: FrameworkInstallRequest,
    shell: string
): Promise<{ exitCode: number; stderr: string }> => {
    try {
        return await runner.run(
            shell,
            Math.max(request.execTimeoutMs ?? 0, INSTALL_TIMEOUT_MS)
        )
    } catch (err) {
        return { exitCode: -1, stderr: (err as Error).message }
    }
}

// A probe that can't run reads as "unknown", which makes the caller install
// rather than assume the host is current.
const probeVersion = async (
    runner: HostScriptRunner,
    request: FrameworkInstallRequest,
    probeShell: string
): Promise<string | null> => {
    try {
        const result = await runner.run(
            probeShell,
            Math.max(request.execTimeoutMs ?? 0, PROBE_TIMEOUT_MS)
        )
        return parseProbedSemver(`${result.stdout}\n${result.stderr}`)
    } catch {
        return null
    }
}
