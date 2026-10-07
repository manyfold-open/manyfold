import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import {
    DAEMON_FEATURE_TURN_ROUTE_ATTESTATION,
    isRouteNonce,
    routeAttestationMessage,
    type InferenceProtocol
} from '@manyfold/shared'
import { userModelProviders, type UserModelProviderRow } from '@manyfold/db'
import { HermesAdapter } from '../src/modules/chat/adapters/hermes.adapter'
import { OpenclawAdapter } from '../src/modules/chat/adapters/openclaw.adapter'
import { UsagePricingEngine } from '../src/modules/usage/usage-pricing.service'
import {
    UNKNOWN_PRICE_SCOPE,
    attestedPriceScope,
    routeReceiptFor,
    routeReceiptFromMetadata,
    type ServedPriceScope
} from '../src/modules/usage/served-price-scope'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// OpenClaw and Hermes pick their provider from the runtime's own config, so
// the API cannot know the route from the Agent's binding. It mints a nonce per
// turn, records what the bound row's key would answer, and prices by the
// daemon's answer for the route that actually served: a match is that row and
// its managed brand, anything else is no provider scope at all.

const GATEWAY = 'https://gateway.fixture.invalid/v1'
const KEY_A = 'fixture-brand-a-key'
const KEY_B = 'fixture-brand-b-key'
const rowA = {
    id: 'prv_brand_a',
    userId: 'user-1',
    source: 'managed',
    managedBrand: 'brand-a',
    builtInId: null,
    inferenceProtocol: 'openai_chat_completions',
    baseUrl: GATEWAY,
    apiKeyCiphertext: KEY_A,
    keyVersion: 1
} as unknown as UserModelProviderRow
const rowB = {
    ...rowA,
    id: 'prv_brand_b',
    managedBrand: 'brand-b',
    apiKeyCiphertext: KEY_B
} as unknown as UserModelProviderRow
const scopeA: ServedPriceScope = {
    modelProviderId: rowA.id,
    modelProviderBuiltInId: null,
    modelProviderManagedBrand: 'brand-a'
}
const scopeB: ServedPriceScope = {
    modelProviderId: rowB.id,
    modelProviderBuiltInId: null,
    modelProviderManagedBrand: 'brand-b'
}

// What the daemon answers for the route that served: the same message, keyed
// by whatever key that route really used.
const daemonAnswer = (
    nonce: string,
    key: string,
    protocol: InferenceProtocol = 'openai_chat_completions',
    baseUrl = 'https://gateway.fixture.invalid/v1/'
): string =>
    createHmac('sha256', key)
        .update(routeAttestationMessage({ nonce, protocol, baseUrl })!)
        .digest('hex')

// The same model under two brands at different prices, a row-level price on
// a third provider, and the public table underneath.
const makePricing = async () => {
    const price = (input: number) =>
        new Map([['shared-model', { override: { input_cost_per_token: input } }]])
    const pricing = new UsagePricingEngine({
        loadSnapshot: async (source) => ({
            prices: { 'shared-model': { input_cost_per_token: 0.000001 } },
            etag: source === 'litellm' ? '1:fixture' : '2:fixture',
            fetchedAt: new Date()
        }),
        loadPriceConfig: async () => ({
            overrides: new Map(),
            pins: new Map(),
            scopes: new Map([
                ['managed:brand-a', price(0.000007)],
                ['managed:brand-b', price(0.000003)],
                ['row:prv_priced', price(0.000009)]
            ])
        })
    })
    await pricing.ensureLoaded()
    return pricing
}

