import test from 'node:test'
import assert from 'node:assert/strict'
import { A2aService } from '../src/modules/a2a/a2a.service'

// The published Agent Card is what a third-party client reads BEFORE it can call
// anything, and the official A2A SDKs validate it against the v0.3.0 schema. Our
// own AgentCard/AgentSkill TypeScript types mark these fields optional, so a
// missing one type-checks and only breaks at the far end of an integration —
// external clients using the Python SDK cannot even discover the agent. These
// lists are the `required` arrays of AgentCard / AgentSkill in
// a2aproject/A2A@v0.3.0 specification/json/a2a.json.
const CARD_REQUIRED = [
    'capabilities',
    'defaultInputModes',
    'defaultOutputModes',
    'description',
    'name',
    'protocolVersion',
    'skills',
    'url',
    'version'
]
const SKILL_REQUIRED = ['description', 'id', 'name', 'tags']

const dbFake = (extras: Record<string, unknown>) =>
    ({
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [
                        { id: 'agt_t', name: 'mf-chat-main', extras }
                    ]
                })
            })
        })
    }) as never

const buildCard = async (
    extras: Record<string, unknown> = { a2aExposure: { enabled: true } }
): Promise<Record<string, unknown> | null> => {
    const svc = new A2aService(dbFake(extras), {} as never, {} as never)
    return (await svc.buildAgentCard(
        'agt_t',
        'https://api.example.com/api'
    )) as unknown as Record<string, unknown> | null
}

test('the agent card carries every field A2A v0.3.0 requires', async () => {
    const card = await buildCard()
    assert.ok(card, 'an exposed agent must publish a card')
    for (const key of CARD_REQUIRED)
        assert.ok(
            card[key] !== undefined && card[key] !== '',
            `AgentCard.${key} is required by the v0.3.0 schema`
        )
})

test('every published skill carries every field A2A v0.3.0 requires', async () => {
    const card = await buildCard()
    const skills = (card?.skills ?? []) as Array<Record<string, unknown>>
    assert.ok(skills.length > 0, 'the card must publish at least one skill')
    for (const skill of skills)
        for (const key of SKILL_REQUIRED)
            assert.ok(
                skill[key] !== undefined && skill[key] !== '',
                `AgentSkill.${key} is required by the v0.3.0 schema`
            )
    assert.ok(
        Array.isArray(skills[0].tags) &&
            (skills[0].tags as unknown[]).length > 0,
        'tags must be a non-empty array'
    )
})

test('an unexposed agent still publishes no card', async () => {
    assert.equal(await buildCard({}), null)
    assert.equal(await buildCard({ a2aExposure: { enabled: false } }), null)
})
