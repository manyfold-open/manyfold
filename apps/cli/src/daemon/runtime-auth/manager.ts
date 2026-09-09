import { homedir } from 'node:os'
import { lstat } from 'node:fs/promises'
import {
    AMBIENT_VENDOR_AUTH_ENV,
    parseRuntimeLocalCredentialFacts,
    type ConfigurableFramework,
    type DaemonAuthCreateResponse,
    type DaemonAuthListResponse,
    type DaemonAuthLogoutResponse,
    type DaemonAuthOperationRecord,
    type DaemonAuthProfileReport,
    type RuntimeAccountProbe,
    type RuntimeAuthMethod
} from '@manyfold/shared'
import { inspectRuntimeAccount } from '../account-inspect'
import type { FrameworkConfigDirs } from '../inspect-fs'
import { runtimeAuthAdapter } from './adapters'
import { acquireProfileLock, type ProfileLock } from './lock'
import {
    nativeDirsFor,
    profilePaths,
    viewConfigDirs,
    type RuntimeAuthScope
} from './paths'
import {
    finishOperation,
    listProfileIds,
    readMetadata,
    readOperation,
    removeProfileDir,
    startOperation,
    writeMetadata,
    type ProfileMetadata
} from './store'

// The host side of runtime auth profiles. The API names profiles by id; this
// class owns the store, the per-profile lock, the operation journal and the
// vendor CLI invocations, and returns only safe reports. Credential facts
// come from the same inspectors the ambient probe uses, pointed at the view.

export interface RuntimeAuthManagerDeps {
    credentialFacts: (
        framework: ConfigurableFramework,
        dirs: FrameworkConfigDirs
    ) => Promise<unknown>
    cliVersion: (framework: ConfigurableFramework) => Promise<string | null>
    fetch: typeof fetch
    now: () => number
    platform: NodeJS.Platform
    env: NodeJS.ProcessEnv
}

export interface PreparedLogin {
    command: string[]
    env: Record<string, string>
    cwd: string
    finish: (exitCode: number | null) => Promise<DaemonAuthOperationRecord>
}

const CLI_BIN: Record<ConfigurableFramework, string> = {
    'claude-code': 'claude',
    codex: 'codex',
    'gemini-cli': 'gemini'
}

export const cliBinaryFor = (framework: ConfigurableFramework): string =>
    CLI_BIN[framework]

// Every ambient vendor variable is dropped before a profile context is laid
// over the daemon's environment (a leftover ANTHROPIC_API_KEY would outrank
// the profile's own sign-in).
export const stripAmbientAuthEnv = (
    env: NodeJS.ProcessEnv
): Record<string, string> => {
    const out: Record<string, string> = {}
    const dropped = new Set<string>(AMBIENT_VENDOR_AUTH_ENV)
    for (const [key, value] of Object.entries(env))
        if (typeof value === 'string' && !dropped.has(key)) out[key] = value
    return out
}

const semver = (version: string | null): string | null =>
    version?.match(/\d+\.\d+\.\d+/)?.[0] ?? null

export class RuntimeAuthManager {
    constructor(
        readonly scope: RuntimeAuthScope,
        private readonly deps: RuntimeAuthManagerDeps
    ) {}

    private async probe(
        framework: ConfigurableFramework,
        dirs: FrameworkConfigDirs
    ): Promise<RuntimeAccountProbe> {
        const [account, facts, cliVersion] = await Promise.all([
            inspectRuntimeAccount(framework, {
                fetch: this.deps.fetch,
                now: this.deps.now,
                platform: this.deps.platform,
                cliVersion: semver(await this.deps.cliVersion(framework)),
                dirs
            }),
            this.deps.credentialFacts(framework, dirs),
            this.deps.cliVersion(framework)
        ])
        void cliVersion
        return {
            ...account,
            credentialFacts: parseRuntimeLocalCredentialFacts(facts)
        }
    }

    async ambient(
        framework: ConfigurableFramework
    ): Promise<RuntimeAccountProbe> {
        return this.probe(framework, nativeDirsFor())
    }

