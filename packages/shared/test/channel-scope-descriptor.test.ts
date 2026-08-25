import assert from 'node:assert/strict'
import test from 'node:test'
import { describeChannelScope } from '../src/channels'

// The automation delivery picker labels destinations from persisted scope
// keys. These shapes are a compat contract with the providers' computeScopeKey
// (channel_sessions rows outlive code changes), so each documented shape must
// keep parsing to the same kind — a drift here mislabels saved destinations.
test('discord scope shapes', () => {
    assert.deepEqual(describeChannelScope('discord', 'discord:dm:user:U1'), {
        kind: 'dm',
        channelId: null,
        threadId: null,
        userId: 'U1'
    })
    assert.deepEqual(
        describeChannelScope('discord', 'discord:guild:G1:channel:C1'),
        { kind: 'channel', channelId: 'C1', threadId: null, userId: null }
    )
    assert.deepEqual(
        describeChannelScope(
            'discord',
            'discord:guild:G1:channel:C1:thread:T1'
        ),
        { kind: 'thread', channelId: 'C1', threadId: 'T1', userId: null }
    )
    assert.deepEqual(
        describeChannelScope('discord', 'discord:guild:G1:channel:C1:user:U2'),
        {
            kind: 'channel-user',
            channelId: 'C1',
            threadId: null,
            userId: 'U2'
        }
    )
})

test('slack scope shapes', () => {
    assert.deepEqual(describeChannelScope('slack', 'slack:T1:C1'), {
        kind: 'channel',
        channelId: 'C1',
        threadId: null,
        userId: null
    })
    assert.deepEqual(describeChannelScope('slack', 'slack:T1:C1:U1'), {
        kind: 'channel-user',
        channelId: 'C1',
        threadId: null,
        userId: 'U1'
    })
    assert.deepEqual(
        describeChannelScope('slack', 'slack:T1:C1:thread:1700.1'),
        { kind: 'thread', channelId: 'C1', threadId: '1700.1', userId: null }
    )
    // Slack DM conversations use D-prefixed ids; the same segment shape as a
    // per-user channel scope must still read as a DM.
    assert.deepEqual(describeChannelScope('slack', 'slack:T1:D1:U1'), {
        kind: 'dm',
        channelId: 'D1',
        threadId: null,
        userId: 'U1'
    })
    assert.deepEqual(
        describeChannelScope('slack', 'slack:T1:D1:U1:thread:1700.2'),
        { kind: 'dm', channelId: 'D1', threadId: '1700.2', userId: 'U1' }
    )
})

test('line scopes read their kind off the id prefix', () => {
    // LINE prefixes ids by source kind: U = user (so the chat is a 1:1),
    // C = group, R = multi-person room.
    assert.deepEqual(describeChannelScope('line', 'line:Uuser1:Uuser1'), {
        kind: 'dm',
        channelId: 'Uuser1',
        threadId: null,
        userId: 'Uuser1'
    })
    assert.deepEqual(describeChannelScope('line', 'line:Cgroup1:Uuser1'), {
        kind: 'channel-user',
        channelId: 'Cgroup1',
        threadId: null,
        userId: 'Uuser1'
    })
    assert.deepEqual(describeChannelScope('line', 'line:Cgroup1'), {
        kind: 'channel',
        channelId: 'Cgroup1',
        threadId: null,
        userId: null
    })
    assert.deepEqual(describeChannelScope('line', 'line:Rroom1:Uuser1'), {
        kind: 'channel-user',
        channelId: 'Rroom1',
        threadId: null,
        userId: 'Uuser1'
    })
})

test('unknown providers and malformed keys fall back to conversation', () => {
    const fallback = {
        kind: 'conversation',
        channelId: null,
        threadId: null,
        userId: null
    }
    assert.deepEqual(describeChannelScope('lark', 'lark:oc_1:ou_2'), fallback)
    assert.deepEqual(
        describeChannelScope('telegram', 'telegram:123:456'),
        fallback
    )
    assert.deepEqual(describeChannelScope('discord', 'discord:guild'), fallback)
    assert.deepEqual(describeChannelScope('discord', 'slack:T1:C1'), fallback)
    assert.deepEqual(describeChannelScope('slack', 'slack:T1'), fallback)
    assert.deepEqual(describeChannelScope('line', 'line:'), fallback)
    assert.deepEqual(describeChannelScope('fake', 'whatever'), fallback)
})
