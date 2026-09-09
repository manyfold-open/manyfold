import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
    buildPodRunnerEnv,
    frameworkCapability,
    podRunnerHostName,
    type AgentFramework
} from '@manyfold/shared'
import { publicApiUrlWithApiPrefix } from '@/common/public-api-url'
import { DaemonTokenService } from '@/modules/daemon/daemon-token.service'

// A pod runner's registration credential outlives nothing in particular — the
// pod consumes it once on first boot and reuses the daemon config afterwards —
// but a long-lived pod must still be able to re-register after a PVC wipe, so
// it gets the same 90-day TTL as a sprite runner's.
const TOKEN_TTL_DAYS = 90

export interface PodRunnerProvision {
    // Merged into the pod's env Secret.
    env: Record<string, string>
    // So a failed provision can discard a credential the pod never bound.
    tokenId: string
    hostName: string
}

// Bakes the credential that lets a k8s agent pod enrol its own `mf daemon`.
//
// Unlike a sprite runner there is no bring-up here: the binary is in the image
// and the entrypoint owns the process, so provisioning's whole job is to put a
// token, a profile and a host name in the Secret the pod already reads. If that
// does not happen the pod simply runs the framework alone and every turn takes
// the pod-exec path it took before pod runners existed — which is what makes
// this safe to bake unconditionally and gate only at dispatch.
@Injectable()
export class PodRunnerProvisioner {
    private readonly log = new Logger(PodRunnerProvisioner.name)

    constructor(
        private readonly tokens: DaemonTokenService,
        private readonly config: ConfigService
    ) {}

    // Service frameworks are deliberately excluded. Their real runtime is the
    // k8s row itself (the resident gateway IS the framework), so a daemon on
    // that pod would be a second surface onto the same instance — the shape
    // oss#192 had to unpick for sprite runners. Their turns also carry a `dir`
    // the daemon's containment check must accept, which needs a workspace
    // contract k8s service runtimes do not have yet.
    supports(framework: AgentFramework): boolean {
        return frameworkCapability(framework).kind === 'coding'
    }

    async mint(args: {
        userId: string
        runtimeId: string
        framework: AgentFramework
        // The image's manyfold home root; for coding images this is the PVC
        // mount path, which is what puts the daemon's uuid on durable storage.
        homeRoot: string
    }): Promise<PodRunnerProvision | null> {
        if (!this.supports(args.framework)) return null
        const apiBaseUrl = this.config.get<string>('PUBLIC_API_BASE_URL')
        // Without a reachable API there is nothing for the daemon to dial, so
        // the pod is better off with no credential than with one it cannot use.
        if (!apiBaseUrl) return null

        const hostName = podRunnerHostName(args.runtimeId)
        const minted = await this.tokens.mint({
            userId: args.userId,
            name: hostName,
            expiresInDays: TOKEN_TTL_DAYS,
            purpose: 'pod_runner'
        })
        return {
            env: buildPodRunnerEnv({
                apiBaseUrl: publicApiUrlWithApiPrefix(apiBaseUrl),
                daemonToken: minted.plaintext,
                runtimeId: args.runtimeId,
                homeRoot: args.homeRoot
            }),
            tokenId: minted.tokenId,
            hostName
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
