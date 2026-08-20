import type {
    CloudflarePagesProjectSummary,
    CloudflareResourceSection,
    CloudflareWorkerSummary
} from '@manyfold/shared'
import { Injectable, Logger } from '@nestjs/common'

const CF_API = 'https://api.cloudflare.com/client/v4'

export interface CloudflareAccount {
    id: string
    name: string
}

export interface CloudflareVerifyResult {
    valid: boolean
    accounts: CloudflareAccount[]
}

export interface CloudflareResources {
    tokenStatus: 'active' | 'invalid'
    workers: CloudflareResourceSection<CloudflareWorkerSummary>
    pages: CloudflareResourceSection<CloudflarePagesProjectSummary>
}

interface CloudflareWorkerPayload {
    id?: string
    modified_on?: string
}

interface CloudflarePagesProjectPayload {
    name?: string
    domains?: string[]
    production_branch?: string
    latest_deployment?: { modified_on?: string }
}

@Injectable()
export class CloudflareService {
    private readonly log = new Logger(CloudflareService.name)

    async verifyAndListAccounts(
        token: string
    ): Promise<CloudflareVerifyResult> {
        const verify = await this.call(token, '/user/tokens/verify')
        const status = (verify.result as { status?: string } | undefined)
            ?.status
        if (!verify.ok || status !== 'active')
            return { valid: false, accounts: [] }
        const accountsRes = await this.call(token, '/accounts?per_page=50')
        const list = Array.isArray(accountsRes.result)
            ? (accountsRes.result as CloudflareAccount[])
            : []
        const accounts = list
            .filter((a) => a && typeof a.id === 'string')
            .map((a) => ({ id: a.id, name: a.name ?? a.id }))
        return { valid: true, accounts }
    }

    async listResources(
        token: string,
        accountId: string
    ): Promise<CloudflareResources> {
        const account = encodeURIComponent(accountId)
        const [verify, workersRes, pagesRes] = await Promise.all([
            this.call(token, '/user/tokens/verify'),
            this.call(token, `/accounts/${account}/workers/scripts`),
            this.call(token, `/accounts/${account}/pages/projects`)
        ])
        const verifyStatus = (verify.result as { status?: string } | undefined)
            ?.status
        return {
            tokenStatus:
                verify.ok && verifyStatus === 'active' ? 'active' : 'invalid',
            workers: this.section(workersRes, (item: CloudflareWorkerPayload) =>
                item.id
                    ? { name: item.id, modifiedOn: item.modified_on ?? null }
                    : null
            ),
            pages: this.section(
                pagesRes,
                (item: CloudflarePagesProjectPayload) =>
                    item.name
                        ? {
                              name: item.name,
                              domains: item.domains ?? [],
                              latestDeployedAt:
                                  item.latest_deployment?.modified_on ?? null,
                              productionBranch: item.production_branch ?? null
                          }
                        : null
            )
        }
    }

    private section<P, T>(
        res: { ok: boolean; status?: number; result?: unknown },
        map: (item: P) => T | null
    ): CloudflareResourceSection<T> {
        if (!res.ok)
            return res.status === 403 || res.status === 401
                ? { status: 'forbidden' }
                : { status: 'error' }
        const list = Array.isArray(res.result) ? (res.result as P[]) : []
        return {
            status: 'ok',
            items: list.map(map).filter((item): item is T => item !== null)
        }
    }

    private async call(
        token: string,
        path: string
    ): Promise<{ ok: boolean; status?: number; result?: unknown }> {
        try {
            const res = await fetch(`${CF_API}${path}`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(15_000)
            })
            const body = (await res.json().catch(() => ({}))) as {
                success?: boolean
                result?: unknown
            }
            return {
                ok: res.ok && body.success === true,
                status: res.status,
                result: body.result
            }
        } catch (err) {
            this.log.warn(
                `cloudflare ${path} failed: ${(err as Error).message}`
            )
            return { ok: false }
        }
    }
}
