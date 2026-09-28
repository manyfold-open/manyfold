import type { AgentFramework, AgentModelConfigSource } from '@manyfold/shared'
import { AGY_MANAGED_HOST_ENV, OFFICIAL_PROVIDER_BASE_URL } from '@manyfold/shared'
import type { ExecResult } from '@manyfold/sprites'
import { BootstrapError } from '@/modules/agents/bootstrap/framework-bootstrap'
import {
    installFrameworkVersionOn,
    type FrameworkInstallRequest,
    type HostScriptRunner
} from '@/modules/agents/bootstrap/framework-version-install'
import { buildCodexConfigToml } from '@/modules/agents/credentials/codex-config-toml'
import { piAgentDirSetupScript } from '@/modules/agents/credentials/pi-agent-dir'
import type { ResolvedCodexCredentials } from '@/modules/agents/credentials/resolved-credentials'
import { shellQuote } from '@/modules/agents/workspace/workspace-preflight'

// The frameworks a pod host installs on demand (ADR-0035). Service frameworks
// (OpenClaw, Hermes, an edition's services) join once the host's daemon
// supervises in-pod services; until then a pod host refuses them.
const POD_HOST_FRAMEWORKS = [
    'claude-code',
    'codex',
    'gemini-cli',
    'pi',
    'antigravity-cli'
] as const
export type PodHostFramework = (typeof POD_HOST_FRAMEWORKS)[number]

export const isPodHostFramework = (
    framework: AgentFramework
): framework is PodHostFramework =>
    (POD_HOST_FRAMEWORKS as readonly string[]).includes(framework)

const SETUP_TIMEOUT_MS = 60_000

// A login-shell script run inside the pod by its daemon. A secret the script
// needs rides the exec's env: the daemon keeps a command's stdin in its exec
// buffer on disk, and its argv is in the pod's /proc, but never its env.
export interface PodScriptRunner extends HostScriptRunner {
    run(
        script: string,
        timeoutMs: number,
        env?: Record<string, string>
    ): Promise<ExecResult>
}

// What runs the script: a host session's exec through the daemon
// (ADR-0037 R6).
export interface PodScriptExec {
    run(req: {
        cmd: string[]
        stdin?: string
        env?: Record<string, string>
        timeoutMs: number
    }): Promise<ExecResult>
}

export const podScriptRunner = (
    exec: PodScriptExec,
    warn: HostScriptRunner['warn']
): PodScriptRunner => ({
    run: (script, timeoutMs, env) =>
        exec.run({
            cmd: ['bash', '-l', '-s'],
            stdin: `${script}\n`,
            ...(env ? { env } : {}),
            timeoutMs
        }),
    warn
})

// A step that writes a file holding a secret: the content is base64 in the
// step's env under `envName`, never in the script, and lands atomically,
// readable by its owner only. `pathExpr` is a shell word (quoted, or a
// "$HOME/…" the shell expands).
export const secretFileStep = (
    pathExpr: string,
    envName: string,
    content: string
): { script: string; env: Record<string, string> } => ({
    script: [
        'set -eu',
        `mkdir -p "$(dirname ${pathExpr})"`,
        'umask 077',
        `printf '%s' "$${envName}" | base64 -d > ${pathExpr}.tmp`,
        `mv -f ${pathExpr}.tmp ${pathExpr}`
    ].join('\n'),
    env: { [envName]: Buffer.from(content, 'utf8').toString('base64') }
})

