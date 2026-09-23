import { dirname } from 'node:path'
import type { AuthWhoamiResponse } from '@manyfold/shared'
import { DAEMON_MIN_CLI_VERSION } from '@manyfold/shared'
import { normalizeApiUrl } from '@/channel'
import type { DaemonLocalHealth } from '@/daemon/control'
import { BINARY_FOR_FRAMEWORK } from '@/daemon/detect'
import {
    ago,
    describeFailure,
    duration,
    hostOf,
    httpData,
    mfFor,
    networkWords,
    nonEmpty,
    plural
} from './describe'
import { hostSummaryOf, isManyfoldHealth } from './gather'
import type {
    CheckId,
    CheckStatus,
    DoctorCheck,
    DoctorContext,
    LogCause,
    MachineFacts,
    ProfileFacts,
    UnitFact
} from './types'

interface Extra {
    fix?: string
    data?: Record<string, unknown>
}

type Check = (status: CheckStatus, detail: string, extra?: Extra) => DoctorCheck

const checkFor =
    (p: ProfileFacts, id: CheckId, title: string): Check =>
    (status, detail, extra = {}) => ({
        id,
        scope: 'profile',
        profile: p.name,
        status,
        title,
        detail,
        ...(extra.fix ? { fix: extra.fix } : {}),
        ...(extra.data ? { data: extra.data } : {})
    })

const storedToken = (p: ProfileFacts): string | null =>
    p.config.state === 'ok' ? nonEmpty(p.config.value.token) : null

const loginUrl = (p: ProfileFacts): string | null =>
    p.config.state === 'ok' ? nonEmpty(p.config.value.apiUrl) : null

// A registration the daemon would actually start with.
const usableRegistration = (p: ProfileFacts) => {
    if (p.registration.state !== 'ok') return null
    const reg = p.registration.value
    const token = nonEmpty(reg.token)
    const apiUrl = nonEmpty(reg.apiUrl)
    if (!nonEmpty(reg.profile) || !nonEmpty(reg.channel)) return null
    if (!token?.startsWith('ldt_') || !apiUrl) return null
    return { ...reg, apiUrl }
}

const installedUnits = (p: ProfileFacts): UnitFact[] =>
    p.units ? [p.units.user, p.units.system].filter((u) => u.installed) : []

const scopeOf = (health: DaemonLocalHealth | null): 'user' | 'system' =>
    health?.startupMethod.endsWith('-system') ? 'system' : 'user'

const restartFix = (
    mf: string,
    scope: 'user' | 'system',
    sessions: number
): string => {
    const sudo = scope === 'system' ? 'sudo ' : ''
    const flag = scope === 'system' ? ' --system' : ''
    const ends =
        sessions > 0
            ? ` (this ends ${plural(sessions, 'running session')})`
            : ''
    return `${sudo}${mf} daemon stop${flag} && ${sudo}${mf} daemon start${flag}${ends}`
}

const reRegisterFix = (mf: string): string =>
    `issue a new token in Settings → Self-owned computers, then ${mf} daemon register --token -`

// `mf profile delete` refuses while the profile's daemon runs.
const removeProfileFix = (p: ProfileFacts, ctx: DoctorContext): string => {
    const remove = `mf profile delete ${p.name} --yes${
        p.name === 'default' ? ' --force' : ''
    }`
    return p.health || p.pid !== null
        ? `${mfFor(p.name, ctx)} daemon stop && ${remove}`
        : remove
}

const isLoopback = (url: string): boolean => {
    try {
        const host = new URL(url).hostname
        return (
            host === 'localhost' || host === '[::1]' || host.startsWith('127.')
        )
    } catch {
        return false
    }
}

