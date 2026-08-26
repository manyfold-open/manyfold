import type { WhatsappChannelConfig } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChannelRow } from '@manyfold/db'
import type { WAMessage } from 'baileys'
import type { ChannelsRepository } from '../src/modules/channels/channels.repository'
import type { CryptoService } from '../src/modules/secrets/crypto.service'
import type { NormalizedInboundEvent } from '../src/modules/channels/channel-provider'
import {
    WhatsappChannelProvider,
    isGroupJid,
    toWhatsappJid,
    whatsappIdentityMatches
} from '../src/modules/channels/providers/whatsapp.provider'
import { decodeMediaDescriptor } from '../src/modules/channels/providers/whatsapp-media'

const BOT_JID = '15550001111@s.whatsapp.net'
const USER_JID = '15557654321@s.whatsapp.net'
const GROUP_JID = '120363000000000000@g.us'

const makeChannel = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
    id: 'chn-whatsapp-1',
    userId: 'user-1',
    agentId: 'agent-1',
    provider: 'whatsapp',
    label: 'whatsapp test',
    status: 'active',
    configJson: {},
    credentialsCiphertext: null,
    keyVersion: 1,
    externalId: BOT_JID,
    origin: null,
    lastConnectedAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    reconnectAttempts: 0,
    nextReconnectAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
})

const baseConfig = (
    overrides: Partial<WhatsappChannelConfig> = {}
): WhatsappChannelConfig => ({
    botJid: BOT_JID,
    botName: 'Agent',
    allowedUserIds: [],
    operatorUserIds: [],
    allowedChatIds: [],
    mentionOnly: true,
    shareSessionInChannel: false,
    progressMode: 'final',
    outboundFiles: true,
    contextProjection: true,
    agentManagedReply: false,
    resetOnIdleMins: null,
    ...overrides
})

const makeProvider = (): WhatsappChannelProvider =>
    new WhatsappChannelProvider(
        {} as unknown as ChannelsRepository,
        {} as unknown as CryptoService
    )

const dmText = (text: string, overrides: Partial<WAMessage> = {}): WAMessage =>
    ({
        key: { remoteJid: USER_JID, fromMe: false, id: 'MSG1' },
        pushName: 'Casey',
        message: { conversation: text },
        ...overrides
    }) as WAMessage

const groupText = (
    text: string,
    opts: { mentioned?: string[]; participant?: string } = {}
): WAMessage =>
    ({
        key: {
            remoteJid: GROUP_JID,
            fromMe: false,
            id: 'MSG2',
            participant: opts.participant ?? USER_JID
        },
        pushName: 'Casey',
        message: {
            extendedTextMessage: {
                text,
                contextInfo: { mentionedJid: opts.mentioned ?? [] }
            }
        }
    }) as WAMessage

const normalize = (
    message: WAMessage,
    botJid: string | null = BOT_JID
): NormalizedInboundEvent | null =>
    makeProvider().normalizeInbound(message, botJid)

test('normalizes a direct message and always treats it as addressed', () => {
    const event = normalize(dmText('hello'))
    assert.ok(event)
    assert.equal(event.chatId, USER_JID)
    assert.equal(event.chatType, 'private')
    assert.equal(event.senderId, USER_JID)
    assert.equal(event.senderName, 'Casey')
    assert.equal(event.text, 'hello')
    // A DM has no mention to gate on; the bridge only applies mentionOnly to
    // group events, so a false here would silently drop every DM.
    assert.equal(event.isMention, true)
    assert.equal(event.providerEventId, `${USER_JID}|MSG1`)
})

test('drops own echoes, broadcasts and newsletters', () => {
    assert.equal(
        normalize(
            dmText('x', {
                key: { remoteJid: USER_JID, fromMe: true, id: 'MSG1' }
            } as Partial<WAMessage>)
        ),
        null
    )
    assert.equal(
        normalize(
            dmText('x', {
                key: {
                    remoteJid: 'status@broadcast',
                    fromMe: false,
                    id: 'MSG1'
                }
            } as Partial<WAMessage>)
        ),
        null
    )
    assert.equal(
        normalize(
            dmText('x', {
                key: {
                    remoteJid: '12345@newsletter',
                    fromMe: false,
                    id: 'MSG1'
                }
            } as Partial<WAMessage>)
        ),
        null
    )
})

test('drops protocol and reaction messages that carry no conversation', () => {
    assert.equal(
        normalize(
            dmText('', { message: { protocolMessage: { type: 0 } } } as Partial<WAMessage>)
        ),
        null
    )
    assert.equal(
        normalize(
            dmText('', {
                message: { reactionMessage: { text: '👍' } }
            } as Partial<WAMessage>)
        ),
        null
    )
})

