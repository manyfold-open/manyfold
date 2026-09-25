import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    createDb,
    daemonTokens,
    runtimeHosts,
    users,
    type Database
} from '@manyfold/db'
import { podRunnerHostName, runnerHostName } from '@manyfold/shared'
import { AgentRuntimesService } from '../src/modules/agent-runtimes/agent-runtimes.service'
import { deletePodRunnerHostForPodHost } from '../src/modules/agent-runtimes/sprite-runner-teardown'
import { K8sProvisioner } from '../src/modules/agent-runtimes/provisioning/k8s-provisioner'
import type { TelemetryService } from '../src/common/telemetry/telemetry.service'

// A sprite-runner lives on its OWN managed daemon host (host_id null,
// daemon_id-scoped runtimes), so the host_id-scoped sandbox emptiness check
// cannot see it: deleting/reaping the sandbox VM stranded the runner host, its
// runtimes and any agent reconcile adopted onto them (7 such hosts + 22 runtimes
// found live in prod on 2026-09-07). This proves deleteSandboxHost now removes
// the runner together with its VM — and that the FK cascades (agent via
// runtime, token via host) fire — which a fake-db suite structurally cannot
// test. Closes its postgres-js pool in `finally`, so the runner exits on its
// own (no force-exit flag). Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
const RUN = process.env.RUN_PG_E2E === '1'

const svc = (db: Database): AgentRuntimesService =>
    new AgentRuntimesService(db, {
        event: () => {}
    } as unknown as TelemetryService)

