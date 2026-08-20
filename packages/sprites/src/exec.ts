import { execSpriteStream } from './exec-stream'
import type { SpritesClient } from './client'
import type { ExecOptions, ExecResult, SpritesLogger } from './types'

export const execSprite = (
    client: SpritesClient,
    spriteName: string,
    opts: ExecOptions,
    logger?: SpritesLogger
): Promise<ExecResult> =>
    execSpriteStream(client, spriteName, opts, logger).result