const configCheck = (
    p: ProfileFacts,
    all: ProfileFacts[],
    ctx: DoctorContext
): DoctorCheck => {
    const check = checkFor(p, 'profile.config', 'profile')
    const mf = mfFor(p.name, ctx)
    const data = {
        path: p.paths.configPath,
        exists: p.dirExists,
        loggedIn: storedToken(p) !== null,
        apiUrl: loginUrl(p)
    }
    if (!p.dirExists) {
        if (!p.current)
            return check('skip', `no profile directory at ${p.paths.dir}`, {
                data
            })
        const others = all
            .filter((o) => o.name !== p.name && o.dirExists)
            .map((o) => o.name)
        if (ctx.profileSource !== 'channel-default')
            return check(
                'fail',
                `profile '${p.name}' does not exist (selected by ${
                    ctx.profileSource === 'flag' ? '--profile' : 'MF_PROFILE'
                })`,
                {
                    fix:
                        others.length > 0
                            ? `pick one of ${others.join(', ')}, or set this one up: ${mf} login`
                            : `set it up: ${mf} login`,
                    data
                }
            )
        if (others.length === 0)
            return check('fail', 'this machine is not set up yet', {
                fix: 'mf setup',
                data
            })
        const staging = ctx.bakedChannel === 'dev' && others.includes('staging')
        return check(
            'warn',
            `the default profile '${p.name}' is not set up; this machine has ${others.join(', ')}${
                staging
                    ? "; dev builds used 'staging' as their default before CLI 0.24"
                    : ''
            }`,
            {
                fix: staging
                    ? 'export MF_PROFILE=staging, or set this one up with mf login'
                    : 'pass --profile <name> or export MF_PROFILE=<name>, or set this one up with mf login',
                data
            }
        )
    }
    if (p.config.state === 'invalid')
        return check('fail', p.config.message, {
            fix: `fix or delete ${p.paths.configPath}, then ${mf} login`,
            data
        })
    if (storedToken(p))
        return check(
            'pass',
            `signed in to ${loginUrl(p) ?? p.apiUrl ?? 'the default API'}`,
            { data }
        )
    if (p.registration.state !== 'missing')
        return check('pass', 'daemon-only profile (no CLI sign-in)', { data })
    return check('warn', 'not signed in', { fix: `${mf} login`, data })
}

const octal = (mode: number): string => `0${mode.toString(8).padStart(3, '0')}`

const permissionsCheck = (p: ProfileFacts, ctx: DoctorContext): DoctorCheck => {
    const check = checkFor(p, 'profile.permissions', 'permissions')
    if (ctx.platform === 'win32') return check('skip', 'not checked on Windows')
    if (!p.dirExists) return check('skip', 'no profile directory')
    const issues = p.permissionIssues
    if (issues.length === 0)
        return check('pass', 'only you can read the profile files')
    const details = issues.map((issue) =>
        issue.kind === 'mode'
            ? `${issue.path} is ${octal(issue.mode ?? 0)} (want ${octal(issue.expected ?? 0)})`
            : `${issue.path} belongs to uid ${issue.uid}`
    )
    const byMode = (expected: number) =>
        issues
            .filter(
                (issue) => issue.kind === 'mode' && issue.expected === expected
            )
            .map((issue) => issue.path)
    const fixes = [
        byMode(0o700).length > 0 ? `chmod 700 ${byMode(0o700).join(' ')}` : '',
        byMode(0o600).length > 0 ? `chmod 600 ${byMode(0o600).join(' ')}` : '',
        issues.some((issue) => issue.kind === 'owner')
            ? `sudo chown -R "$(id -un)" ${p.paths.dir}`
            : ''
    ].filter(Boolean)
    return check('warn', details.join('; '), {
        fix: fixes.join(' && '),
        data: { issues }
    })
}

