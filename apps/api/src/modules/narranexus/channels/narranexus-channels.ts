import type { FrameworkChannels } from '@/modules/frameworks/framework-extension'
import type { NormalizedInboundAttachment } from '@/modules/channels/channel-provider'
import { manyfoldProviderToNarraNexusChannelProvider } from '../narranexus-paths'

// NarraNexus sends a file as a custom msgtype carrying text and media in one
// event, plus a separate plain-text hint so clients that do not understand it
// still show something. The generic Matrix branch drops any unknown msgtype,
// which would discard the real payload and forward the placeholder to the
// agent as if it were the user's message — so the provider applies this
// dialect on rooms that mirror a NarraNexus binding.
const NARRAMESSENGER_COMPOUND_MSGTYPE = 'ai.netmind.compound'
// Anchored, and the event id has to look like one: the hint is untrusted user-
// visible text, and a prefix test would let anyone silence a message by opening
// theirs with the same words.
const NARRAMESSENGER_COMPOUND_HINT =
    /^\[internal hint\] process compound (\$[A-Za-z0-9._~+/=-]+(?::[A-Za-z0-9.:-]+)?)$/

// The compound block self-describes: text and one optional media reference. The
// mxc url goes through the same authenticated download as a native m.image, so
// nothing downstream has to know this dialect exists.
const matrixCompoundFromContent = (
    content: Record<string, unknown>
): { text: string; attachments: NormalizedInboundAttachment[] } | null => {
    const raw = content[NARRAMESSENGER_COMPOUND_MSGTYPE]
    if (!raw || typeof raw !== 'object') return null
    const block = raw as Record<string, unknown>
    const text = typeof block.text === 'string' ? block.text : ''
    const url = typeof block.media_url === 'string' ? block.media_url : ''
    const fileName =
        typeof block.file_name === 'string' && block.file_name.trim()
            ? block.file_name.trim()
            : null
    const attachments: NormalizedInboundAttachment[] = url.startsWith('mxc://')
        ? [
              {
                  url,
                  name: fileName ?? 'file',
                  contentType:
                      typeof block.mime_type === 'string'
                          ? block.mime_type
                          : null,
                  size:
                      typeof block.size === 'number' &&
                      Number.isFinite(block.size)
                          ? block.size
                          : null
              }
          ]
        : []
    // A compound with neither is the same nothing an empty m.text is.
    if (!text.trim() && attachments.length === 0) return null
    return { text, attachments }
}

export const narraNexusChannels: FrameworkChannels = {
    // agentManagedReply is valid only on a provider NarraNexus maps to a
    // WorkingSource: anything else would leave the channel silent.
    managedReply: {
        supportsProvider: (provider, { mirrored }) =>
            manyfoldProviderToNarraNexusChannelProvider(provider, {
                mirrored
            }) !== null
    },
    matrixDialect: {
        isPlaceholder: (body) => NARRAMESSENGER_COMPOUND_HINT.test(body),
        parse: (msgtype, content) =>
            msgtype === NARRAMESSENGER_COMPOUND_MSGTYPE
                ? matrixCompoundFromContent(content)
                : undefined
    }
}
