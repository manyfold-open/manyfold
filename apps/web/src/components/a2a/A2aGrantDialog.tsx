import type { FC, ReactNode } from 'react'
import { useCallback, useState } from 'react'
import type { SdkAgent } from '@manyfold/sdk'
import ProductDialog from '@/components/ProductDialog'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { CheckIcon, CopyIcon } from '@/components/icons'
import { formatDateTime } from '@/lib/dateFormat'
import { useI18n } from '@/lib/i18n'

export type A2aGrantDirection = 'inbound' | 'outbound'

interface A2aGrantDialogProps {
    // The agent whose A2A tab this is — inbound grants live on it, outbound
    // grants name it as the caller.
    agentId: string
    direction: A2aGrantDirection
    // Eligible agents to grant: callers (inbound) or targets (outbound).
    options: SdkAgent[]
    // Shown when `options` is empty, explaining why nothing is selectable.
    emptyReason: string
    // RPC endpoint surfaced next to a freshly minted external bearer.
    rpcUrl: string
    onClose: () => void
}

type InboundMode = 'peers' | 'external'

type Stage =
    | { kind: 'configure' }
    | { kind: 'submitting' }
    | { kind: 'token'; token: string; expiresAt: string | null }

const A2aGrantDialog: FC<A2aGrantDialogProps> = ({
    agentId,
    direction,
    options,
    emptyReason,
    rpcUrl,
    onClose
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [mode, setMode] = useState<InboundMode>('peers')
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [name, setName] = useState('')
    const [expiresInDays, setExpiresInDays] = useState('')
    const [stage, setStage] = useState<Stage>({ kind: 'configure' })
    const [error, setError] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)

    const submitting = stage.kind === 'submitting'
    const isExternal = direction === 'inbound' && mode === 'external'

    const toggle = useCallback((id: string, next: boolean): void => {
        setSelected((prev) => {
            const ns = new Set(prev)
            if (next) ns.add(id)
            else ns.delete(id)
            return ns
        })
    }, [])

    const grantPeers = useCallback(async (): Promise<void> => {
        await client.a2a.mintGrants(agentId, {
            callerAgentIds: [...selected],
            replaceExisting: true
        })
    }, [agentId, client, selected])

    const grantTargets = useCallback(async (): Promise<void> => {
        // Each outbound grant lives on a different target agent, so there is no
        // single batch call — fan out and surface any partial failure (Rule 9).
        const ids = [...selected]
        const results = await Promise.allSettled(
            ids.map((targetId) =>
                client.a2a.mintGrant(targetId, {
                    callerAgentId: agentId,
                    replaceExisting: true
                })
            )
        )
        const failed = ids.filter((_, i) => results[i].status === 'rejected')
        if (failed.length > 0) {
            const names = failed
                .map((id) => options.find((a) => a.id === id)?.name ?? id)
                .join(', ')
            throw new Error(
                t('web.a2aGrant.authorizeFailed', { names })
            )
        }
    }, [agentId, client, options, selected, t])

    const mintExternal = useCallback(async (): Promise<Stage> => {
        const days = expiresInDays.trim()
        const parsed = days ? Number(days) : undefined
        if (parsed !== undefined && (!Number.isFinite(parsed) || parsed <= 0)) {
            throw new Error(t('web.a2aGrant.expiryError'))
        }
        const res = await client.a2a.mintGrant(agentId, {
            name: name.trim() || undefined,
            expiresInDays: parsed
        })
        return { kind: 'token', token: res.token, expiresAt: res.expiresAt }
    }, [agentId, client, expiresInDays, name, t])

    const submit = useCallback(async (): Promise<void> => {
        setError(null)
        if (isExternal) {
            setStage({ kind: 'submitting' })
            try {
                setStage(await mintExternal())
            } catch (err) {
                setError(apiErrorMessage(err))
                setStage({ kind: 'configure' })
            }
            return
        }
        if (selected.size === 0) {
            setError(t('web.a2aGrant.selectAgent'))
            return
        }
        setStage({ kind: 'submitting' })
        try {
            if (direction === 'inbound') await grantPeers()
            else await grantTargets()
            onClose()
        } catch (err) {
            setError(apiErrorMessage(err))
            setStage({ kind: 'configure' })
        }
    }, [
        direction,
        isExternal,
        selected,
        grantPeers,
        grantTargets,
        mintExternal,
        onClose
    ])

    const copyToken = useCallback(async (token: string): Promise<void> => {
        try {
            await navigator.clipboard.writeText(token)
            setCopied(true)
        } catch {
            /* clipboard unavailable */
        }
    }, [])

    const title = direction === 'inbound'
        ? t('web.a2aGrant.addCaller')
        : t('web.a2aGrant.addTarget')
    const description =
        direction === 'inbound'
            ? t('web.a2aGrant.callerDescription')
            : t('web.a2aGrant.targetDescription')

    const submitLabel = isExternal
        ? submitting
            ? t('web.a2aGrant.creating')
            : t('web.a2aGrant.createToken')
        : submitting
          ? t('web.a2aGrant.granting')
          : direction === 'inbound'
            ? t('web.a2aGrant.grantSelected', { count: selected.size })
            : t('web.a2aGrant.authorizeSelected', { count: selected.size })

    const submitDisabled = submitting || (!isExternal && selected.size === 0)

    const footer =
        stage.kind === 'token' ? (
            <button
                type='button'
                className='workbench-button-primary'
                onClick={onClose}
            >
                {t('web.a2aGrant.done')}
            </button>
        ) : (
            <>
                <button
                    type='button'
                    className='workbench-button-secondary'
                    onClick={onClose}
                    disabled={submitting}
                >
                    {t('web.a2aGrant.cancel')}
                </button>
                <button
                    type='button'
                    className='workbench-button-primary'
                    onClick={() => void submit()}
                    disabled={submitDisabled}
                >
                    {submitLabel}
                </button>
            </>
        )

    return (
        <ProductDialog
            title={title}
            description={description}
            size='md'
            onClose={onClose}
            closeDisabled={submitting}
            closeOnBackdrop={stage.kind === 'configure'}
            bodyClassName='space-y-4'
            footer={footer}
        >
            {stage.kind === 'token' ? (
                <div className='space-y-3'>
                    <div className='bg-warning-bg text-warning shadow-ring-light text-ui rounded-md px-3.5 py-2.5'>
                        {t('web.a2aGrant.bearerNotice')}
                    </div>
                    <div>
                        <div className='workbench-field-label'>
                            {t('web.a2aGrant.bearerToken')}
                        </div>
                        <div className='flex items-center gap-2'>
                            <code className='bg-surface-subtle border-divider text-fg text-caption flex-1 truncate rounded-md border px-2 py-1 font-mono'>
                                {stage.token}
                            </code>
                            <button
                                type='button'
                                className='workbench-button-secondary inline-flex items-center gap-1.5'
                                onClick={() => void copyToken(stage.token)}
                            >
                                {copied ? (
                                    <CheckIcon className='h-4 w-4' />
                                ) : (
                                    <CopyIcon className='h-4 w-4' />
                                )}
                                {copied
                                    ? t('web.a2aGrant.copied')
                                    : t('web.a2aGrant.copy')}
                            </button>
                        </div>
                    </div>
                    <div>
                        <div className='workbench-field-label'>
                            {t('web.a2aGrant.rpcEndpoint')}
                        </div>
                        <code className='bg-surface-subtle border-divider text-fg text-caption block truncate rounded-md border px-2 py-1 font-mono'>
                            {rpcUrl}
                        </code>
                    </div>
                    {stage.expiresAt ? (
                        <p className='text-subtle text-caption'>
                            {t('web.a2aGrant.expires', {
                                date: formatDateTime(stage.expiresAt)
                            })}
                        </p>
                    ) : (
                        <p className='text-subtle text-caption'>
                            {t('web.a2aGrant.neverExpires')}
                        </p>
                    )}
                </div>
            ) : (
                <>
                    {error ? (
                        <div className='workbench-alert-error'>{error}</div>
                    ) : null}

                    {direction === 'inbound' ? (
                        <div className='bg-surface-subtle flex gap-1 rounded-md p-1'>
                            <ModeButton
                                active={mode === 'peers'}
                                onClick={() => setMode('peers')}
                            >
                                {t('web.a2aGrant.agentPeers')}
                            </ModeButton>
                            <ModeButton
                                active={mode === 'external'}
                                onClick={() => setMode('external')}
                            >
                                {t('web.a2aGrant.externalClient')}
                            </ModeButton>
                        </div>
                    ) : null}

                    {isExternal ? (
                        <div className='space-y-3'>
                            <div>
                                <label
                                    className='workbench-field-label'
                                    htmlFor='a2a-ext-name'
                                >
                                    {t('web.a2aGrant.nameOptional')}
                                </label>
                                <input
                                    id='a2a-ext-name'
                                    className='workbench-input'
                                    value={name}
                                    placeholder={t('web.a2aGrant.namePlaceholder')}
                                    disabled={submitting}
                                    onChange={(e) => setName(e.target.value)}
                                />
                            </div>
                            <div>
                                <label
                                    className='workbench-field-label'
                                    htmlFor='a2a-ext-expiry'
                                >
                                    {t('web.a2aGrant.expiryOptional')}
                                </label>
                                <input
                                    id='a2a-ext-expiry'
                                    className='workbench-input'
                                    type='number'
                                    min='1'
                                    value={expiresInDays}
                                    placeholder={t('web.a2aGrant.expiryPlaceholder')}
                                    disabled={submitting}
                                    onChange={(e) =>
                                        setExpiresInDays(e.target.value)
                                    }
                                />
                            </div>
                            <p className='text-subtle text-caption'>
                                {t('web.a2aGrant.externalDescription')}
                            </p>
                        </div>
                    ) : options.length === 0 ? (
                        <div className='workbench-note'>{emptyReason}</div>
                    ) : (
                        <ul className='space-y-2'>
                            {options.map((agent) => {
                                const checked = selected.has(agent.id)
                                return (
                                    <li
                                        key={agent.id}
                                        className='border-divider bg-surface rounded-md border px-3.5 py-3'
                                    >
                                        <label className='flex cursor-pointer items-center gap-3'>
                                            <input
                                                type='checkbox'
                                                className='border-divider text-fg focus-visible:ring-focus h-4 w-4 rounded'
                                                checked={checked}
                                                disabled={submitting}
                                                onChange={(e) =>
                                                    toggle(
                                                        agent.id,
                                                        e.target.checked
                                                    )
                                                }
                                            />
                                            <span className='text-ui text-fg min-w-0 flex-1 truncate'>
                                                {agent.name}
                                            </span>
                                            <code className='text-caption text-subtle shrink-0 font-mono'>
                                                {agent.runtime}
                                            </code>
                                        </label>
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                </>
            )}
        </ProductDialog>
    )
}

interface ModeButtonProps {
    active: boolean
    onClick: () => void
    children: ReactNode
}

const ModeButton: FC<ModeButtonProps> = ({
    active,
    onClick,
    children
}): ReactNode => (
    <button
        type='button'
        onClick={onClick}
        className={[
            'text-ui h-8 flex-1 rounded-md px-3 font-medium transition-colors',
            active
                ? 'bg-surface text-fg shadow-ring-light'
                : 'text-muted hover:text-fg'
        ].join(' ')}
    >
        {children}
    </button>
)

export default A2aGrantDialog
