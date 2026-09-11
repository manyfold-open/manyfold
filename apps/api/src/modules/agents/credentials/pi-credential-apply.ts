import type { PiProvider } from '@manyfold/shared'
import {
    execSprite,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { piAgentDirReconcileScript } from '@/modules/agents/credentials/pi-models-json'

export interface PiCredentialApplyArgs {
    client: SpritesClient
    spriteName: string
    provider: PiProvider
    baseUrl?: string | null
    logger: SpritesLogger
    timeoutMs?: number
}

// The key itself never lands on the sprite (it rides every exec as env, see
// pi.adapter.ts); only the base-URL override is on-disk state, so a
// credential change is a models.json rewrite or removal.
export const applyPiCredentialsOnSprite = async (
    args: PiCredentialApplyArgs
): Promise<void> => {
    const result = await execSprite(
        args.client,
        args.spriteName,
        {
            cmd: [
                'bash',
                '-lc',
                piAgentDirReconcileScript(args.provider, args.baseUrl)
            ],
            stdin: '',
            timeoutMs: args.timeoutMs ?? 60_000
        },
        args.logger
    )
    if (result.exitCode !== 0)
        throw new Error(
            `pi models.json rewrite failed (${result.exitCode}): ${result.stderr.slice(0, 512)}`
        )
}
