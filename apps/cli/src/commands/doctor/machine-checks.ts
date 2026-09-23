import { dirname } from 'node:path'
import type { AuthWhoamiResponse } from '@manyfold/shared'
import { BINARY_FOR_FRAMEWORK } from '@/daemon/detect'
import { describeFailure, hostOf } from './describe'
import { isManyfoldHealth } from './gather'
import type {
    CheckId,
    CheckStatus,
    DoctorCheck,
    DoctorContext,
    MachineFacts
} from './types'

interface Extra {
    fix?: string
    data?: Record<string, unknown>
}

const machineCheck = (
    id: CheckId,
    title: string,
    status: CheckStatus,
    detail: string,
    extra: Extra = {}
): DoctorCheck => ({
    id,
    scope: 'machine',
    status,
    title,
    detail,
    ...(extra.fix ? { fix: extra.fix } : {}),
    ...(extra.data ? { data: extra.data } : {})
})

const updateCheck = ({ update }: MachineFacts): DoctorCheck => {
    const check = (status: CheckStatus, detail: string, extra?: Extra) =>
        machineCheck('cli.update', 'update', status, detail, extra)
    if (update.kind === 'skipped') return check('skip', update.reason)
    if (update.kind === 'error')
        return check('warn', `could not check for updates: ${update.message}`, {
            fix: 'check access to github.com, or run mf update --check later'
        })
    const data = {
        channel: update.channel,
        current: update.current,
        latest: update.latest,
        status: update.status
    }
    if (update.status === 'update')
        return check(
            'warn',
            `${update.latest} is available on the ${update.channel} channel (this is ${update.current})`,
            { fix: 'mf update', data }
        )
    if (update.status === 'ahead')
        return check(
            'pass',
            `${update.current} is ahead of the latest ${update.channel} release ${update.latest}`,
            { data }
        )
    return check('pass', `up to date (${update.current}, ${update.channel})`, {
        data
    })
}

const pathCheck = (facts: MachineFacts): DoctorCheck => {
    const check = (status: CheckStatus, detail: string, fix?: string) =>
        machineCheck('cli.path', 'PATH', status, detail, {
            fix,
            data: { self: facts.self, entries: facts.mfOnPath }
        })
    const execPath = facts.build.execPath
    if (!facts.self) return check('skip', 'source build run through node')
    const [first, ...others] = facts.mfOnPath
    if (!first)
        return check(
            'warn',
            `mf is not on your PATH (this binary is ${execPath})`,
            `add ${dirname(execPath)} to PATH`
        )
    if (first.realpath !== facts.self)
        return check(
            'warn',
            `mf on your PATH is ${first.path}, not this binary (${execPath})`,
            `remove ${first.path}, or put ${dirname(execPath)} first in PATH`
        )
    if (others.length > 0)
        return check(
            'warn',
            `other mf binaries on your PATH could shadow this one: ${others
                .map((entry) => entry.path)
                .join(', ')}`,
            `remove the ones you no longer use, e.g. ${others[0].path}`
        )
    return check('pass', `mf on your PATH is this binary (${first.path})`)
}

const identityOf = (
    body: unknown
): { label: string; data: Record<string, unknown> } => {
    const who = body as Partial<AuthWhoamiResponse> & {
        email?: string
        agentId?: string
    }
    if (who.kind === 'agent-runtime')
        return {
            label: `agent ${who.agentId}`,
            data: { kind: who.kind, agentId: who.agentId }
        }
    return {
        label: who.email ?? who.userId ?? 'an unknown identity',
        data: { kind: who.kind ?? null, email: who.email ?? null }
    }
}

