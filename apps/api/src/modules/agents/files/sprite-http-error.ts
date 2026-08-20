import {
    BadGatewayException,
    BadRequestException,
    ConflictException,
    NotFoundException
} from '@nestjs/common'
import { SpritesError } from '@manyfold/sprites'

// A SpritesError thrown by a sprite filesystem/exec op is not an HttpException,
// so the global filter maps it to a generic 500 internal_error — hiding a
// downstream failure (revoked token, gone sprite, exec timeout) behind a
// meaningless error, as seen in the files/list 401 incident. Translate it at
// the files boundary the way netmindHttpError does for the auth boundary so
// callers get a typed, actionable code. auth/quota/transient are the runtime
// being unavailable to US, not the caller's own auth/quota problem, so they map
// to 502 runtime_unavailable rather than a 401/429 aimed at the caller.
export const spritesHttpError = (err: unknown): never => {
    if (!(err instanceof SpritesError)) throw err
    const message = err.message
    switch (err.code) {
        case 'not_found':
            throw new NotFoundException({ code: 'not_found', message })
        case 'conflict':
            throw new ConflictException({ code: 'conflict', message })
        case 'permanent':
            throw new BadRequestException({ code: 'bad_request', message })
        default:
            throw new BadGatewayException({
                code: 'runtime_unavailable',
                message: `agent runtime unavailable: ${message}`
            })
    }
}
