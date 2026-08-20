import {
    GrantableScope,
    ScopeMetadata,
    grantableScopes,
    scopeMetadata
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import ProductDialog from '@/components/ProductDialog'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { ScopeChecklist } from '@/components/auth/ScopeChecklist'
import { useI18n } from '@/lib/i18n'

interface AddPermissionModalProps {
    agentId: string
    onClose: () => void
}

type Stage = { kind: 'configure' } | { kind: 'submitting' } | { kind: 'done' }

export const AddPermissionModal: FC<AddPermissionModalProps> = ({
    agentId,
    onClose
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const { confirm, confirmDialog } = useProductConfirm()
    const [selected, setSelected] = useState<Set<GrantableScope>>(new Set())
    const [error, setError] = useState<string | null>(null)
    const [stage, setStage] = useState<Stage>({ kind: 'configure' })

    const allScopes = useMemo<GrantableScope[]>(() => [...grantableScopes], [])

    const dangerSelected = useMemo(
        () =>
            scopeMetadata.filter(
                (m: ScopeMetadata) =>
                    m.danger === 'high' && selected.has(m.scope)
            ),
        [selected]
    )

    const toggle = useCallback((scope: GrantableScope, next: boolean): void => {
        setSelected((prev) => {
            const ns = new Set(prev)
            if (next) ns.add(scope)
            else ns.delete(scope)
            return ns
        })
    }, [])

    const submit = useCallback(async (): Promise<void> => {
        if (selected.size === 0) {
            setError(t('web.permissions.selectCapability'))
            return
        }
        if (dangerSelected.length > 0) {
            const list = dangerSelected.map((m) => m.scope).join(', ')
            const confirmed = await confirm({
                title: t('web.cliLogin.highRiskTitle'),
                description: (
                    <>
                        {t('web.permissions.grantSummary')}{' '}
                        <code className='font-mono'>{list}</code>
                    </>
                ),
                confirmLabel: t('common.continue'),
                tone: 'danger'
            })
            if (!confirmed) return
        }
        setStage({ kind: 'submitting' })
        setError(null)
        try {
            await client.agents.permissions.add(agentId, {
                scopes: [...selected]
            })
            setStage({ kind: 'done' })
        } catch (err) {
            setError(apiErrorMessage(err))
            setStage({ kind: 'configure' })
        }
    }, [agentId, client, confirm, dangerSelected, selected, t])

    return (
        <>
            <ProductDialog
                title={t('web.agents.detail.permissions.addAction')}
                description={
                    <>
                        {t('web.permissions.grantCapabilitiesPrefix')}{' '}
                        <code className='font-mono'>{agentId}</code>{' '}
                        {t('web.permissions.grantCapabilitiesSuffix')}
                    </>
                }
                size='lg'
                onClose={onClose}
                closeDisabled={stage.kind === 'submitting'}
                closeOnBackdrop={stage.kind === 'configure'}
                bodyClassName='space-y-4'
                footer={
                    stage.kind === 'done' ? (
                        <button
                            type='button'
                            onClick={onClose}
                            className='workbench-button-primary'
                        >
                            {t('web.permissions.done')}
                        </button>
                    ) : (
                        <>
                            <button
                                type='button'
                                onClick={onClose}
                                disabled={stage.kind === 'submitting'}
                                className='workbench-button-secondary'
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                type='button'
                                onClick={submit}
                                disabled={stage.kind === 'submitting'}
                                className='workbench-button-primary'
                            >
                                {stage.kind === 'submitting'
                                    ? t('common.saving')
                            : t('web.agents.detail.permissions.addAction')}
                            </button>
                        </>
                    )
                }
            >
                {stage.kind === 'done' ? (
                    <div className='workbench-note'>
                        {t('web.permissions.updated')}
                    </div>
                ) : (
                    <>
                        {error && (
                            <div className='workbench-alert-error'>{error}</div>
                        )}
                        <ScopeChecklist
                            requestedScopes={allScopes}
                            selectedScopes={[...selected]}
                            onToggle={toggle}
                            disabled={stage.kind === 'submitting'}
                        />
                    </>
                )}
            </ProductDialog>
            {confirmDialog}
        </>
    )
}