const overridesCheck = ({ overrides }: MachineFacts): DoctorCheck => {
    const data = {
        apiUrlSource: overrides.apiUrl?.source ?? null,
        tokenSource: overrides.token?.source ?? null
    }
    const check = (status: CheckStatus, detail: string, extra: Extra = {}) =>
        machineCheck('config.overrides', 'overrides', status, detail, {
            ...extra,
            data: { ...data, ...extra.data }
        })
    if (!overrides.apiUrl && !overrides.token)
        return check(
            'pass',
            'no --api-url, --token, MF_API_URL, MF_TOKEN or MF_API_TOKEN in effect'
        )
    const tokenLabel =
        overrides.token?.source === 'flag' ? '--token' : overrides.token?.source
    const urlLabel =
        overrides.apiUrl?.source === 'flag' ? '--api-url' : 'MF_API_URL'
    if (overrides.stdinUnavailable)
        return check(
            'skip',
            `${tokenLabel} - reads the token from stdin, and there was none to read; pipe it in to check it`
        )
    const { probe, targetUrl } = overrides
    const host = hostOf(targetUrl)
    if (overrides.token) {
        if (probe?.kind === 'ok') {
            const identity = identityOf(probe.body)
            const shadow =
                overrides.token.source === 'MF_API_TOKEN'
                    ? ''
                    : "; it overrides every profile's stored sign-in in this shell"
            return check(
                'pass',
                `${tokenLabel} signs in to ${host} as ${identity.label}${shadow}`,
                { data: { identity: identity.data } }
            )
        }
        const reason =
            probe?.kind === 'error' && probe.status === 401
                ? `the token was rejected${
                      probe.serverMessage ? ` (${probe.serverMessage})` : ''
                  }`
                : probe
                  ? describeFailure(probe)
                  : 'no answer'
        const fix =
            overrides.token.source === 'MF_API_TOKEN'
                ? 'MF_API_TOKEN is injected by the platform; if it keeps failing, report it with the output of mf doctor --json'
                : overrides.token.source === 'MF_TOKEN'
                  ? 'unset MF_TOKEN to use the stored sign-in, or export a valid token'
                  : 'pass a valid token, or drop --token to use the stored sign-in'
        return check(
            'fail',
            `${tokenLabel} does not work against ${host}: ${reason}`,
            { fix }
        )
    }
    if (isManyfoldHealth(probe))
        return check('pass', `${urlLabel} points this shell at ${targetUrl}`)
    return check(
        'fail',
        `${urlLabel} points this shell at ${targetUrl}, which is not usable: ${
            probe ? describeFailure(probe) : 'no answer'
        }`,
        {
            fix: `${
                urlLabel === 'MF_API_URL'
                    ? 'unset MF_API_URL'
                    : 'drop --api-url'
            }, or point it at the API itself (it ends in /api)`
        }
    )
}

const terminalCheck = (
    facts: MachineFacts,
    ctx: DoctorContext
): DoctorCheck => {
    const check = (status: CheckStatus, detail: string, fix?: string) =>
        machineCheck('local.terminal', 'terminal', status, detail, { fix })
    if (ctx.platform === 'win32')
        return check(
            'skip',
            'Windows builds run the web terminal in a limited mode (no resize or job control)'
        )
    if ('backend' in facts.terminal)
        return check(
            'pass',
            `full terminal support (${
                facts.terminal.backend === 'bun' ? 'built-in pty' : 'node-pty'
            })`
        )
    const [headline, hint] = facts.terminal.problem
        .split('\n')
        .map((line) => line.trim().replace(/\.$/, ''))
    return check(
        'warn',
        `web terminals on this machine run in a limited mode: ${headline}`,
        hint ? `${hint}, then restart any running daemon` : undefined
    )
}

const frameworksCheck = (
    { frameworks }: MachineFacts,
    ctx: DoctorContext
): DoctorCheck => {
    const check = (status: CheckStatus, detail: string, fix?: string) =>
        machineCheck('local.frameworks', 'coding agents', status, detail, {
            fix,
            data: { found: frameworks }
        })
    if (frameworks.length > 0)
        return check(
            'pass',
            `on your PATH: ${frameworks
                .map((entry) => BINARY_FOR_FRAMEWORK[entry.framework])
                .join(', ')}`
        )
    if (!ctx.anyRegistration)
        return check(
            'skip',
            'no coding agent CLI on your PATH (only needed to run agents on this machine)'
        )
    return check(
        'warn',
        'no coding agent CLI (claude, codex, gemini, openclaw, hermes) is on your PATH, so the daemon here has nothing to run',
        'install one, such as Claude Code or Codex'
    )
}

const hooksCheck = ({ hooks, hooksError }: MachineFacts): DoctorCheck => {
    const check = (status: CheckStatus, detail: string, fix?: string) =>
        machineCheck('local.hooks', 'session hooks', status, detail, { fix })
    if (hooks === null)
        return hooksError
            ? check(
                  'warn',
                  `could not read the session hook files: ${hooksError}`
              )
            : check('skip', 'session hooks do not exist on Windows')
    if (hooks.length === 0)
        return check(
            'skip',
            'not installed (optional: mf daemon hooks install)'
        )
    const problems: string[] = []
    const fixes = new Set<string>()
    for (const hook of hooks) {
        if (hook.missingTarget) {
            problems.push(
                `the ${hook.framework} hook calls ${hook.missingTarget}, which no longer exists`
            )
            fixes.add('mf daemon hooks install')
        } else if (!hook.current) {
            problems.push(`the ${hook.framework} hook is an older version`)
            fixes.add('mf daemon hooks install')
        }
        if (hook.note) {
            problems.push(`${hook.framework}: ${hook.note}`)
            fixes.add('turn hooks back on in ~/.codex/config.toml')
        }
    }
    if (problems.length > 0)
        return check('warn', problems.join('; '), [...fixes].join('; '))
    return check(
        'pass',
        `installed for ${hooks.map((hook) => hook.framework).join(', ')}`
    )
}

export const machineChecks = (
    facts: MachineFacts,
    ctx: DoctorContext
): DoctorCheck[] => [
    updateCheck(facts),
    pathCheck(facts),
    overridesCheck(facts),
    terminalCheck(facts, ctx),
    frameworksCheck(facts, ctx),
    hooksCheck(facts)
]
