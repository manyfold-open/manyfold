import type { ChannelScopeSummary } from '@manyfold/shared'
import { describeChannelScope } from '@manyfold/shared'
import type { TFn } from '@/lib/i18n'

export const scopeOptionLabel = (
    provider: string,
    scope: ChannelScopeSummary,
    t: TFn
): string => {
    const name = scope.activeSession?.displayName ?? scope.scopeName
    const descriptor = describeChannelScope(provider, scope.scopeKey)
    const kind = t(`web.automations.scope.${descriptor.kind}`)
    if (name) return `${name} · ${kind}`
    const id = descriptor.threadId ?? descriptor.channelId ?? descriptor.userId
    return id ? `${kind} ${id}` : scope.scopeKey
}