const apiCheck = (p: ProfileFacts, ctx: DoctorContext): DoctorCheck => {
    const check = checkFor(p, 'profile.api', 'API')
    const mf = mfFor(p.name, ctx)
    if (!p.apiUrl || !p.api)
        return check(
            'skip',
            'nothing to reach: no sign-in and no daemon registration'
        )
    const url = p.apiUrl
    const api = p.api
    const data = { apiUrl: url, ...httpData(api) }
    if (isManyfoldHealth(api))
        return api.body.db === 'ok'
            ? check('pass', `${url} is reachable`, {
                  data: { ...data, db: 'ok' }
              })
            : check('fail', `${url} answers, but its database is down`, {
                  fix: "the deployment's operator needs to bring its database back",
                  data: { ...data, db: api.body.db }
              })
    if (
        api.kind === 'network' &&
        api.code === 'network_refused' &&
        isLoopback(url)
    )
        return check('fail', `nothing is listening at ${url}`, {
            fix: `start that local deployment; if it is gone for good: ${removeProfileFix(p, ctx)}`,
            data
        })
    if (api.kind === 'network')
        return check('fail', `cannot reach ${url}: ${networkWords(api.code)}`, {
            fix: `check the network, and that ${hostOf(url)} is the deployment you mean (${mf} profile show)`,
            data
        })
    if (api.kind === 'error' && api.status >= 500)
        return check('fail', `${url} answered HTTP ${api.status}`, {
            fix: 'the deployment may be down; try again later',
            data
        })
    if (api.kind === 'redirect')
        return check(
            'fail',
            `${url} redirects to ${hostOf(api.location)}: a sign-in page or proxy sits in front of the API`,
            { fix: 'point the profile at the API origin itself', data }
        )
    const suggestion = p.apiSuggestion
    const viaLogin = loginUrl(p) !== null || storedToken(p) !== null
    return check(
        'fail',
        `${url} is not a Manyfold API: ${describeFailure(api)}`,
        {
            fix: suggestion
                ? viaLogin
                    ? `${mf} login --api-url ${suggestion}`
                    : `${mf} --api-url ${suggestion} daemon register --token -`
                : 'the URL must point at the API itself, which ends in /api (e.g. https://api.manyfold.ai/api)',
            data
        }
    )
}

const authRejection = (
    message: string | null,
    mf: string,
    url: string
): { detail: string; fix: string } => {
    const text = message ?? ''
    if (/account deactivated/i.test(text))
        return {
            detail: 'the account is deactivated',
            fix: "ask the deployment's admin to reactivate it"
        }
    if (/missing bearer token/i.test(text))
        return {
            detail: 'the API received no token: a proxy in front of it strips the Authorization header',
            fix: 'forward the Authorization header in the proxy'
        }
    if (/api token not found/i.test(text))
        return {
            detail: `${hostOf(url)} does not know the stored token; was this profile signed in to another deployment?`,
            fix: `${mf} login --api-url ${url}`
        }
    return {
        detail: `the stored sign-in was rejected${text ? ` (${text})` : ''}`,
        fix: `${mf} login`
    }
}

const authCheck = (p: ProfileFacts, ctx: DoctorContext): DoctorCheck => {
    const check = checkFor(p, 'profile.auth', 'sign-in')
    const mf = mfFor(p.name, ctx)
    if (!storedToken(p)) return check('skip', 'not signed in')
    if (!isManyfoldHealth(p.api) || !p.auth)
        return check('skip', 'the API check failed')
    const url = loginUrl(p) ?? p.apiUrl ?? ''
    const auth = p.auth
    const data = httpData(auth)
    if (auth.kind === 'ok') {
        const who = auth.body as Partial<AuthWhoamiResponse> & {
            email?: string
            agentId?: string
        }
        const label =
            who.kind === 'agent-runtime'
                ? `agent ${who.agentId} (agent runtime token)`
                : who.kind === 'legacy-runtime'
                  ? `${who.email} (legacy runtime token)`
                  : (who.email ?? who.userId ?? 'an unknown identity')
        return check('pass', `signed in as ${label}`, {
            data: {
                kind: who.kind ?? null,
                ...(who.email ? { email: who.email } : {}),
                ...(who.agentId ? { agentId: who.agentId } : {})
            }
        })
    }
    if (auth.kind === 'error' && auth.status === 401) {
        const rejection = authRejection(auth.serverMessage, mf, url)
        return check('fail', rejection.detail, { fix: rejection.fix, data })
    }
    if (auth.kind === 'error' && auth.status === 403)
        return check(
            'fail',
            `the API refused the stored token${
                auth.serverMessage ? ` (${auth.serverMessage})` : ''
            }`,
            { fix: `${mf} login`, data }
        )
    if (auth.kind === 'error' && auth.status >= 500)
        return check(
            'fail',
            `the API failed (HTTP ${auth.status}) while checking the sign-in`,
            { fix: 'try again later', data }
        )
    return check(
        'fail',
        `could not check the sign-in: ${describeFailure(auth)}`,
        { data }
    )
}

