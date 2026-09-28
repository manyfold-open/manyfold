import { OFFICIAL_PROVIDER_BASE_URL } from '@manyfold/shared'
import type { ResolvedCodexCredentials } from '@/modules/agents/credentials/resolved-credentials'

// The platform provider a codex process runs on, chosen per exec: the key
// rides the exec's env and the endpoint its `-c` overrides, so neither is kept
// on the machine and a sign-in left there cannot take the process over. A chat
// turn and a TUI resumed in the terminal run on the same.
export const platformCodexEnvAndArgs = (
    cmd: string[],
    creds: Pick<ResolvedCodexCredentials, 'openaiApiKey' | 'openaiBaseUrl'>
): Record<string, string> => {
    const baseUrl =
        creds.openaiBaseUrl?.trim() || OFFICIAL_PROVIDER_BASE_URL.openai
    cmd.push(
        '-c',
        'model_provider="Manyfold"',
        '-c',
        'model_providers.Manyfold.name="Manyfold"',
        '-c',
        `model_providers.Manyfold.base_url=${tomlString(baseUrl)}`,
        '-c',
        'model_providers.Manyfold.wire_api="responses"',
        '-c',
        'model_providers.Manyfold.env_key="OPENAI_API_KEY"',
        '-c',
        'model_providers.Manyfold.requires_openai_auth=false'
    )
    return { OPENAI_API_KEY: creds.openaiApiKey }
}

const tomlString = (value: string): string =>
    `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
