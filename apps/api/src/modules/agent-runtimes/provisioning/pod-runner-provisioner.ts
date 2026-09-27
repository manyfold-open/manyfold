import { BadRequestException, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Database } from '@manyfold/db'
import { buildPodRunnerEnv, K8S_HOME_BASE } from '@manyfold/shared'
import { publicApiUrlWithApiPrefix } from '@/common/public-api-url'
import { DaemonTokenService } from '@/modules/daemon/daemon-token.service'

export interface PodRunnerProvision {
    // The whole of the pod host's env Secret.
    env: Record<string, string>
    tokenId: string
}

// Every pod host runs one daemon, which carries the turns of every framework
// runtime on it (ADR-0035); it has to register before any of them can chat.
// Its credential is minted BOUND to the host (ADR-0037 R5): the pod's boot
// loop can register onto that host and nothing else.
@Injectable()
export class PodRunnerProvisioner {
    constructor(
        private readonly tokens: DaemonTokenService,
        private readonly config: ConfigService
    ) {}

    async mint(
        args: { userId: string; hostId: string },
        db?: Pick<Database, 'insert'>
    ): Promise<PodRunnerProvision> {
        const apiBaseUrl = this.config.get<string>('PUBLIC_API_BASE_URL')
        if (!apiBaseUrl)
            throw new BadRequestException(
                'PUBLIC_API_BASE_URL is required for the pod host daemon'
            )

        // No expiry, deliberately. The daemon presents this token on every
        // websocket connect, and nothing re-mints it: a pod's registration
        // happens once, inside the pod, from a Secret that is never rewritten
        // with a fresh token. A TTL would therefore not rotate the credential —
        // it would simply switch the daemon off on the day it lapsed. The
        // token's real lifetime is the host's: deleting the host cascades it.
        const minted = await this.tokens.mint(
            {
                userId: args.userId,
                name: `daemon:${args.hostId}`,
                hostId: args.hostId
            },
            db
        )
        return {
            env: buildPodRunnerEnv({
                apiBaseUrl: publicApiUrlWithApiPrefix(apiBaseUrl),
                daemonToken: minted.plaintext,
                homeRoot: `${K8S_HOME_BASE}/.manyfold`
            }),
            tokenId: minted.tokenId
        }
    }
}