test('a receipt verifies only the answer of the bound row key on one of its endpoints', () => {
    const nonce = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
    const receipt = routeReceiptFor({ nonce, provider: rowA, providerApiKey: KEY_A })
    assert.equal(receipt.nonce, nonce)
    assert.deepEqual(receipt.scope, scopeA)
    assert.equal(JSON.stringify(receipt).includes(KEY_A), false)
    assert.deepEqual(attestedPriceScope(receipt, daemonAnswer(nonce, KEY_A)), {
        scope: scopeA,
        outcome: 'verified'
    })
    // OpenClaw speaks chat completions to an OpenAI-compatible endpoint even
    // when the row declares Responses; the wire family is the same route.
    const responsesRow = { ...rowA, inferenceProtocol: 'openai_responses' } as UserModelProviderRow
    assert.equal(
        attestedPriceScope(
            routeReceiptFor({ nonce, provider: responsesRow, providerApiKey: KEY_A }),
            daemonAnswer(nonce, KEY_A)
        ).outcome,
        'verified'
    )
    // The same endpoint and model under the other brand's key is not this row.
    assert.deepEqual(attestedPriceScope(receipt, daemonAnswer(nonce, KEY_B)), {
        scope: UNKNOWN_PRICE_SCOPE,
        outcome: 'mismatch'
    })
    assert.equal(
        attestedPriceScope(receipt, daemonAnswer(nonce, KEY_A, 'anthropic_messages')).outcome,
        'mismatch'
    )
    assert.equal(
        attestedPriceScope(receipt, daemonAnswer(nonce, KEY_A, 'openai_chat_completions', 'https://other.fixture.invalid/v1'))
            .outcome,
        'mismatch'
    )
    // An answer for another turn's nonce is useless here.
    assert.equal(
        attestedPriceScope(receipt, daemonAnswer('BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', KEY_A)).outcome,
        'mismatch'
    )
    assert.equal(attestedPriceScope(receipt, undefined).outcome, 'missing')
    assert.equal(attestedPriceScope(receipt, 'not-hex').outcome, 'missing')
    assert.equal(attestedPriceScope(null, daemonAnswer(nonce, KEY_A)).outcome, 'unsupported')
    const unbound = routeReceiptFor({ nonce, provider: null, providerApiKey: null })
    assert.deepEqual(unbound, { version: 1, nonce, scope: null, expected: [] })
    assert.equal(attestedPriceScope(unbound, daemonAnswer(nonce, KEY_A)).outcome, 'no_candidate')
    // A built-in row answers on its own endpoint table.
    const netmind = {
        ...rowA,
        id: 'prv_netmind',
        source: 'byo',
        managedBrand: null,
        builtInId: 'netmind',
        inferenceProtocol: null,
        baseUrl: null
    } as unknown as UserModelProviderRow
    assert.deepEqual(
        attestedPriceScope(
            routeReceiptFor({ nonce, provider: netmind, providerApiKey: KEY_A }),
            daemonAnswer(nonce, KEY_A, 'openai_chat_completions', 'https://api.netmind.ai/inference-api/openai/v1')
        ),
        {
            scope: {
                modelProviderId: 'prv_netmind',
                modelProviderBuiltInId: 'netmind',
                modelProviderManagedBrand: null
            },
            outcome: 'verified'
        }
    )
})

test('a stamped receipt reads back exactly, and a malformed one reads as none', () => {
    const nonce = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
    const receipt = routeReceiptFor({ nonce, provider: rowA, providerApiKey: KEY_A })
    const stored = JSON.parse(JSON.stringify({ model: 'shared-model', routeReceipt: receipt }))
    assert.deepEqual(routeReceiptFromMetadata(stored), receipt)
    for (const routeReceipt of [
        undefined,
        null,
        { ...receipt, version: 2 },
        { ...receipt, nonce: 'short' },
        { ...receipt, expected: ['zz'] },
        { ...receipt, expected: 'nope' }
    ])
        assert.equal(routeReceiptFromMetadata({ routeReceipt }), null)
    // A scope that names a brand but no row never prices as that brand.
    assert.equal(
        routeReceiptFromMetadata({
            routeReceipt: {
                ...receipt,
                scope: { modelProviderId: null, modelProviderBuiltInId: null, modelProviderManagedBrand: 'brand-a' }
            }
        })?.scope,
        null
    )
})

// --- Through the adapters ----------------------------------------------------

type Framework = 'openclaw' | 'hermes'

interface Served {
    // The key the runtime's route really used; null = the daemon answered
    // with a status instead of an attestation.
    key: string | null
    status?: string
}

const usageOf = (framework: Framework): Record<string, unknown> =>
    framework === 'openclaw'
        ? {
              usage: {
                  inputTokens: 1000000,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheCreationTokens: 0,
                  calls: 1,
                  model: 'shared-model',
                  provider: 'primary',
                  providers: ['primary']
              },
              usageStatus: 'ok'
          }
        : { result: { stopReason: 'end_turn', usage: { inputTokens: 1000000, outputTokens: 0 } } }