test(
    'deleteSandboxHost tears down the sprite-runner host bound to the same VM',
    { skip: !RUN },
    async () => {
        const url = process.env.DATABASE_URL
        assert.ok(url, 'DATABASE_URL must be set')
        const db = createDb(url)
        const sfx = randomBytes(8).toString('hex')
        const id = (n: string): string => `${n}_${sfx}`
        const sprite = `sbx-${sfx}`
        const otherSprite = `sbx-other-${sfx}`
        const userId = id('user')
        const otherUserId = id('user_other')

        try {
            await db.insert(users).values([
                { id: userId, email: `${sfx}@pgtest.local` },
                { id: otherUserId, email: `other-${sfx}@pgtest.local` }
            ])

            // The sandbox VM host (host_id-scoped world).
            await db.insert(runtimeHosts).values({
                id: id('sbx'),
                userId,
                kind: 'sandbox',
                name: 'sandbox-1',
                spriteName: sprite
            })

            // The sprite-runner on that VM, plus two look-alike runners that must
            // survive: one for a different sprite (same user → name scoping) and
            // one for a different user with the SAME name (user scoping).
            await db.insert(runtimeHosts).values([
                {
                    id: id('runner'),
                    userId,
                    kind: 'daemon',
                    managed: true,
                    name: runnerHostName(sprite),
                    hostname: sprite
                },
                {
                    id: id('runner_other_sprite'),
                    userId,
                    kind: 'daemon',
                    managed: true,
                    name: runnerHostName(otherSprite),
                    hostname: otherSprite
                },
                {
                    id: id('runner_other_user'),
                    userId: otherUserId,
                    kind: 'daemon',
                    managed: true,
                    name: runnerHostName(sprite),
                    hostname: sprite
                }
            ])

            // Under the target runner: a coding runtime and a service runtime,
            // the latter carrying an adopted phantom `main` agent + a token.
            await db.insert(agentRuntimes).values([
                {
                    id: id('rt_codex'),
                    userId,
                    name: 'runner-codex',
                    framework: 'codex',
                    kind: 'daemon',
                    daemonId: id('runner')
                },
                {
                    id: id('rt_openclaw'),
                    userId,
                    name: 'runner-openclaw',
                    framework: 'openclaw',
                    kind: 'daemon',
                    daemonId: id('runner')
                },
                // The control runners' runtimes must survive.
                {
                    id: id('rt_other_sprite'),
                    userId,
                    name: 'runner-other-sprite-openclaw',
                    framework: 'openclaw',
                    kind: 'daemon',
                    daemonId: id('runner_other_sprite')
                }
            ])
            await db.insert(agents).values({
                id: id('agt_phantom'),
                userId,
                name: 'main',
                framework: 'openclaw',
                runtime: 'daemon',
                runtimeId: id('rt_openclaw'),
                internalId: 'main',
                daemonId: id('runner')
            })
            await db.insert(daemonTokens).values({
                id: id('tok'),
                userId,
                name: runnerHostName(sprite),
                tokenHash: id('hash'),
                daemonId: id('runner'),
                purpose: 'sprite_runner'
            })

            await svc(db).deleteSandboxHost(id('sbx'))

            const hosts = await db
                .select({ id: runtimeHosts.id })
                .from(runtimeHosts)
                .where(
                    inArray(runtimeHosts.id, [
                        id('sbx'),
                        id('runner'),
                        id('runner_other_sprite'),
                        id('runner_other_user')
                    ])
                )
            const hostIds = hosts.map((h) => h.id).sort()
            assert.deepEqual(
                hostIds,
                [id('runner_other_sprite'), id('runner_other_user')].sort(),
                'sandbox + its runner gone; the two look-alike runners survive'
            )

            const rts = await db
                .select({ id: agentRuntimes.id })
                .from(agentRuntimes)
                .where(
                    inArray(agentRuntimes.id, [
                        id('rt_codex'),
                        id('rt_openclaw'),
                        id('rt_other_sprite')
                    ])
                )
            assert.deepEqual(
                rts.map((r) => r.id),
                [id('rt_other_sprite')],
                'both runner runtimes gone; the control runtime survives'
            )

            const phantom = await db
                .select({ id: agents.id })
                .from(agents)
                .where(eq(agents.id, id('agt_phantom')))
            assert.equal(
                phantom.length,
                0,
                'the adopted phantom agent cascades with its runtime'
            )

            const tok = await db
                .select({ id: daemonTokens.id })
                .from(daemonTokens)
                .where(eq(daemonTokens.id, id('tok')))
            assert.equal(
                tok.length,
                0,
                'the runner token cascades with its host'
            )
        } finally {
            // users cascade removes every seeded row (hosts, runtimes, agents,
            // tokens) whether or not the assertions reached them.
            await db
                .delete(users)
                .where(inArray(users.id, [userId, otherUserId]))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
)

// The pod twin of the case above, and it strands the same way: a pod-runner is
// its own managed daemon host keyed by POD HOST id, so deleting the pod host
// row alone would leave the runner, its runtimes and any agent on them behind.
// The scoping controls are the same two that matter — another pod host's
// runner for the same user, and another user's runner with an identical name —
// because both are ways a name-keyed delete can reach too far.
test(
    "deletePodRunnerHostForPodHost removes only this pod host's runner",
    { skip: !RUN },
    async () => {
        const url = process.env.DATABASE_URL
        assert.ok(url, 'DATABASE_URL must be set')
        const db = createDb(url)
        const sfx = randomBytes(8).toString('hex')
        const id = (n: string): string => `${n}_${sfx}`
        const userId = id('user')
        const otherUserId = id('user_other')
        const podHostId = id('pdh')
        const otherPodHostId = id('pdh_other')

        try {
            await db.insert(users).values([
                { id: userId, email: `${sfx}@pgtest.local` },
                { id: otherUserId, email: `other-${sfx}@pgtest.local` }
            ])

            await db.insert(runtimeHosts).values([
                {
                    id: id('pod_runner'),
                    userId,
                    kind: 'daemon',
                    managed: true,
                    name: podRunnerHostName(podHostId)
                },
                {
                    id: id('pod_runner_other_host'),
                    userId,
                    kind: 'daemon',
                    managed: true,
                    name: podRunnerHostName(otherPodHostId)
                },
                {
                    id: id('pod_runner_other_user'),
                    userId: otherUserId,
                    kind: 'daemon',
                    managed: true,
                    name: podRunnerHostName(podHostId)
                }
            ])

            await db.insert(agentRuntimes).values([
                {
                    id: id('rt_pod_claude'),
                    userId,
                    name: 'pod-runner-claude',
                    framework: 'claude-code',
                    kind: 'daemon',
                    daemonId: id('pod_runner')
                },
                {
                    id: id('rt_pod_other'),
                    userId,
                    name: 'pod-runner-other-claude',
                    framework: 'claude-code',
                    kind: 'daemon',
                    daemonId: id('pod_runner_other_host')
                }
            ])
            await db.insert(agents).values({
                id: id('agt_pod'),
                userId,
                name: 'pod agent',
                framework: 'claude-code',
                runtime: 'daemon',
                runtimeId: id('rt_pod_claude'),
                internalId: id('agt_pod'),
                daemonId: id('pod_runner')
            })
            await db.insert(daemonTokens).values({
                id: id('tok_pod'),
                userId,
                name: podRunnerHostName(podHostId),
                tokenHash: id('hash_pod'),
                daemonId: id('pod_runner'),
                purpose: 'pod_runner'
            })

            await deletePodRunnerHostForPodHost(db, userId, podHostId)

            const hosts = await db
                .select({ id: runtimeHosts.id })
                .from(runtimeHosts)
                .where(
                    inArray(runtimeHosts.id, [
                        id('pod_runner'),
                        id('pod_runner_other_host'),
                        id('pod_runner_other_user')
                    ])
                )
            assert.deepEqual(
                hosts.map((h) => h.id).sort(),
                [
                    id('pod_runner_other_host'),
                    id('pod_runner_other_user')
                ].sort(),
                "this pod host's runner gone; the two look-alikes survive"
            )

            const rts = await db
                .select({ id: agentRuntimes.id })
                .from(agentRuntimes)
                .where(
                    inArray(agentRuntimes.id, [
                        id('rt_pod_claude'),
                        id('rt_pod_other')
                    ])
                )
            assert.deepEqual(
                rts.map((r) => r.id),
                [id('rt_pod_other')],
                'the runner runtime gone; the control runtime survives'
            )

            const agt = await db
                .select({ id: agents.id })
                .from(agents)
                .where(eq(agents.id, id('agt_pod')))
            assert.equal(agt.length, 0, 'the agent cascades with its runtime')

            const tok = await db
                .select({ id: daemonTokens.id })
                .from(daemonTokens)
                .where(eq(daemonTokens.id, id('tok_pod')))
            assert.equal(
                tok.length,
                0,
                'the pod runner token cascades with its host'
            )
        } finally {
            await db
                .delete(users)
                .where(inArray(users.id, [userId, otherUserId]))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
)

// A k8s runtime is one framework on a pod host (ADR-0035): the host's runner
// carries every framework runtime on it, so deleting one runtime leaves the
// runner alone, and only deleting the host takes it.
test(
    'deleting a k8s runtime keeps its pod host runner; deleting the host removes it',
    { skip: !RUN },
    async () => {
        const url = process.env.DATABASE_URL
        assert.ok(url, 'DATABASE_URL must be set')
        const db = createDb(url)
        const sfx = randomBytes(8).toString('hex')
        const id = (n: string): string => `${n}_${sfx}`
        const userId = id('user')
        const podHostId = id('pdh')

        try {
            await db
                .insert(users)
                .values({ id: userId, email: `${sfx}@pgtest.local` })
            await db.insert(runtimeHosts).values([
                {
                    id: podHostId,
                    userId,
                    kind: 'pod',
                    name: 'computer-001',
                    podStatus: 'ready'
                },
                {
                    id: id('pod_runner_svc'),
                    userId,
                    kind: 'daemon',
                    managed: true,
                    name: podRunnerHostName(podHostId)
                }
            ])
            await db.insert(agentRuntimes).values([
                {
                    id: id('art_claude'),
                    userId,
                    name: 'pod-claude',
                    framework: 'claude-code',
                    kind: 'k8s',
                    hostId: podHostId
                },
                {
                    id: id('art_codex'),
                    userId,
                    name: 'pod-codex',
                    framework: 'codex',
                    kind: 'k8s',
                    hostId: podHostId
                }
            ])
            await db.insert(daemonTokens).values({
                id: id('tok_svc'),
                userId,
                name: podRunnerHostName(podHostId),
                tokenHash: id('hash_svc'),
                daemonId: id('pod_runner_svc'),
                purpose: 'pod_runner'
            })

            await svc(db).delete(id('art_claude'))

            const afterRuntime = await db
                .select({ id: runtimeHosts.id })
                .from(runtimeHosts)
                .where(
                    inArray(runtimeHosts.id, [podHostId, id('pod_runner_svc')])
                )
            assert.deepEqual(
                afterRuntime.map((h) => h.id).sort(),
                [podHostId, id('pod_runner_svc')].sort(),
                'the pod host and its runner outlive one of its runtimes'
            )

            const [host] = await db
                .select()
                .from(runtimeHosts)
                .where(eq(runtimeHosts.id, podHostId))
            // No namespace: the host never reached Kubernetes, so teardown
            // has no object to delete and must not ask for a cluster client.
            const provisioner = new K8sProvisioner(
                db,
                {
                    getClient: () => {
                        throw new Error('no cluster for a host without objects')
                    }
                } as never,
                svc(db),
                {} as never,
                {} as never
            )
            await provisioner.teardownHost(host)

            const hosts = await db
                .select({ id: runtimeHosts.id })
                .from(runtimeHosts)
                .where(
                    inArray(runtimeHosts.id, [podHostId, id('pod_runner_svc')])
                )
            assert.equal(hosts.length, 0, 'the host and its runner are gone')
            const toks = await db
                .select({ id: daemonTokens.id })
                .from(daemonTokens)
                .where(eq(daemonTokens.id, id('tok_svc')))
            assert.equal(toks.length, 0, 'and the runner token with them')
            const rts = await db
                .select({ id: agentRuntimes.id })
                .from(agentRuntimes)
                .where(eq(agentRuntimes.hostId, podHostId))
            assert.equal(rts.length, 0, "and every runtime on the host")
        } finally {
            await db.delete(users).where(eq(users.id, userId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
)