export const runPodStep = async (
    runner: PodScriptRunner,
    step: string,
    script: string,
    options: { env?: Record<string, string>; timeoutMs?: number } = {}
): Promise<ExecResult> => {
    let result: ExecResult
    try {
        result = await runner.run(
            script,
            options.timeoutMs ?? SETUP_TIMEOUT_MS,
            options.env
        )
    } catch (err) {
        throw new BootstrapError(step, (err as Error).message, err)
    }
    if (result.exitCode !== 0)
        throw new BootstrapError(
            step,
            `${step} exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
        )
    return result
}

// What a framework runtime on a pod host needs before its first agent: its
// directories, its configuration, and its CLI at the resolved version. The
// same staged install a sprite uses (installFrameworkVersionOn); the steps
// around it mirror the sprite bootstraps, minus what a pod does elsewhere —
// skills and the context doc are written when an agent attaches. No provider
// key is written to the host: every turn carries its own (ADR-0035).
export const setUpPodFramework = async (args: {
    runner: PodScriptRunner
    framework: PodHostFramework
    workspaceBase: string
    credentials: unknown
    modelConfigSource: AgentModelConfigSource | null
    install: FrameworkInstallRequest
}): Promise<{ frameworkVersion: string | null }> => {
    const { runner, framework, workspaceBase } = args
    const platformCredentials = args.modelConfigSource !== 'runtime-local'
    const mkWorkspace = `mkdir -p ${shellQuote(workspaceBase)}`
    switch (framework) {
        case 'claude-code':
            await runPodStep(
                runner,
                'claude-code-setup-dirs',
                ['set -eu', mkWorkspace, 'mkdir -p "$HOME/.claude"'].join('\n')
            )
            break
        case 'gemini-cli':
            await runPodStep(
                runner,
                'gemini-cli-setup-dirs',
                ['set -eu', mkWorkspace, 'mkdir -p "$HOME/.gemini"'].join('\n')
            )
            break
        case 'pi':
            await runPodStep(
                runner,
                'pi-setup-dirs',
                [piAgentDirSetupScript(), mkWorkspace].join('\n')
            )
            break
        case 'antigravity-cli':
            await runPodStep(
                runner,
                'antigravity-setup-dirs',
                [
                    'set -eu',
                    mkWorkspace,
                    'mkdir -p "$HOME/.gemini/antigravity-cli"'
                ].join('\n')
            )
            break
        case 'codex': {
            const creds = args.credentials as ResolvedCodexCredentials | null
            // Runtime-local: the user signs in with their own ChatGPT plan on
            // the host, so no provider config.toml is pinned; `touch` keeps the
            // file for later MCP splices without truncating a sign-in's.
            const configToml = buildCodexConfigToml(
                creds?.openaiBaseUrl?.trim() || OFFICIAL_PROVIDER_BASE_URL.openai
            )
            await runPodStep(
                runner,
                'codex-setup-dirs',
                [
                    'set -eu',
                    mkWorkspace,
                    'mkdir -p "$HOME/.codex"',
                    platformCredentials
                        ? `cat > "$HOME/.codex/config.toml" <<'MF_CODEX_EOF'\n${configToml}\nMF_CODEX_EOF`
                        : 'touch "$HOME/.codex/config.toml"'
                ].join('\n')
            )
            break
        }
    }

    const frameworkVersion = await installFrameworkVersionOn(
        runner,
        args.install,
        framework
    )

    if (framework === 'pi')
        await runPodStep(runner, 'pi-verify', 'pi --version', {
            env: { PI_OFFLINE: '1' }
        })
    if (framework === 'antigravity-cli')
        await runPodStep(runner, 'antigravity-verify', 'agy --version', {
            env: { ...AGY_MANAGED_HOST_ENV }
        })
    return { frameworkVersion }
}

// A credential update for codex on a pod host: the config.toml rewrite a
// sprite gets (applyCodexCredentialsOnSprite), which carries the endpoint and
// the MCP servers. The key itself is not logged in — it rides each turn — and
// the other coding frameworks keep nothing a credential decides on the host.
export const applyCodexCredentialsOnPod = async (args: {
    runner: PodScriptRunner
    baseUrl?: string | null
    mcpToml?: string | null
    composioKey?: string | null
}): Promise<void> => {
    const configToml = buildCodexConfigToml(
        args.baseUrl?.trim() || OFFICIAL_PROVIDER_BASE_URL.openai,
        args.mcpToml,
        args.composioKey
    )
    // The toml can carry the Composio key.
    const step = secretFileStep(
        '"$HOME/.codex/config.toml"',
        'MF_CODEX_CONFIG_B64',
        configToml
    )
    await runPodStep(args.runner, 'codex-config', step.script, {
        env: step.env
    })
}
