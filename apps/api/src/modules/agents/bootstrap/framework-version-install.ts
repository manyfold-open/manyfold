import {
    VersionedFramework,
    parseProbedSemver,
    shouldInstallFrameworkVersion
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

/**
 * Bring an npm-installed coding-agent CLI to `ctx.frameworkVersion` on a fresh
 * sprite, and report the version that ended up on PATH.
 *
 * The sprite image bakes a binary at `~/.local/bin/<bin>` that is typically
 * behind npm (claude-code releases most days), so an unpinned agent used to
 * freeze on the image's version. Now the provisioner resolves a target and this
 * installs it, using the same staged-install shell as the upgrade flow (see
 * buildNpmUpgradeShell: isolated `--prefix`, candidate validated, then an
 * atomic symlink swap — a failed install never breaks the CLI on PATH).
 *
 * Failure policy follows `ctx.frameworkVersionSource`:
 *  - 'explicit' / 'admin' — someone asked for this version; failing to install
 *    it is a hard BootstrapError.
 *  - 'latest' — the implicit default; log and keep the image binary, because
 *    "can I create an agent" must not hinge on npm registry availability.
 */
export const installFrameworkVersion = async (
    ctx: BootstrapContext,
    framework: VersionedFramework,
    exec: SpriteExec = execSprite
): Promise<string | null> => {
    const descriptor = frameworkVersionDescriptor(framework)
    const installed = await probeVersion(ctx, descriptor.probeShell, exec)
    const target = ctx.frameworkVersion?.replace(/^v/, '') ?? null
    const asked =
        ctx.frameworkVersionSource === 'explicit' ||
        ctx.frameworkVersionSource === 'admin'

    if (!target) {
        // No resolvable target. A present binary is good enough; a missing one
        // means this sprite has no CLI at all, so fall back to the dist-tag.
        if (installed) return installed
        const result = await runInstall(
            ctx,
            buildNpmLatestInstallShell(descriptor),
            exec
        )
        if (result.exitCode !== 0)
            throw new BootstrapError(
                `${framework}-install-version`,
                `install ${framework}@latest failed (exit ${result.exitCode}): ${result.stderr.slice(0, 512)}`
            )
        return probeVersion(ctx, descriptor.probeShell, exec)
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
        return failOrDegrade(ctx, framework, {
            asked,
            target,
            installed,
            detail: `unusable target version: ${(err as Error).message}`
        })
    }

    const result = await runInstall(ctx, shell, exec)
    if (result.exitCode !== 0)
        return failOrDegrade(ctx, framework, {
            asked,
            target,
            installed,
            detail: `install ${framework}@${target} failed (exit ${result.exitCode}): ${result.stderr.slice(0, 512)}`
        })

    const effective = await probeVersion(ctx, descriptor.probeShell, exec)
    // The image binary at ~/.local/bin is PATH-first; if the symlink didn't take,
    // the sprite still runs the old CLI. Fail loud for an asked-for version.
    if (asked && effective !== target)
        throw new BootstrapError(
            `${framework}-install-version`,
            `installed ${framework}@${target} but sprite reports ${effective ?? 'unknown'}`
        )
    if (effective !== target)
        ctx.logger.warn(`${framework}.install.latest.mismatch`, {
            spriteName: ctx.spriteName,
            target,
            effective
        })
    return effective
}

// The one place the failure policy lives: an asked-for version (user dto / admin
// pin) that can't be installed is fatal; the implicit latest keeps whatever the
// sprite image already ships so agent creation survives a bad upstream release.
const failOrDegrade = (
    ctx: BootstrapContext,
    framework: VersionedFramework,
    info: {
        asked: boolean
        target: string
        installed: string | null
        detail: string
    }
): string | null => {
    if (info.asked)
        throw new BootstrapError(`${framework}-install-version`, info.detail)
    ctx.logger.warn(`${framework}.install.latest.failed`, {
        spriteName: ctx.spriteName,
        target: info.target,
        installed: info.installed,
        detail: info.detail
    })
    return info.installed
}

// Normalises a rejected exec (transport error / timeout) into a non-zero result
// so both failure policies below read one shape.
const runInstall = async (
    ctx: BootstrapContext,
    shell: string,
    exec: SpriteExec
): Promise<{ exitCode: number; stderr: string }> => {
    try {
        return await exec(
            ctx.client,
            ctx.spriteName,
            {
                cmd: ['bash', '-lc', shell],
                stdin: '',
                timeoutMs: Math.max(ctx.execTimeoutMs ?? 0, INSTALL_TIMEOUT_MS)
            },
            ctx.logger
        )
    } catch (err) {
        return { exitCode: -1, stderr: (err as Error).message }
    }
}

// A probe that can't run reads as "unknown", which makes the caller install
// rather than assume the image is current.
const probeVersion = async (
    ctx: BootstrapContext,
    probeShell: string,
    exec: SpriteExec
): Promise<string | null> => {
    try {
        const result = await exec(
            ctx.client,
            ctx.spriteName,
            {
                cmd: ['bash', '-lc', probeShell],
                stdin: '',
                timeoutMs: Math.max(ctx.execTimeoutMs ?? 0, PROBE_TIMEOUT_MS)
            },
            ctx.logger
        )
        return parseProbedSemver(`${result.stdout}\n${result.stderr}`)
    } catch {
        return null
    }
}