    private async report(
        framework: ConfigurableFramework,
        profileId: string,
        probe: boolean
    ): Promise<DaemonAuthProfileReport> {
        const metadata = await readMetadata(this.scope, profileId)
        const base: DaemonAuthProfileReport = {
            profileId,
            present: metadata !== null,
            authMethod: metadata?.authMethod ?? null,
            generation: metadata?.generation ?? 0,
            createdAt: metadata?.createdAt ?? null,
            lastLoginAt: metadata?.lastLoginAt ?? null,
            probe: null,
            error: null
        }
        if (!metadata || !probe) return base
        if (metadata.framework !== framework)
            return { ...base, error: 'profile belongs to another framework' }
        try {
            const { viewDir } = profilePaths(this.scope, profileId)
            return {
                ...base,
                probe: await this.probe(
                    framework,
                    viewConfigDirs(framework, viewDir)
                )
            }
        } catch (err) {
            return { ...base, error: (err as Error).message.slice(0, 300) }
        }
    }

    async list(
        framework: ConfigurableFramework,
        probe: boolean
    ): Promise<DaemonAuthListResponse> {
        const ids = await listProfileIds(this.scope)
        const profiles: DaemonAuthProfileReport[] = []
        for (const id of ids) {
            const metadata = await readMetadata(this.scope, id)
            if (!metadata || metadata.framework !== framework) continue
            profiles.push(await this.report(framework, id, probe))
        }
        return {
            profiles,
            ambient: probe ? await this.ambient(framework) : null
        }
    }

    async inspect(
        framework: ConfigurableFramework,
        profileId: string
    ): Promise<DaemonAuthProfileReport> {
        return this.report(framework, profileId, true)
    }

    async create(
        framework: ConfigurableFramework,
        profileId: string,
        authMethod: RuntimeAuthMethod
    ): Promise<DaemonAuthCreateResponse> {
        const existing = await readMetadata(this.scope, profileId)
        const paths = profilePaths(this.scope, profileId)
        await runtimeAuthAdapter(framework).buildView(paths.viewDir)
        if (existing)
            return {
                profileId,
                generation: existing.generation,
                created: false
            }
        const metadata: ProfileMetadata = {
            profileId,
            framework,
            authMethod,
            generation: 0,
            createdAt: new Date(this.deps.now()).toISOString(),
            lastLoginAt: null,
            lastLogoutAt: null
        }
        await writeMetadata(this.scope, metadata)
        return { profileId, generation: 0, created: true }
    }

    private async requireMetadata(
        framework: ConfigurableFramework,
        profileId: string
    ): Promise<ProfileMetadata> {
        const metadata = await readMetadata(this.scope, profileId)
        if (!metadata) throw new Error('auth_profile_missing')
        if (metadata.framework !== framework)
            throw new Error('auth_profile_target_mismatch')
        return metadata
    }

    private contextEnv(
        framework: ConfigurableFramework,
        viewDir: string,
        authMethod: RuntimeAuthMethod
    ): Record<string, string> {
        return {
            ...stripAmbientAuthEnv(this.deps.env),
            ...runtimeAuthAdapter(framework).env(viewDir, authMethod)
        }
    }

    private async credentialPresent(
        framework: ConfigurableFramework,
        viewDir: string
    ): Promise<boolean> {
        for (const path of runtimeAuthAdapter(framework).credentialPaths(
            viewDir
        ))
            try {
                await lstat(path)
                return true
            } catch {}
        return false
    }

