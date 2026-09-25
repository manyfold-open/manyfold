import type { AgentFramework, AgentModelConfigSource } from '@manyfold/shared'
import { OFFICIAL_PROVIDER_BASE_URL } from '@manyfold/shared'
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
import type { PodExec } from '@/modules/k8s/pod-exec'

// The frameworks a pod host installs on demand (ADR-0035). Service frameworks
// (OpenClaw, Hermes, an edition's services) join once the host's daemon
// supervises in-pod services; until then a pod host refuses them.
const POD_HOST_FRAMEWORKS = ['claude-code', 'codex', 'gemini-cli', 'pi'] as const
export type PodHostFramework = (typeof POD_HOST_FRAMEWORKS)[number]

export const isPodHostFramework = (
    framework: AgentFramework
): framework is PodHostFramework =>
    (POD_HOST_FRAMEWORKS as readonly string[]).includes(framework)

const SETUP_TIMEOUT_MS = 60_000

// A login-shell script run inside the pod. Pod exec carries no env, so a secret
// the script needs is exported at the top of its stdin — never on argv, which
// the pod's /proc exposes.
export interface PodScriptRunner extends HostScriptRunner {
    run(
        script: string,
        timeoutMs: number,
        env?: Record<string, string>
    ): Promise<ExecResult>
}

export const podScriptRunner = (
    exec: PodExec,
    warn: HostScriptRunner['warn']
): PodScriptRunner => ({
    run: (script, timeoutMs, env) =>
        exec.run({
            cmd: ['bash', '-l', '-s'],
            stdin: `${exportLines(env)}${script}\n`,
            timeoutMs
        }),
    warn
})

const exportLines = (env?: Record<string, string>): string =>
    Object.entries(env ?? {})
        .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
        .join('')

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
    await runPodStep(
        args.runner,
        'codex-config',
        [
            'set -eu',
            'mkdir -p "$HOME/.codex"',
            `cat > "$HOME/.codex/config.toml" <<'MF_CODEX_EOF'\n${configToml}\nMF_CODEX_EOF`
        ].join('\n')
    )
}