const registrationCheck = (
    p: ProfileFacts,
    ctx: DoctorContext
): DoctorCheck => {
    const check = checkFor(p, 'daemon.registration', 'registration')
    const mf = mfFor(p.name, ctx)
    if (p.registration.state === 'missing')
        return check('skip', 'no daemon registered in this profile')
    if (p.registration.state === 'invalid')
        return check('fail', p.registration.message, {
            fix: `delete ${p.paths.daemonConfigPath}, then ${reRegisterFix(mf)}`
        })
    const raw = p.registration.value
    if (!nonEmpty(raw.profile) || !nonEmpty(raw.channel))
        return check(
            'fail',
            'the registration predates per-profile state (CLI 0.21 and earlier), so the daemon refuses to start',
            { fix: reRegisterFix(mf) }
        )
    const reg = usableRegistration(p)
    if (!reg)
        return check(
            'fail',
            'the registration is incomplete: it has no daemon token or API URL',
            { fix: reRegisterFix(mf) }
        )
    const data = {
        daemonId: reg.daemonId ?? null,
        apiUrl: reg.apiUrl,
        channel: reg.channel ?? null
    }
    const problems: string[] = []
    if (reg.profile !== p.name)
        problems.push(`it was written for profile '${reg.profile}'`)
    const login = loginUrl(p)
    if (login && normalizeApiUrl(login) !== normalizeApiUrl(reg.apiUrl))
        problems.push(
            `the daemon serves ${reg.apiUrl} but this profile signs in to ${login}`
        )
    if (problems.length > 0)
        return check('warn', problems.join('; '), {
            fix: `if that is not intended, re-register with a token from ${hostOf(
                login ?? reg.apiUrl
            )}: ${mf} daemon register --token -, then restart the daemon`,
            data
        })
    return check(
        'pass',
        `registered as ${reg.daemonId} for ${reg.apiUrl}${
            reg.channel !== ctx.bakedChannel
                ? ` (from a ${reg.channel}-channel binary)`
                : ''
        }`,
        { data }
    )
}

const processCheck = (p: ProfileFacts, ctx: DoctorContext): DoctorCheck => {
    const check = checkFor(p, 'daemon.process', 'daemon')
    const mf = mfFor(p.name, ctx)
    const units = installedUnits(p)
    const data = {
        pid: p.health?.pid ?? p.pid,
        status: p.health?.status ?? null,
        startupMethod: p.health?.startupMethod ?? null,
        uptimeMs: p.health?.uptimeMs ?? null,
        units: units.map((unit) => ({
            scope: unit.scope,
            loaded: unit.loaded,
            active: unit.active
        }))
    }
    const health = p.health
    if (health) {
        if (health.status === 'starting' && health.uptimeMs > 120_000)
            return check(
                'warn',
                `stuck starting for ${duration(health.uptimeMs)}`,
                { fix: `${mf} daemon logs`, data }
            )
        return check(
            'pass',
            `${health.status} (pid ${health.pid}, up ${duration(
                health.uptimeMs
            )}, ${health.startupMethod})`,
            { data }
        )
    }
    if (p.pid !== null)
        return check(
            'warn',
            `pid ${p.pid} is alive but does not answer on its control socket: still starting, stuck, or a binary older than the health endpoint`,
            {
                fix: `${mf} daemon logs; if it stays this way: ${restartFix(mf, 'user', 0)}`,
                data
            }
        )
    const sys = units.some((unit) => unit.scope === 'system')
        ? ' (sudo … --system for the system unit)'
        : ''
    if (p.registration.state === 'missing') {
        if (units.length > 0)
            return check(
                'fail',
                'an autostart unit exists but this profile has no daemon registration, so the daemon exits at every start and is restarted forever',
                {
                    fix: `register it (${mf} daemon register --token -) or remove the unit (${mf} daemon stop${sys})`,
                    data
                }
            )
        return check('skip', 'no daemon in this profile', { data })
    }
    if (units.some((unit) => unit.loaded))
        return check(
            'fail',
            'the autostart unit is loaded but the daemon is not running: it exits right after it starts',
            {
                fix: `${mf} daemon logs, and the startup errors in ${p.paths.errLogPath}`,
                data
            }
        )
    if (units.length > 0)
        return check('warn', 'an autostart unit is installed but not loaded', {
            fix: `${mf} daemon start${sys}`,
            data
        })
    return check(
        'warn',
        'registered but not running; the workbench shows this machine offline',
        { fix: `${mf} daemon start`, data }
    )
}

