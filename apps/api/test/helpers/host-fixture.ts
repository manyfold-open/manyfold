import {
    hostDaemons,
    runtimeHosts,
    runtimeProviders,
    type Database,
    type HostDaemonRow,
    type RuntimeHostRow
} from '@manyfold/db'
import { CLI_AT_FLOOR } from './cli-floor'

// Postgres seeds for the host model (ADR-0036).

export const seedLocalHost = async (
    db: Database,
    input: {
        id: string
        userId: string
        name?: string
        homeDir?: string | null
        status?: RuntimeHostRow['status']
    }
): Promise<RuntimeHostRow> => {
    const [row] = await db
        .insert(runtimeHosts)
        .values({
            id: input.id,
            userId: input.userId,
            kind: 'local',
            name: input.name ?? `local-${input.id}`,
            status: input.status ?? 'ready',
            homeDir: input.homeDir ?? null
        })
        .returning()
    return row
}

export const seedSpritesProvider = async (
    db: Database,
    id: string
): Promise<string> => {
    await db
        .insert(runtimeProviders)
        .values({
            id,
            kind: 'sprites',
            name: id,
            credentialCiphertext: 'not-a-token',
            config: { orgSlug: 'test', orgId: 'test', tokenId: 'test' }
        })
        .onConflictDoNothing()
    return id
}

export const seedSpritesHost = async (
    db: Database,
    input: {
        id: string
        userId: string
        providerId: string
        spriteName?: string
        name?: string
        powerState?: RuntimeHostRow['powerState']
        homeDir?: string | null
        terminalEnabled?: boolean
    }
): Promise<RuntimeHostRow> => {
    const [row] = await db
        .insert(runtimeHosts)
        .values({
            id: input.id,
            userId: input.userId,
            kind: 'hosted',
            providerId: input.providerId,
            providerRef: {
                kind: 'sprites',
                spriteName: input.spriteName ?? `sprite-${input.id}`,
                spriteId: null
            },
            name: input.name ?? `sandbox-${input.id}`,
            status: 'ready',
            powerState: input.powerState ?? 'running',
            homeDir: input.homeDir ?? '/home/sprite',
            terminalEnabled: input.terminalEnabled ?? false
        })
        .returning()
    return row
}

export const seedHostDaemon = async (
    db: Database,
    input: {
        hostId: string
        userId: string
        online?: boolean
        cliVersion?: string | null
        clientFeatures?: string[]
        herdrVersion?: string | null
        terminalPty?: boolean | null
    }
): Promise<HostDaemonRow> => {
    const seen = input.online === false ? new Date(0) : new Date()
    const [row] = await db
        .insert(hostDaemons)
        .values({
            hostId: input.hostId,
            userId: input.userId,
            daemonUuid: `uuid-${input.hostId}`,
            cliVersion: input.cliVersion === undefined ? CLI_AT_FLOOR : input.cliVersion,
            clientFeatures: input.clientFeatures ?? [],
            herdrVersion: input.herdrVersion ?? null,
            terminalPty: input.terminalPty ?? null,
            lastSeenAt: seen,
            rpcInstanceId: 'api-test',
            rpcConnectionToken: `token-${input.hostId}`,
            rpcInbox: `inbox-${input.hostId}`,
            rpcConnectedAt: seen,
            rpcLastSeenAt: seen
        })
        .returning()
    return row
}

export const seedK8sProvider = async (
    db: Database,
    id: string
): Promise<string> => {
    await db
        .insert(runtimeProviders)
        .values({
            id,
            kind: 'k8s',
            name: id,
            credentialCiphertext: 'not-a-kubeconfig',
            config: {} as never
        })
        .onConflictDoNothing()
    return id
}

export const seedK8sHost = async (
    db: Database,
    input: {
        id: string
        userId: string
        providerId: string
        namespace?: string
        name?: string
        homeDir?: string | null
    }
): Promise<RuntimeHostRow> => {
    const [row] = await db
        .insert(runtimeHosts)
        .values({
            id: input.id,
            userId: input.userId,
            kind: 'hosted',
            providerId: input.providerId,
            providerRef: {
                kind: 'k8s',
                namespace: input.namespace ?? `ns-${input.id}`,
                ingressHost: null,
                podPhase: 'Running'
            },
            name: input.name ?? `pod-${input.id}`,
            status: 'ready',
            powerState: 'running',
            homeDir: input.homeDir ?? '/home/node'
        })
        .returning()
    return row
}
