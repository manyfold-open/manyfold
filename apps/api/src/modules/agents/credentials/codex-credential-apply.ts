import { OFFICIAL_PROVIDER_BASE_URL } from '@manyfold/shared'
import {
    execSprite,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { buildCodexConfigToml } from '@/modules/agents/credentials/codex-config-toml'

export interface CodexCredentialApplyArgs {
    client: SpritesClient
    spriteName: string
    apiKey: string
    baseUrl?: string | null
    // Stored global MCP config (raw [mcp_servers.*] TOML). Folded back in so a
    // credential re-apply never wipes the user's MCP servers.
    mcpToml?: string | null
    // Decrypted Composio consumer key for a linked connection. Injected as the
    // managed `composio` server so a credential re-apply never wipes it either.
    composioKey?: string | null
    logger: SpritesLogger
    timeoutMs?: number
}

export const applyCodexCredentialsOnSprite = async (
    args: CodexCredentialApplyArgs
): Promise<void> => {
    const baseUrl = args.baseUrl?.trim() || OFFICIAL_PROVIDER_BASE_URL.openai
    const configToml = buildCodexConfigToml(
        baseUrl,
        args.mcpToml,
        args.composioKey
    )
    const timeout = args.timeoutMs ?? 60_000

    const writeConfig = await execSprite(
        args.client,
        args.spriteName,
        {
            cmd: [
                'bash',
                '-lc',
                [
                    'set -eu',
                    `mkdir -p "$HOME/.codex"`,
                    `cat > "$HOME/.codex/config.toml" <<'MF_CODEX_EOF'\n${configToml}\nMF_CODEX_EOF`
                ].join('\n')
            ],
            stdin: '',
            timeoutMs: timeout
        },
        args.logger
    )
    if (writeConfig.exitCode !== 0)
        throw new Error(
            `codex config rewrite failed (${writeConfig.exitCode}): ${writeConfig.stderr.slice(0, 512)}`
        )

    const login = await execSprite(
        args.client,
        args.spriteName,
        {
            cmd: [
                'bash',
                '-lc',
                'printenv OPENAI_API_KEY | codex login --with-api-key'
            ],
            env: { OPENAI_API_KEY: args.apiKey },
            stdin: '',
            timeoutMs: timeout
        },
        args.logger
    )
    if (login.exitCode !== 0)
        throw new Error(
            `codex login failed (${login.exitCode}): ${login.stderr.slice(0, 512)}`
        )
}