const versionCheck = (p: ProfileFacts, ctx: DoctorContext): DoctorCheck => {
    const check = checkFor(p, 'daemon.version', 'daemon version')
    const health = p.health
    if (!health) return check('skip', 'the daemon is not running')
    const onDisk = p.onDisk
    if (!onDisk?.version)
        return check(
            'skip',
            'cannot tell which binary the daemon would restart into'
        )
    const data = {
        running: health.version,
        onDisk: onDisk.version,
        program: onDisk.path
    }
    if (onDisk.version === health.version)
        return check(
            'pass',
            `runs ${health.version}, the same as ${onDisk.path}`,
            { data }
        )
    if (health.updatePending)
        return check(
            'warn',
            `an update is pending: the daemon restarts into ${onDisk.version} once its ${plural(
                health.activeExecs,
                'running session'
            )} finish`,
            { data }
        )
    return check(
        'warn',
        `the daemon runs ${health.version} but ${onDisk.path} is now ${onDisk.version}; it keeps the old binary until it restarts`,
        {
            fix: restartFix(
                mfFor(p.name, ctx),
                scopeOf(health),
                health.activeExecs
            ),
            data
        }
    )
}

// What the latest disconnect says about a daemon that stays offline.
const closeCause = (
    cause: LogCause,
    regUrl: string,
    mf: string,
    restart: string
): { status: CheckStatus; detail: string; fix?: string } => {
    const host = hostOf(regUrl)
    if (cause.kind === 'unexpected-response')
        return {
            status: 'fail',
            detail: `the WebSocket upgrade to ${host} was answered with HTTP ${cause.status}: a proxy in front of the API does not pass WebSocket upgrades`,
            fix: `enable WebSocket upgrades for ${normalizeApiUrl(regUrl)}/daemon/ws in the proxy`
        }
    switch (cause.code) {
        case 4400:
            return {
                status: 'fail',
                detail: 'the API received the WebSocket without its token: a proxy strips the Authorization header on upgrades',
                fix: 'forward the Authorization header on WebSocket upgrades in the proxy'
            }
        case 4401:
        case 4403:
        case 4404:
        case 4409:
            return {
                status: 'fail',
                detail: `the API turned the daemon's registration away (WebSocket close ${cause.code})`,
                fix: reRegisterFix(mf)
            }
        case 4406:
            return {
                status: 'fail',
                detail: `the API requires mf ${DAEMON_MIN_CLI_VERSION} or newer for daemons`,
                fix: `mf update, then ${restart}`
            }
        case 4408:
            return {
                status: 'fail',
                detail: 'the daemon did not finish its handshake in time',
                fix: restart
            }
        case 4000:
            return {
                status: 'fail',
                detail: 'the connection keeps timing out (no pong within 35s); a proxy idle timeout may be cutting it',
                fix: 'raise the WebSocket idle timeout in the proxy'
            }
        case 1001:
        case 1012:
            return {
                status: 'warn',
                detail: 'the API restarted; the daemon reconnects on its own'
            }
        case 1011:
            return {
                status: 'fail',
                detail: 'the API failed while serving the connection',
                fix: 'try again later, and report it if it persists'
            }
        case 1015:
            return {
                status: 'fail',
                detail: 'the TLS handshake failed',
                fix: 'check the system clock and trusted certificates'
            }
        case 1006:
            return {
                status: 'fail',
                detail: cause.connectFailed
                    ? `the daemon cannot open its WebSocket to ${host}`
                    : 'the connection drops without a close frame: a network interruption, or a proxy that does not pass WebSockets',
                fix: 'check the network; a proxy in front of the API must pass WebSocket upgrades'
            }
        default:
            return {
                status: 'fail',
                detail: `the WebSocket closed with code ${cause.code}`,
                fix: `${mf} daemon logs`
            }
    }
}

