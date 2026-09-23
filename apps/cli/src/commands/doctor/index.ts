import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { Command } from 'commander'
import { collectBuildInfo } from '@/build-info'
import {
    resolveConfigDir,
    resolveProfile,
    resolveProfileSource
} from '@/config'
import { queryDaemonHealth } from '@/daemon/control'
import { getInitUnitStatus, initUnitDirs } from '@/daemon/init-unit'
import { checkPtySupport } from '@/daemon/pty-backend'
import { emit, jsonOption } from '@/output'
import { resolveHttpTimeoutMs } from '@/transport'
import {
    createHttpProbe,
    createVersionProbe,
    gatherMachine,
    gatherProfile,
    profilesToCheck,
    withTimeout
} from './gather'
import { machineChecks } from './machine-checks'
import { profileChecks, profileInUse } from './profile-checks'
import { renderReport } from './render'
import type {
    CheckStatus,
    DoctorCheck,
    DoctorContext,
    DoctorDeps,
    DoctorInput,
    DoctorReport,
    ProfileFacts
} from './types'

const execFileAsync = promisify(execFile)

const DOCTOR_HTTP_TIMEOUT_MS = 10_000
const VERSION_TIMEOUT_MS = 3_000

const binaryVersion = async (invocation: string[]): Promise<string | null> => {
    try {
        const { stdout } = await execFileAsync(
            invocation[0],
            [...invocation.slice(1), '--version'],
            { timeout: VERSION_TIMEOUT_MS }
        )
        return String(stdout).trim().split('\n')[0]?.trim() || null
    } catch {
        return null
    }
}

export const defaultDoctorDeps = async (): Promise<DoctorDeps> => {
    const home = homedir()
    return {
        platform: process.platform,
        env: process.env,
        home,
        configDir: resolveConfigDir(),
        uid: process.getuid?.() ?? null,
        now: Date.now,
        fetch: globalThis.fetch,
        timeoutMs: Math.min(resolveHttpTimeoutMs(), DOCTOR_HTTP_TIMEOUT_MS),
        build: await collectBuildInfo(),
        stdinIsTty: Boolean(process.stdin.isTTY),
        readStdin: () => readFileSync(0, 'utf8'),
        unitDirs: initUnitDirs(process.platform, home),
        realpath: (path) => realpath(path),
        unitStatus: async (scope, profile) => {
            const info = await getInitUnitStatus(scope, profile)
            return { loaded: info.enabled, active: info.active }
        },
        daemonHealth: (socketPath) => queryDaemonHealth(socketPath),
        ptySupport: checkPtySupport,
        binaryVersion
    }
}

const mapLimit = async <T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>
): Promise<R[]> => {
    const results: R[] = new Array(items.length)
    let next = 0
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const index = next
            next += 1
            results[index] = await fn(items[index])
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, worker)
    )
    return results
}

const crashedProfile = (name: string, message: string): DoctorCheck => ({
    id: 'profile.config',
    scope: 'profile',
    profile: name,
    status: 'fail',
    title: 'profile',
    detail: `could not inspect this profile: ${message}`
})

export const runDoctor = async (
    deps: DoctorDeps,
    input: DoctorInput
): Promise<DoctorReport> => {
    const http = createHttpProbe(deps)
    const versions = createVersionProbe(deps)
    // Every probe has its own timeout; this guard only keeps a hung one from
    // holding the whole report.
    const budget = deps.timeoutMs * 3 + 10_000
    const names = await profilesToCheck(deps, input)
    const self =
        deps.build.installMethod === 'standalone'
            ? await deps
                  .realpath(deps.build.execPath)
                  .catch(() => deps.build.execPath)
            : null
    const [machine, gathered] = await Promise.all([
        withTimeout(gatherMachine(deps, input, http, self), budget),
        mapLimit(names, 8, (name) =>
            withTimeout(
                gatherProfile(name, input, self, deps, http, versions),
                budget
            ).then(
                (facts): ProfileFacts | { name: string; error: string } =>
                    facts,
                (err: unknown) => ({ name, error: (err as Error).message })
            )
        )
    ])
    const profiles = gathered.filter(
        (entry): entry is ProfileFacts => !('error' in entry)
    )
    const ctx: DoctorContext = {
        currentProfile: input.currentProfile,
        profileSource: input.profileSource,
        bakedChannel: deps.build.bakedChannel,
        platform: deps.platform,
        now: deps.now(),
        anyRegistration: profiles.some(
            (p) => p.registration.state !== 'missing'
        )
    }
    const checks: DoctorCheck[] = [
        ...machineChecks(machine, ctx),
        ...gathered.flatMap((entry) =>
            'error' in entry
                ? [crashedProfile(entry.name, entry.error)]
                : profileChecks(entry, profiles, machine, ctx)
        )
    ]
    const summary: Record<CheckStatus, number> = {
        pass: 0,
        warn: 0,
        fail: 0,
        skip: 0
    }
    for (const check of checks) summary[check.status] += 1
    const current = profiles.find((p) => p.current)
    return {
        schemaVersion: 1,
        ok: summary.fail === 0,
        summary,
        cli: deps.build,
        currentProfile: {
            name: input.currentProfile,
            source: input.profileSource,
            exists: current?.dirExists ?? false
        },
        profiles: gathered.map((entry) =>
            'error' in entry
                ? {
                      name: entry.name,
                      current: entry.name === input.currentProfile,
                      exists: false,
                      loggedIn: false,
                      daemonRegistered: false,
                      inUse: entry.name === input.currentProfile
                  }
                : {
                      name: entry.name,
                      current: entry.current,
                      exists: entry.dirExists,
                      loggedIn:
                          entry.config.state === 'ok' &&
                          typeof entry.config.value.token === 'string' &&
                          entry.config.value.token.trim() !== '',
                      daemonRegistered: entry.registration.state !== 'missing',
                      inUse: profileInUse(entry)
                  }
        ),
        checks
    }
}

const doctorInput = (program: Command): DoctorInput => {
    const root = program.opts<{ apiUrl?: string; token?: string }>()
    const input: DoctorInput = {
        currentProfile: resolveProfile(),
        profileSource: resolveProfileSource()
    }
    // --api-url and --token default to MF_API_URL / MF_TOKEN (program.ts),
    // so the value source tells a flag from the environment.
    const apiUrl = root.apiUrl?.trim()
    if (apiUrl)
        input.apiUrl = {
            value: apiUrl,
            source:
                program.getOptionValueSource('apiUrl') === 'cli'
                    ? 'flag'
                    : 'MF_API_URL'
        }
    const token = root.token?.trim()
    const runtimeToken = process.env.MF_API_TOKEN?.trim()
    if (token)
        input.token = {
            value: token,
            source:
                program.getOptionValueSource('token') === 'cli'
                    ? 'flag'
                    : 'MF_TOKEN'
        }
    else if (runtimeToken)
        input.token = { value: runtimeToken, source: 'MF_API_TOKEN' }
    return input
}

export const registerDoctor = (program: Command): void => {
    jsonOption(
        program
            .command('doctor')
            .description(
                "Diagnose this machine's mf setup: the install, every profile's sign-in and API, and local daemons"
            )
    ).action(async (opts: { json?: boolean }) => {
        const report = await runDoctor(
            await defaultDoctorDeps(),
            doctorInput(program)
        )
        emit(opts, report, () => console.log(renderReport(report)))
        // A report with failed checks is still a report: it goes to stdout
        // like a success, and only the exit code says something failed.
        if (!report.ok) process.exitCode = 1
    })
}