test('group mention detection matches the bot jid, not the display name', () => {
    const notMentioned = normalize(groupText('hi everyone'))
    assert.ok(notMentioned)
    assert.equal(notMentioned.chatType, 'group')
    assert.equal(notMentioned.senderId, USER_JID)
    assert.equal(notMentioned.isMention, false)

    const mentioned = normalize(groupText('@agent hi', { mentioned: [BOT_JID] }))
    assert.equal(mentioned?.isMention, true)
})

test('a group reply to the bot counts as addressing it', () => {
    const message = {
        key: {
            remoteJid: GROUP_JID,
            fromMe: false,
            id: 'MSG3',
            participant: USER_JID
        },
        message: {
            extendedTextMessage: {
                text: 'thanks',
                contextInfo: { participant: BOT_JID, stanzaId: 'PRIOR' }
            }
        }
    } as unknown as WAMessage
    const event = normalize(message)
    assert.equal(event?.isMention, true)
    assert.equal(event?.replyToMessageId, 'PRIOR')
})

test('a channel with no paired identity never reads a mention as its own', () => {
    const event = normalize(groupText('@someone hi', { mentioned: [BOT_JID] }), null)
    assert.equal(event?.isMention, false)
})

test('prefers the phone-form participant so allowlists keep matching', () => {
    const message = {
        key: {
            remoteJid: GROUP_JID,
            fromMe: false,
            id: 'MSG4',
            participant: '99887766@lid',
            participantAlt: USER_JID
        },
        message: { conversation: 'hi' }
    } as unknown as WAMessage
    assert.equal(normalize(message)?.senderId, USER_JID)
})

test('unwraps ephemeral and view-once envelopes', () => {
    const message = dmText('', {
        message: {
            ephemeralMessage: {
                message: { conversation: 'disappearing hello' }
            }
        }
    } as Partial<WAMessage>)
    assert.equal(normalize(message)?.text, 'disappearing hello')
})

test('image messages become a downloadable descriptor, not a dead URL', () => {
    const message = dmText('', {
        message: {
            imageMessage: {
                mimetype: 'image/jpeg',
                caption: 'look',
                fileLength: 1234,
                mediaKey: new Uint8Array([1, 2, 3]),
                directPath: '/v/path'
            }
        }
    } as Partial<WAMessage>)
    const event = normalize(message)
    assert.equal(event?.text, 'look')
    assert.equal(event?.attachments?.length, 1)
    const attachment = event!.attachments![0]
    assert.equal(attachment.contentType, 'image/jpeg')
    assert.equal(attachment.name, 'image.jpg')
    assert.equal(attachment.size, 1234)
    const descriptor = decodeMediaDescriptor(attachment.url)
    // Without the mediaKey and directPath the bytes can never be decrypted, so
    // the descriptor has to carry the media node through verbatim.
    assert.equal(descriptor?.kind, 'image')
    assert.ok(descriptor?.message.mediaKey)
    assert.equal(descriptor?.message.directPath, '/v/path')
})

test('documents keep their own filename', () => {
    const message = dmText('', {
        message: {
            documentMessage: {
                mimetype: 'application/pdf',
                fileName: 'invoice.pdf',
                mediaKey: new Uint8Array([1, 2, 3])
            }
        }
    } as Partial<WAMessage>)
    const event = normalize(message)
    assert.equal(event?.attachments?.[0].name, 'invoice.pdf')
    assert.equal(decodeMediaDescriptor(event!.attachments![0].url)?.kind, 'document')
})

test('voice and video stay text placeholders rather than costly downloads', () => {
    const message = dmText('', {
        message: {
            audioMessage: { mimetype: 'audio/ogg', seconds: 4 }
        }
    } as Partial<WAMessage>)
    // A voice note carries no caption, so there is neither text nor a
    // downloadable attachment: nothing worth spending a turn on.
    assert.equal(normalize(message), null)

    const video = dmText('', {
        message: {
            videoMessage: { mimetype: 'video/mp4', caption: 'clip' }
        }
    } as Partial<WAMessage>)
    const event = normalize(video)
    assert.equal(event?.text, 'clip')
    assert.equal(event?.attachments, undefined)
})

test('scope keys separate DMs, shared groups and per-sender groups', () => {
    const provider = makeProvider()
    const dm = normalize(dmText('hi'))!
    assert.equal(
        provider.computeScopeKey(dm, baseConfig()).scopeKey,
        `whatsapp:dm:${encodeURIComponent(USER_JID)}`
    )

    const group = normalize(groupText('hi'))!
    assert.equal(
        provider.computeScopeKey(group, baseConfig()).scopeKey,
        `whatsapp:group:${encodeURIComponent(GROUP_JID)}:${encodeURIComponent(USER_JID)}`
    )
    assert.equal(
        provider.computeScopeKey(
            group,
            baseConfig({ shareSessionInChannel: true })
        ).scopeKey,
        `whatsapp:group:${encodeURIComponent(GROUP_JID)}`
    )
})