const daemonTokenRejection = (message: string | null): string => {
    const text = message ?? ''
    if (/revoked/i.test(text)) return 'the daemon token was revoked'
    if (/expired/i.test(text)) return 'the daemon token expired'
    if (/not found|invalid token prefix/i.test(text))
        return 'the API does not know this daemon token'
    return 'the API rejected the daemon token'
}

const connectionCheck = (p: ProfileFacts, ctx: DoctorContext): DoctorCheck => {
    const check = checkFor(p, 'daemon.connection', 'connection')
    const mf = mfFor(p.name, ctx)
    if (p.registration.state === 'missing')
        return check('skip', 'no daemon registered in this profile')
    const reg = usableRegistration(p)
    if (!reg || !p.daemonMe)
        return check('skip', 'the registration cannot be used')
    const host = hostOf(reg.apiUrl)
    const me = p.daemonMe
    const summary = hostSummaryOf(me)
    const data = {
        online: summary?.online ?? null,
        status: summary?.status ?? null,
        lastSeenAt: summary?.lastSeenAt ?? null,
        wsConnected: p.health?.wsConnected ?? null,
        closeCode: p.logCause?.kind === 'close' ? p.logCause.code : null,
        ...httpData(me)
    }
    if (me.kind === 'error') {
        if (
            me.status === 401 &&
            /missing daemon token/i.test(me.serverMessage ?? '')
        )
            return check(
                'fail',
                `${host} received no daemon token: a proxy strips the Authorization header`,
                { fix: 'forward the Authorization header in the proxy', data }
            )
        if (me.status === 401)
            return check('fail', daemonTokenRejection(me.serverMessage), {
                fix: reRegisterFix(mf),
                data
            })
        if (me.status === 400 || me.status === 404)
            return check(
                'fail',
                `${host} no longer has this machine's registration`,
                { fix: reRegisterFix(mf), data }
            )
        return check(
            'fail',
            `${host} failed (HTTP ${me.status}) when asked about this daemon`,
            { fix: 'try again later', data }
        )
    }
    // One unreachable deployment is one finding, reported by profile.api.
    if (
        me.kind === 'network' &&
        p.api?.kind === 'network' &&
        p.apiUrl !== null &&
        normalizeApiUrl(p.apiUrl) === normalizeApiUrl(reg.apiUrl)
    )
        return check('skip', `${host} is unreachable (see API)`, { data })
    if (me.kind === 'network')
        return p.health
            ? check(
                  'fail',
                  `the daemon cannot reach ${host}: ${networkWords(me.code)}`,
                  {
                      fix: 'check the network and any proxy in front of the API',
                      data
                  }
              )
            : check(
                  'skip',
                  `the daemon is not running (and ${host} is unreachable: ${networkWords(me.code)})`,
                  { data }
              )
    if (!summary)
        return check(
            'fail',
            `${reg.apiUrl} is not a Manyfold API: ${describeFailure(me)}`,
            { fix: reRegisterFix(mf), data }
        )
    if (summary.status === 'revoked')
        return check(
            'fail',
            'this machine was revoked in Settings → Self-owned computers',
            { fix: reRegisterFix(mf), data }
        )
    const restart = restartFix(
        mf,
        scopeOf(p.health),
        p.health?.activeExecs ?? 0
    )
    if (summary.needsUpgrade)
        return check(
            'fail',
            `${host} requires a newer mf than ${summary.cliVersion ?? 'this daemon runs'}`,
            { fix: `mf update, then ${restart}`, data }
        )
    const lastSeen = ago(summary.lastSeenAt, ctx.now)
    if (!p.health)
        return check(
            'skip',
            `the daemon is not running${lastSeen ? `; ${host} last saw it ${lastSeen}` : ''}`,
            { data }
        )
    if (summary.online)
        return check(
            'pass',
            `online${lastSeen ? ` (last seen ${lastSeen})` : ''}`,
            { data }
        )
    if (p.health.wsConnected)
        return check(
            'warn',
            `connected, but ${host} does not list it online yet`,
            { fix: 'run mf doctor again in a minute', data }
        )
    if (p.logCause) {
        const cause = closeCause(p.logCause, reg.apiUrl, mf, restart)
        return check(cause.status, `offline: ${cause.detail}`, {
            fix: cause.fix,
            data
        })
    }
    const seenAt = summary.lastSeenAt ? Date.parse(summary.lastSeenAt) : NaN
    if (!Number.isNaN(seenAt) && ctx.now - seenAt < 60_000)
        return check(
            'fail',
            'offline: heartbeats reach the API but the WebSocket does not, so a proxy in front of it does not pass WebSocket upgrades',
            {
                fix: `enable WebSocket upgrades for ${normalizeApiUrl(reg.apiUrl)}/daemon/ws in the proxy`,
                data
            }
        )
    return check('fail', 'running but offline', {
        fix: `${mf} daemon logs`,
        data
    })
}

