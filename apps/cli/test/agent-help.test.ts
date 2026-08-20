import test from 'node:test'
import assert from 'node:assert/strict'
import { grantableScopes } from '@manyfold/shared'
import {
    AGENT_HELP_TOPICS,
    buildAgentHelpEnvelope,
    renderAgentHelp,
    resolveAgentHelpTopic,
    suggestAgentHelpTopics
} from '../src/agent-help/helpers'
import { agentHelpDocs } from '../src/agent-help/docs'
import { MF_CLI_VERSION } from '../src/version'

test('resolveAgentHelpTopic: no words resolves to index', () => {
    assert.equal(resolveAgentHelpTopic([]), 'index')
})

test('resolveAgentHelpTopic: multi-word topics join with hyphen', () => {
    assert.equal(
        resolveAgentHelpTopic(['channels', 'create']),
        'channels-create'
    )
    assert.equal(resolveAgentHelpTopic(['model', 'config']), 'model-config')
})

test('resolveAgentHelpTopic: aliases map to canonical topics', () => {
    assert.equal(resolveAgentHelpTopic(['login']), 'auth')
    assert.equal(resolveAgentHelpTopic(['whoami']), 'auth')
    assert.equal(resolveAgentHelpTopic(['scopes']), 'auth')
    assert.equal(resolveAgentHelpTopic(['agents']), 'agent')
    assert.equal(resolveAgentHelpTopic(['agent-runtimes']), 'runtime')
})

test('resolveAgentHelpTopic: case-insensitive', () => {
    assert.equal(resolveAgentHelpTopic(['Channels']), 'channels')
})

test('resolveAgentHelpTopic: unknown topic returns null', () => {
    assert.equal(resolveAgentHelpTopic(['bogus']), null)
    assert.equal(resolveAgentHelpTopic(['channels', 'bogus']), null)
})

test('suggestAgentHelpTopics: prefix matches narrow the list', () => {
    const suggestions = suggestAgentHelpTopics(['chan'])
    assert.ok(suggestions.includes('channels'))
    assert.ok(suggestions.includes('channels-create'))
    assert.ok(!suggestions.includes('files'))
})

test('suggestAgentHelpTopics: no match returns all topics', () => {
    assert.deepEqual(suggestAgentHelpTopics(['zzz']), [...AGENT_HELP_TOPICS])
})

test('envelope carries topic, CLI version, topic list and content', () => {
    const envelope = buildAgentHelpEnvelope('channels', 'CONTENT')
    assert.deepEqual(Object.keys(envelope), [
        'topic',
        'cliVersion',
        'topics',
        'content'
    ])
    assert.equal(envelope.topic, 'channels')
    assert.equal(envelope.cliVersion, MF_CLI_VERSION)
    assert.deepEqual(envelope.topics, [...AGENT_HELP_TOPICS])
    assert.equal(envelope.content, 'CONTENT')
})

test('renderAgentHelp expands every grantable scope', () => {
    const rendered = renderAgentHelp('{{GRANTABLE_SCOPES}}')
    for (const scope of grantableScopes) assert.ok(rendered.includes(scope))
})

test('renderAgentHelp expands the topic list with every topic', () => {
    const rendered = renderAgentHelp('{{TOPIC_LIST}}')
    for (const topic of AGENT_HELP_TOPICS) {
        if (
            topic === 'index' ||
            topic === 'channels-create' ||
            topic === 'channels-send'
        )
            continue
        assert.ok(
            rendered.includes(`mf help ${topic} --agent`),
            `topic list missing ${topic}`
        )
    }
    assert.ok(rendered.includes('mf help --agent'))
    assert.ok(rendered.includes('mf help channels create --agent'))
    assert.ok(rendered.includes('mf help channels send --agent'))
})

test('renderAgentHelp throws on unresolved placeholders', () => {
    assert.throws(
        () => renderAgentHelp('{{NOT_A_PLACEHOLDER}}'),
        /unresolved placeholder/
    )
})

test('every topic doc renders without unresolved placeholders', () => {
    for (const topic of AGENT_HELP_TOPICS) {
        const rendered = renderAgentHelp(agentHelpDocs[topic])
        assert.ok(rendered.length > 0, `${topic} doc is empty`)
        assert.ok(
            !rendered.includes('{{'),
            `${topic} doc has unresolved placeholder`
        )
    }
})

test('safety contract: docs protect profile config and daemon state', () => {
    for (const topic of ['index', 'auth', 'safety'] as const) {
        const doc = agentHelpDocs[topic]
        assert.match(doc, /~\/\.manyfold\/profiles\/<name>\/config\.json/)
        assert.match(doc, /daemon/)
        assert.match(doc, /[Nn]ever print/)
    }
})

test('safety contract: consent URL is the only shareable artifact', () => {
    assert.match(agentHelpDocs.safety, /consent URL/)
    assert.match(agentHelpDocs.auth, /consent URL/)
    assert.match(agentHelpDocs.auth, /[Pp]ost exactly that URL/)
})

test('scope doctrine: auth ensure keeps existing grants', () => {
    for (const topic of ['index', 'auth', 'safety'] as const) {
        assert.match(agentHelpDocs[topic], /mf auth ensure/)
        assert.match(agentHelpDocs[topic], /existing permissions are\s+KEPT/)
    }
    // The new model never tells the agent to re-request the union of all
    // scopes; that was the replaced doctrine.
    assert.doesNotMatch(agentHelpDocs.auth, /REPLACES the prior grant/)
    assert.doesNotMatch(agentHelpDocs.index, /REPLACES the prior grant/)
})