const harness = async (opts: {
    framework: Framework
    features: string[]
    bound: UserModelProviderRow | null
    served: Served
}) => {
    const rows: UserModelProviderRow[] = [rowA, rowB, { ...rowA, id: 'prv_priced', source: 'byo', managedBrand: null } as UserModelProviderRow]
    const state = {
        payloads: [] as Array<Record<string, unknown>>,
        stamps: [] as ServedPriceScope[],
        receipts: [] as unknown[],
        metadata: {} as Record<string, unknown>,
        served: opts.served
    }
    const db = {
        select: (projection?: Record<string, unknown>) => ({
            from: (table: unknown) => {
                const chain = {
                    innerJoin: () => chain,
                    leftJoin: () => chain,
                    where: () => chain,
                    limit: async () =>
                        projection && 'clientFeatures' in projection
                            ? [{ clientFeatures: opts.features }]
                            : table === userModelProviders
                              ? rows.filter((row) => row.id === opts.bound?.id)
                              : []
                }
                return chain
            }
        })
    }
    const crypto = { decrypt: (args: { ciphertext: string }) => args.ciphertext }
    const chatRepo = {
        updateFrameworkSessionRef: async () => {},
        stampTurnRouteReceipt: async (_m: string, _s: string, receipt: unknown) => {
            state.receipts.push(receipt)
            state.metadata = { ...state.metadata, routeReceipt: JSON.parse(JSON.stringify(receipt)) }
        },
        getMessageById: async () => ({ capabilityEventsJson: state.metadata })
    }
    const registry = {
        streamRpc: (args: { method: string; payload: Record<string, unknown>; refIdOverride?: string }) => {
            const turnPayload =
                args.method === 'turn.start' ? args.payload : (state.payloads.at(-1) ?? {})
            if (args.method === 'turn.start') state.payloads.push(args.payload)
            const nonce = turnPayload.routeNonce as string | undefined
            const answer =
                nonce === undefined
                    ? {}
                    : state.served.key
                      ? { routeAttestation: daemonAnswer(nonce, state.served.key) }
                      : { routeAttestationStatus: state.served.status ?? 'key_unresolved' }
            return {
                refId: args.refIdOverride ?? 'ref_fixture',
                result: Promise.resolve({
                    stopReason: 'end_turn',
                    sessionId: 'sess_fixture',
                    ...usageOf(opts.framework),
                    ...answer
                }),
                cancel: () => {}
            }
        }
    }
    const pricing = await makePricing()
    const adapter =
        opts.framework === 'openclaw'
            ? new OpenclawAdapter(
                  db as never,
                  crypto as never,
                  pricing as never,
                  chatRepo as never,
                  {} as never,
                  { event: () => {} } as never,
                  registry as never
              )
            : new HermesAdapter(
                  db as never,
                  crypto as never,
                  pricing as never,
                  registry as never,
                  chatRepo as never
              )
    const ctx = (extra: Record<string, unknown> = {}) =>
        ({
            userId: 'user-1',
            agentId: 'agt_1',
            runtimeId: 'art_1',
            sessionId: 'cts_1',
            messageId: 'msg_1',
            framework: opts.framework,
            runtimeKind: 'sprites',
            model: 'shared-model',
            modelOverride: null,
            // The binding the old code priced by: whatever it says, only the
            // daemon's answer decides the scope now.
            modelProviderId: opts.bound?.id ?? null,
            modelProviderBuiltInId: null,
            modelConfig: null,
            claudeCodePermissionMode: null,
            codexPermissionMode: null,
            hermesPermissionMode: null,
            openclawPermissionMode: null,
            frameworkSessionRef: null,
            history: [],
            onServedPriceScope: async (scope: ServedPriceScope) => {
                state.stamps.push(scope)
            },
            ...extra
        }) as unknown as ApiChatAdapterContext
    const send = async (): Promise<EmittedChatEvent[]> => {
        const a = adapter as unknown as Record<string, (...args: unknown[]) => AsyncIterable<EmittedChatEvent>>
        const it =
            opts.framework === 'openclaw'
                ? a.sendViaDaemonAcp!.call(adapter, ctx(), USER_MESSAGE, 'dh_runner', 'main')
                : a.sendViaTurnRpc!.call(adapter, ctx(), USER_MESSAGE, {
                      daemonId: 'dh_runner',
                      cwd: '/w',
                      env: {}
                  })
        return drain(it)
    }
    const resume = async (): Promise<EmittedChatEvent[]> =>
        drain(
            adapter.resumeMessage!(
                ctx({
                    modelProviderId: null,
                    daemonId: 'dh_runner',
                    daemonExecRef: 'msg_1',
                    fromSeq: 0
                }) as never
            )
        )
    return { state, send, resume }
}

const USER_MESSAGE = {
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hi' }]
} as never

const drain = async (it: AsyncIterable<EmittedChatEvent>): Promise<EmittedChatEvent[]> => {
    const out: EmittedChatEvent[] = []
    for await (const event of it) out.push(event)
    return out
}