const autostartCheck = (
    p: ProfileFacts,
    machine: MachineFacts,
    ctx: DoctorContext
): DoctorCheck => {
    const check = checkFor(p, 'daemon.autostart', 'autostart')
    const mf = mfFor(p.name, ctx)
    if (!p.units) return check('skip', 'no autostart units on this platform')
    const units = installedUnits(p)
    const data = {
        units: units.map((unit) => ({
            scope: unit.scope,
            path: unit.path,
            loaded: unit.loaded,
            active: unit.active,
            program: unit.invocation?.[0] ?? null
        }))
    }
    if (units.length === 0) {
        if (p.registration.state === 'missing')
            return check('skip', 'no daemon in this profile', { data })
        return p.health
            ? check(
                  'warn',
                  'the daemon runs without an autostart unit: it does not come back after a reboot and does not update itself',
                  {
                      fix: `stop the foreground daemon, then ${mf} daemon start`,
                      data
                  }
              )
            : check(
                  'warn',
                  'no autostart unit: the daemon does not start on its own',
                  {
                      fix: `${mf} daemon start`,
                      data
                  }
              )
    }
    if (units.length > 1)
        return check(
            'warn',
            'both a user and a system unit are installed; one of them keeps failing with "already running"',
            {
                fix: `remove one: ${mf} daemon stop, or sudo ${mf} daemon stop --system`,
                data
            }
        )
    const unit = units[0]
    const program = unit.invocation?.[0]
    if (!program)
        return check('warn', `cannot read which program ${unit.path} runs`, {
            data
        })
    const restart = restartFix(mf, unit.scope, p.health?.activeExecs ?? 0)
    if (unit.programExists === false)
        return check(
            'fail',
            `the autostart unit runs ${program}, which no longer exists`,
            { fix: restart, data }
        )
    // Units written before they carried MF_CONFIG_DIR start their daemon on
    // the default dir, where this profile's registration is not.
    if (unit.configDir && unit.configDir !== machine.configDir)
        return check(
            'warn',
            `the autostart unit's daemon reads ${unit.configDir}, not ${machine.configDir} where this profile lives`,
            {
                fix: `${restart}, from a shell with the MF_CONFIG_DIR the daemon should use`,
                data: { ...data, unitConfigDir: unit.configDir }
            }
        )
    const onPath = machine.mfOnPath[0]
    if (
        machine.self &&
        onPath &&
        unit.programRealpath &&
        unit.programRealpath !== onPath.realpath
    )
        return check(
            'warn',
            `the autostart unit runs ${program} but mf on your PATH is ${onPath.path}; updating one does not update the other`,
            {
                fix: `${restart}, run with the mf the daemon should use`,
                data
            }
        )
    return check('pass', `${unit.scope} unit runs ${program}`, { data })
}