test('allowlists accept phone numbers as typed by an operator', () => {
    assert.equal(whatsappIdentityMatches('+1 (555) 765-4321', USER_JID), true)
    assert.equal(whatsappIdentityMatches('15557654321', USER_JID), true)
    assert.equal(whatsappIdentityMatches(USER_JID, USER_JID), true)
    assert.equal(whatsappIdentityMatches('15550009999', USER_JID), false)
})

test('a lid only ever matches literally', () => {
    // A lid is opaque and can collide numerically with somebody else's phone
    // number, so digit-matching it would hand an allowlist slot to a stranger.
    assert.equal(whatsappIdentityMatches('15557654321', '15557654321@lid'), false)
    assert.equal(
        whatsappIdentityMatches('15557654321@lid', '15557654321@lid'),
        true
    )
})

test('empty allowlists let anyone in, a populated one gates', () => {
    const provider = makeProvider()
    const event = normalize(dmText('hi'))!
    assert.deepEqual(provider.evaluateInboundActor(event, baseConfig()), {
        allowed: true,
        operator: false
    })
    assert.deepEqual(
        provider.evaluateInboundActor(
            event,
            baseConfig({ allowedUserIds: ['+15550009999'] })
        ),
        { allowed: false, reason: 'sender_not_allowed', operator: false }
    )
    assert.deepEqual(
        provider.evaluateInboundActor(
            event,
            baseConfig({ allowedUserIds: ['+15557654321'] })
        ),
        { allowed: true, operator: false }
    )
})

test('an operator is allowed even when missing from the allowlist', () => {
    const provider = makeProvider()
    const event = normalize(dmText('hi'))!
    assert.deepEqual(
        provider.evaluateInboundActor(
            event,
            baseConfig({
                allowedUserIds: ['+15550009999'],
                operatorUserIds: ['+15557654321']
            })
        ),
        { allowed: true, operator: true }
    )
})

test('allowedChatIds gates groups without touching DMs', () => {
    const provider = makeProvider()
    const config = baseConfig({ allowedChatIds: ['120363999999999999@g.us'] })
    const group = normalize(groupText('hi'))!
    assert.equal(provider.evaluateInboundActor(group, config).allowed, false)
    assert.equal(
        provider.evaluateInboundActor(group, config).reason,
        'chat_not_allowed'
    )
    const dm = normalize(dmText('hi'))!
    assert.equal(provider.evaluateInboundActor(dm, config).allowed, true)
})

test('config validation defaults mention gating on and preview off', () => {
    const provider = makeProvider()
    const config = provider.validateConfig({})
    assert.equal(config.mentionOnly, true)
    assert.equal(config.allowedUserIds.length, 0)
    // WhatsApp linked devices cannot edit a delivered message, so a streaming
    // preview would post edits nobody ever sees.
    assert.equal(provider.validateConfig({ progressMode: 'preview' }).progressMode, 'final')
    assert.equal(
        provider.validateConfig({ progressMode: 'activity' }).progressMode,
        'activity'
    )
    assert.equal(provider.validateConfig({ mentionOnly: false }).mentionOnly, false)
})

test('credentials are refused: the session lives in provider state', () => {
    const provider = makeProvider()
    assert.equal(provider.validateCredentials(null), null)
    assert.equal(provider.validateCredentials(undefined), null)
    assert.throws(() => provider.validateCredentials({ botToken: 'x' }))
})

test('sending without a live socket fails retryably instead of silently', () => {
    const provider = makeProvider()
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: null
    }
    // No socket on this instance means the lease lives elsewhere. Throwing
    // keeps the delivery queued for the sweep; returning would drop the reply.
    return assert.rejects(
        provider.sendText(ctx, `whatsapp:dm:${encodeURIComponent(USER_JID)}`, 'hi'),
        /connection is not established/
    )
})

test('an unparseable scope key is rejected before any platform call', () => {
    const provider = makeProvider()
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: null
    }
    return assert.rejects(
        provider.sendText(ctx, 'telegram:dm:123', 'hi'),
        /invalid whatsapp scope key/
    )
})

test('jid helpers normalize operator input and classify groups', () => {
    assert.equal(toWhatsappJid('+1 555 765 4321'), USER_JID)
    assert.equal(toWhatsappJid(GROUP_JID), GROUP_JID)
    assert.throws(() => toWhatsappJid('not-a-number'))
    assert.equal(isGroupJid(GROUP_JID), true)
    assert.equal(isGroupJid(USER_JID), false)
})
