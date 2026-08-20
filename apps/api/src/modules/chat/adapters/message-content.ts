import type {
    ChatAttachmentBlock,
    ChatContextRefBlock,
    ChatMessage,
    ChatUploadBlock
} from '@manyfold/shared'

export const messageToPromptText = (message: ChatMessage): string => {
    const text = message.contentBlocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trimEnd()
    const attachments = message.contentBlocks.filter(
        (b): b is ChatAttachmentBlock => b.type === 'attachment'
    )
    const contextRefs = message.contentBlocks.filter(
        (b): b is ChatContextRefBlock => b.type === 'context_ref'
    )
    const uploads = message.contentBlocks.filter(
        (b): b is ChatUploadBlock => b.type === 'upload'
    )

    const sections: string[] = []
    if (attachments.length > 0)
        sections.push(
            [
                'Attached files:',
                ...attachments.map(
                    (attachment) =>
                        `- ${attachment.name} (${attachment.contentType}, ${attachment.size} bytes): ${attachment.path}`
                )
            ].join('\n')
        )
    if (uploads.length > 0)
        sections.push(
            [
                'Attached files:',
                ...uploads.map(
                    (upload) =>
                        `- ${upload.name} (${upload.contentType}, ${upload.size} bytes)`
                )
            ].join('\n')
        )
    if (contextRefs.length > 0)
        sections.push(
            [
                'Attached context:',
                ...contextRefs.map((ref) => {
                    const meta =
                        ref.entryType === 'file' &&
                        ref.contentType &&
                        ref.size !== undefined
                            ? ` (${ref.contentType}, ${ref.size} bytes)`
                            : ` (${ref.entryType})`
                    return `- ${ref.name}${meta}: ${ref.path}`
                })
            ].join('\n')
        )
    if (sections.length === 0) return text
    return text ? `${text}\n\n${sections.join('\n\n')}` : sections.join('\n\n')
}
