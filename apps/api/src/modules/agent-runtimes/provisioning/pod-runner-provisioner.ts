import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Database } from '@manyfold/db'
import {
    buildPodRunnerEnv,
    supportsRuntime,
    frameworkCapability,
    podRunnerHostName,
    type AgentFramework
} from '@manyfold/shared'
import { publicApiUrlWithApiPrefix } from '@/common/public-api-url'
import { DaemonTokenService } from '@/modules/daemon/daemon-token.service'

export interface PodRunnerProvision {
    // Merged into the pod's env Secret.
    env: Record<string, string>
    // So a failed provision can discard a credential the pod never bound.
    tokenId: string
}

// Every supported Pod needs a persistent daemon registration before it can chat.
@Injectable()
export class PodRunnerProvisioner {
    private readonly log = new Logger(PodRunnerProvisioner.name)

    constructor(
        private readonly tokens: DaemonTokenService,
        private readonly config: ConfigService
    ) {}

    supports(framework: AgentFramework): boolean {
        return supportsRuntime(framework, 'k8s')
    }

    async mint(
        args: {
            userId: string
            runtimeId: string
            framework: AgentFramework
            // The image's manyfold home root; for coding images this is the PVC
            // mount path, which is what puts the daemon's uuid on durable storage.
            homeRoot: string
        },
        db?: Pick<Database, 'insert'>
    ): Promise<PodRunnerProvision | null> {
        if (!this.supports(args.framework)) return null
        const apiBaseUrl = this.config.get<string>('PUBLIC_API_BASE_URL')
        if (!apiBaseUrl) throw new BadRequestException('PUBLIC_API_BASE_URL is required for the Pod daemon runner')

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
                // it from the runtime id, so it is not carried on the result.
                name: podRunnerHostName(args.runtimeId),
                purpose: 'pod_runner'
            },
            db
        )
        return {
            env: buildPodRunnerEnv({
                apiBaseUrl: publicApiUrlWithApiPrefix(apiBaseUrl),
                daemonToken: minted.plaintext,
                runtimeId: args.runtimeId,
                homeRoot: frameworkCapability(args.framework).kind === 'coding'
                    ? args.homeRoot : `${args.homeRoot}/.manyfold-runner`,
                ...(frameworkCapability(args.framework).kind === 'coding' ? {} : { workspaceRoot: args.homeRoot })
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