    // Login runs in the caller's PTY (pty.open with `authLogin`): the lock is
    // held until that shell exits, then the view is inspected to decide the
    // outcome. A cancelled or abandoned login leaves the profile as it was.
    async prepareLogin(
        framework: ConfigurableFramework,
        profileId: string,
        operationId: string
    ): Promise<PreparedLogin> {
        const metadata = await this.requireMetadata(framework, profileId)
        const paths = profilePaths(this.scope, profileId)
        const adapter = runtimeAuthAdapter(framework)
        await adapter.buildView(paths.viewDir)
        const lock: ProfileLock = await acquireProfileLock(
            paths.lockDir,
            `login:${operationId}`
        )
        let record: DaemonAuthOperationRecord
        try {
            record = await startOperation(this.scope, {
                operationId,
                profileId,
                kind: 'login'
            })
        } catch (err) {
            await lock.release()
            throw err
        }
        return {
            command: adapter.loginArgv(),
            env: this.contextEnv(framework, paths.viewDir, metadata.authMethod),
            cwd: homedir(),
            finish: async (exitCode) => {
                try {
                    const report = await this.report(framework, profileId, true)
                    const signedIn =
                        Boolean(report.probe?.identity) ||
                        (await this.credentialPresent(framework, paths.viewDir))
                    if (signedIn) {
                        const latest =
                            (await readMetadata(this.scope, profileId)) ??
                            metadata
                        await writeMetadata(this.scope, {
                            ...latest,
                            generation: latest.generation + 1,
                            lastLoginAt: new Date(this.deps.now()).toISOString()
                        })
                        return finishOperation(this.scope, record, {
                            status: 'succeeded',
                            resultCode: null,
                            error: null
                        })
                    }
                    return finishOperation(this.scope, record, {
                        status: 'failed',
                        resultCode: 'login_incomplete',
                        error:
                            exitCode === 0 || exitCode === null
                                ? 'the sign-in shell closed before a credential was stored'
                                : `sign-in shell exited ${exitCode}`
                    })
                } finally {
                    await lock.release()
                }
            }
        }
    }

    async logout(
        framework: ConfigurableFramework,
        profileId: string,
        operationId: string,
        mode: 'sign-out' | 'remove'
    ): Promise<DaemonAuthLogoutResponse> {
        const metadata = await this.requireMetadata(framework, profileId)
        const paths = profilePaths(this.scope, profileId)
        const adapter = runtimeAuthAdapter(framework)
        const lock = await acquireProfileLock(
            paths.lockDir,
            `${mode}:${operationId}`
        )
        const record = await startOperation(this.scope, {
            operationId,
            profileId,
            kind: mode === 'remove' ? 'remove' : 'logout'
        })
        try {
            const outcome = await adapter.logout(
                paths.viewDir,
                this.contextEnv(framework, paths.viewDir, metadata.authMethod)
            )
            const generation = metadata.generation + 1
            if (mode === 'remove') {
                await lock.release()
                await removeProfileDir(this.scope, profileId)
            } else
                await writeMetadata(this.scope, {
                    ...metadata,
                    generation,
                    lastLogoutAt: new Date(this.deps.now()).toISOString()
                })
            await finishOperation(this.scope, record, {
                status: outcome.signedOut ? 'succeeded' : 'failed',
                resultCode: outcome.signedOut ? null : 'logout_failed',
                error: outcome.error
            })
            return {
                signedOut: outcome.signedOut,
                removed: mode === 'remove',
                revoke: outcome.revoke,
                generation,
                logoutError: outcome.error
            }
        } catch (err) {
            await finishOperation(this.scope, record, {
                status: 'failed',
                resultCode: 'logout_failed',
                error: (err as Error).message.slice(0, 300)
            })
            throw err
        } finally {
            if (mode !== 'remove') await lock.release()
        }
    }

    async operation(
        operationId: string
    ): Promise<DaemonAuthOperationRecord | null> {
        return readOperation(this.scope, operationId)
    }

    // The context an execution (exec.start / pty.open) runs in: the profile's
    // env laid over the daemon environment with every ambient vendor variable
    // dropped, plus the profile lock held for the process's lifetime. A view
    // that never completed a login is refused here, not run as ambient.
    async executionContext(
        framework: ConfigurableFramework,
        profileId: string,
        label: string,
        opts: { waitMs?: number } = {}
    ): Promise<{
        env: Record<string, string>
        dirs: FrameworkConfigDirs
        release: () => Promise<void>
    }> {
        const metadata = await this.requireMetadata(framework, profileId)
        const paths = profilePaths(this.scope, profileId)
        if (!(await this.credentialPresent(framework, paths.viewDir))) {
            const report = await this.report(framework, profileId, true)
            if (!report.probe?.identity) throw new Error('auth_reauth_required')
        }
        const lock = await acquireProfileLock(paths.lockDir, label, opts)
        return {
            env: this.contextEnv(framework, paths.viewDir, metadata.authMethod),
            dirs: viewConfigDirs(framework, paths.viewDir),
            release: () => lock.release()
        }
    }

    dirsFor(
        framework: ConfigurableFramework,
        profileId: string
    ): FrameworkConfigDirs {
        return viewConfigDirs(
            framework,
            profilePaths(this.scope, profileId).viewDir
        )
    }
}
