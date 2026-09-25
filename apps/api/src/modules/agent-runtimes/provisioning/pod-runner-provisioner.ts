import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Database } from '@manyfold/db'
import {
    buildPodRunnerEnv,
    K8S_HOME_BASE,
    podRunnerHostName
} from '@manyfold/shared'
import { publicApiUrlWithApiPrefix } from '@/common/public-api-url'
import { DaemonTokenService } from '@/modules/daemon/daemon-token.service'

export interface PodRunnerProvision {
    // The whole of the pod host's env Secret.
    env: Record<string, string>
    // So a failed provision can discard a credential the pod never bound.
    tokenId: string
}

// Every pod host runs one daemon, which carries the turns of every framework
// runtime on it (ADR-0035); it has to register before any of them can chat.
@Injectable()
export class PodRunnerProvisioner {
    private readonly log = new Logger(PodRunnerProvisioner.name)

    constructor(
        private readonly tokens: DaemonTokenService,
        private readonly config: ConfigService
    ) {}

    async mint(
        args: { userId: string; podHostId: string },
        db?: Pick<Database, 'insert'>
    ): Promise<PodRunnerProvision> {
        const apiBaseUrl = this.config.get<string>('PUBLIC_API_BASE_URL')
        if (!apiBaseUrl)
            throw new BadRequestException(
                'PUBLIC_API_BASE_URL is required for the pod host daemon'
            )

        // No expiry, deliberately. The daemon presents this token on every
        // websocket connect, and nothing re-mints it: a sprite runner is
        // re-registered by the API on each bring-up, but a pod's registration
        // happens once, inside the pod, from a Secret that is never rewritten
        // with a fresh token. A TTL would therefore not rotate the credential —
        // it would simply switch the runner off on the day it lapsed, and put
        // the daemon into a permanent 4401 reconnect loop. The token's real
        // lifetime is the host's: teardown deletes the host and the token
        // cascades with it, and admin revocation is available before then.
        const minted = await this.tokens.mint(
            {
                userId: args.userId,
                // The host name the pod will register under; teardown re-derives
                // it from the pod host id, so it is not carried on the result.
                name: podRunnerHostName(args.podHostId),
                purpose: 'pod_runner'
            },
            db
        )
        return {
            env: buildPodRunnerEnv({
                apiBaseUrl: publicApiUrlWithApiPrefix(apiBaseUrl),
                daemonToken: minted.plaintext,
                podHostId: args.podHostId,
                homeRoot: `${K8S_HOME_BASE}/.manyfold`
            }),
            tokenId: minted.tokenId
        }
    }

    // Rollback for a provision that failed before the pod could register. Only
    // ever deletes an UNBOUND token: if the pod did register, the credential is
    // the live runner's and deleting it would cut off a daemon that is already
    // online (the sprite runner learned this the hard way, #804's sibling).
    async discardUnbound(userId: string, tokenId: string): Promise<void> {
        try {
            await this.tokens.deleteUnbound({ tokenId, userId })
        } catch (err) {
            this.log.warn(
                `pod runner token cleanup failed token=${tokenId}: ${String(err)}`
            )
        }
    }
}