const frameworksCheck = (
    p: ProfileFacts,
    machine: MachineFacts,
    ctx: DoctorContext
): DoctorCheck => {
    const check = checkFor(p, 'daemon.frameworks', 'agent detection')
    const summary = hostSummaryOf(p.daemonMe)
    if (!summary || !p.health || !Array.isArray(summary.detectedFrameworks))
        return check('skip', 'no running daemon to compare with')
    if (machine.frameworks.length === 0)
        return check('skip', 'no coding agent CLI on your PATH')
    const detected = new Set(
        summary.detectedFrameworks.map((entry) => entry.framework)
    )
    const missing = machine.frameworks.filter(
        (entry) => !detected.has(entry.framework)
    )
    const names = (entries: typeof machine.frameworks) =>
        entries.map((entry) => BINARY_FOR_FRAMEWORK[entry.framework]).join(', ')
    const data = {
        missing: missing.map((entry) => entry.framework),
        daemon: [...detected]
    }
    if (missing.length === 0)
        return check('pass', `the daemon sees ${names(machine.frameworks)}`, {
            data
        })
    return check(
        'warn',
        `${names(missing)} ${missing.length === 1 ? 'is' : 'are'} on your PATH but the daemon has not detected ${
            missing.length === 1 ? 'it' : 'them'
        }; its autostart PATH may not include ${[
            ...new Set(missing.map((entry) => dirname(entry.path)))
        ].join(', ')}`,
        {
            fix: `restart it so it detects again: ${restartFix(
                mfFor(p.name, ctx),
                scopeOf(p.health),
                p.health.activeExecs
            )}`,
            data
        }
    )
}

export const profileInUse = (p: ProfileFacts): boolean =>
    p.current ||
    p.health !== null ||
    p.pid !== null ||
    installedUnits(p).length > 0

// A profile nobody uses (not current, no daemon, no unit) cannot fail the
// run: CLI sign-ins expire after 90 days and test deployments go away, and a
// forgotten profile should not turn every run red.
const capDormant = (
    p: ProfileFacts,
    ctx: DoctorContext,
    checks: DoctorCheck[]
): DoctorCheck[] => {
    if (profileInUse(p)) return checks
    const remove = removeProfileFix(p, ctx)
    return checks.map((check) =>
        check.status === 'fail'
            ? {
                  ...check,
                  status: 'warn',
                  fix: `${check.fix ? `${check.fix}; ` : ''}or, if you no longer use this profile: ${remove}`
              }
            : check
    )
}

export const profileChecks = (
    p: ProfileFacts,
    all: ProfileFacts[],
    machine: MachineFacts,
    ctx: DoctorContext
): DoctorCheck[] =>
    capDormant(p, ctx, [
        configCheck(p, all, ctx),
        permissionsCheck(p, ctx),
        apiCheck(p, ctx),
        authCheck(p, ctx),
        registrationCheck(p, ctx),
        processCheck(p, ctx),
        versionCheck(p, ctx),
        connectionCheck(p, ctx),
        autostartCheck(p, machine, ctx),
        frameworksCheck(p, machine, ctx)
    ])