const costOf = (events: EmittedChatEvent[]): number | null => {
    const usage = events.find((event) => event.type === 'usage')
    return usage?.type === 'usage' ? usage.usage.costUsd : null
}

const attesting = [DAEMON_FEATURE_TURN_ROUTE_ATTESTATION]

for (const framework of ['openclaw', 'hermes'] as const) {
    test(`${framework}: the bound brand's price applies only when the daemon proves its key served`, async () => {
        const verified = await harness({ framework, features: attesting, bound: rowA, served: { key: KEY_A } })
        const events = await verified.send()
        assert.equal(costOf(events), 7)
        assert.deepEqual(verified.state.stamps, [scopeA])
        const nonce = verified.state.payloads[0]!.routeNonce
        assert.ok(isRouteNonce(nonce))
        assert.ok(Buffer.from(nonce as string, 'base64url').length >= 16)
        assert.equal(JSON.stringify(verified.state.payloads[0]).includes(KEY_A), false)

        // Same model, same endpoint, the other brand's key in the runtime's
        // config: not the binding, so not its price — and not the other
        // brand's either, since nothing proved that one.
        const crossed = await harness({ framework, features: attesting, bound: rowA, served: { key: KEY_B } })
        assert.equal(costOf(await crossed.send()), 1)
        assert.deepEqual(crossed.state.stamps, [UNKNOWN_PRICE_SCOPE])
        assert.notDeepEqual(crossed.state.stamps[0], scopeB)

        const unproven = await harness({
            framework,
            features: attesting,
            bound: rowA,
            served: { key: null, status: 'config_changed' }
        })
        assert.equal(costOf(await unproven.send()), 1)
        assert.deepEqual(unproven.state.stamps, [UNKNOWN_PRICE_SCOPE])
    })

    test(`${framework}: a daemon without the feature gets no nonce and prices with no provider scope`, async () => {
        const old = await harness({ framework, features: [], bound: rowA, served: { key: KEY_A } })
        assert.equal(costOf(await old.send()), 1)
        assert.equal('routeNonce' in old.state.payloads[0]!, false)
        assert.deepEqual(old.state.receipts, [])
        // Stamped unknown before dispatch; the final settles the same.
        assert.deepEqual(old.state.stamps, [UNKNOWN_PRICE_SCOPE, UNKNOWN_PRICE_SCOPE])
    })

    test(`${framework}: every turn gets a fresh nonce`, async () => {
        const h = await harness({ framework, features: attesting, bound: rowA, served: { key: KEY_A } })
        await h.send()
        await h.send()
        const [first, second] = h.state.payloads.map((payload) => payload.routeNonce)
        assert.ok(isRouteNonce(first) && isRouteNonce(second))
        assert.notEqual(first, second)
    })

    test(`${framework}: a provider override still applies to the route it verifies`, async () => {
        const priced = { ...rowA, id: 'prv_priced', source: 'byo', managedBrand: null } as UserModelProviderRow
        const h = await harness({ framework, features: attesting, bound: priced, served: { key: KEY_A } })
        assert.equal(costOf(await h.send()), 9)
        // Bound to a priced row but served by another key: the row price that
        // used to apply from the binding alone does not.
        const stale = await harness({ framework, features: attesting, bound: priced, served: { key: KEY_B } })
        assert.equal(costOf(await stale.send()), 1)
    })

    test(`${framework}: a replay after the binding moved prices by the dispatch-time receipt`, async () => {
        const h = await harness({ framework, features: attesting, bound: rowA, served: { key: KEY_A } })
        // The live dispatch stamps its receipt; the API dies before the final.
        await h.send()
        assert.equal(h.state.receipts.length, 1)
        h.state.stamps.length = 0
        // The Agent is rebound to the other brand meanwhile; the replay must
        // not consult the binding at all.
        const replayed = await h.resume()
        assert.equal(costOf(replayed), 7)
        assert.deepEqual(h.state.stamps, [scopeA])
    })
}

test('a replay with no stamped receipt prices with no provider scope', async () => {
    for (const framework of ['openclaw', 'hermes'] as const) {
        const h = await harness({ framework, features: attesting, bound: rowA, served: { key: KEY_A } })
        // A turn dispatched before the feature existed: a final carrying an
        // attestation proves nothing without the receipt it answers.
        h.state.payloads.push({ routeNonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' })
        assert.equal(costOf(await h.resume()), 1)
        assert.deepEqual(h.state.stamps, [UNKNOWN_PRICE_SCOPE])
    }
})
