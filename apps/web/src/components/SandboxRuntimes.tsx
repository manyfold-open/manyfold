import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import type {
    AgentFramework,
    AgentRuntimeSummary,
    SandboxSummary
} from '@manyfold/shared'
import { CreateMenu } from '@/components/CreateMenu'
import EmptyState from '@/components/EmptyState'
import { Spinner } from '@/components/Loading'
import { Section, runtimeStatusTag } from '@/components/RuntimeDetailPanel'
import VersionPicker from '@/components/VersionPicker'
import { ChevronRightIcon } from '@/components/icons'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { FrameworkLogo, frameworkLabel } from '@/lib/frameworkMeta'
import { useI18n } from '@/lib/i18n'
import {
    sandboxInstallOptions,
    sandboxItemUpdate,
    sandboxRuntimeItems,
    sandboxVersionChange,
    versionChoices,
    type SandboxRuntimeItem
} from '@/lib/sandboxRuntimes'
import { useIsTargetUpdating } from '@/lib/updateRunStore'

type Catalog = Record<string, { versions: string[]; latest: string | null }>

const RuntimeItemRow: FC<{
    item: SandboxRuntimeItem
    catalog: Catalog
    busy: 'preparing' | 'changing' | null
    onOpen: () => void
    onChangeVersion: (version: string) => void
}> = ({ item, catalog, busy, onOpen, onChangeVersion }): ReactNode => {
    const { t } = useI18n()
    const queued = useIsTargetUpdating(item.updateId)
    const entry = catalog[item.framework] ?? null
    const latest = entry?.latest ?? null
    const status = item.runtime?.status ?? 'ready'
    const version =
        status !== 'ready' ? (
            runtimeStatusTag(status)
        ) : (
            <VersionPicker
                current={item.version}
                unknownLabel={t('web.agentRuntimesList.versionUnknown')}
                groups={[
                    {
                        label: null,
                        versions: versionChoices(entry?.versions ?? [], latest)
                    }
                ]}
                latest={latest}
                update={sandboxItemUpdate(item, latest)}
                kind='framework'
                busy={busy === 'changing' || queued}
                busyLabel={t('web.agentRuntimesList.upgrading')}
                onPick={sandboxVersionChange(item) ? onChangeVersion : null}
            />
        )
    return (
        <div className='border-divider/60 hover:bg-surface-hover relative flex items-center gap-3 border-t px-4 py-3 transition-colors first:border-t-0'>
            <span className='inline-flex shrink-0'>
                <FrameworkLogo framework={item.framework} size={28} />
            </span>
            <span className='flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1'>
                {/* The row's press target, stretched over the whole row; the
                    version sits above it so it keeps its own clicks. */}
                <button
                    type='button'
                    onClick={onOpen}
                    disabled={busy !== null}
                    className='settings-card-label min-w-0 truncate text-left after:absolute after:inset-0 focus-visible:underline disabled:cursor-progress'
                >
                    {frameworkLabel(item.framework)}
                </button>
                <span className='relative z-10 inline-flex'>{version}</span>
            </span>
            <span className='text-caption text-muted inline-flex shrink-0 items-center gap-1.5 tabular-nums'>
                {busy === 'preparing' ? (
                    <>
                        <Spinner size={12} />
                        {t('web.agentRuntimesList.settingUp')}
                    </>
                ) : (
                    `${item.agentsCount} ${
                        item.agentsCount === 1
                            ? t('web.agentRuntimesList.agent')
                            : t('web.agentRuntimesList.agents')
                    }`
                )}
            </span>
            <ChevronRightIcon className='text-subtle h-4 w-4 shrink-0' />
        </div>
    )
}

// A sandbox's Runtimes: every framework on it, whether a runtime claims it yet
// or not, each with its agents and its CLI version. The "+" installs one more.
const SandboxRuntimes: FC<{
    sandbox: SandboxSummary
    runtimes: AgentRuntimeSummary[]
    catalog: Catalog
    onSelectRuntime: (runtimeId: string) => void
    onChanged: () => Promise<void>
}> = ({
    sandbox,
    runtimes,
    catalog,
    onSelectRuntime,
    onChanged
}): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [installing, setInstalling] = useState<AgentFramework[]>([])
    const [busy, setBusy] = useState<Record<string, 'preparing' | 'changing'>>(
        {}
    )
    const [error, setError] = useState<string | null>(null)
    const items = sandboxRuntimeItems(sandbox, runtimes)
    const options = sandboxInstallOptions(sandbox, runtimes).filter(
        (option) => !installing.includes(option.framework)
    )

    const setItemBusy = (
        id: string,
        state: 'preparing' | 'changing' | null
    ): void =>
        setBusy((prev) => {
            const next = { ...prev }
            if (state) next[id] = state
            else delete next[id]
            return next
        })

    // prepareRuntime installs the framework (or registers the one already
    // there) and gives it a runtime; it runs in the sandbox, so it wakes it.
    const install = async (framework: AgentFramework): Promise<void> => {
        setError(null)
        setInstalling((prev) => [...prev, framework])
        try {
            await client.sandboxes.prepareRuntime(sandbox.id, framework)
            await onChanged()
        } catch (e) {
            setError(apiErrorMessage(e))
        } finally {
            setInstalling((prev) => prev.filter((f) => f !== framework))
        }
    }

    // A CLI no runtime has claimed has no page of its own yet: opening it
    // gives it its runtime first.
    const open = async (item: SandboxRuntimeItem): Promise<void> => {
        if (item.runtime) {
            onSelectRuntime(item.runtime.id)
            return
        }
        setError(null)
        setItemBusy(item.updateId, 'preparing')
        try {
            const runtime = await client.sandboxes.prepareRuntime(
                sandbox.id,
                item.framework
            )
            await onChanged()
            onSelectRuntime(runtime.id)
        } catch (e) {
            setError(apiErrorMessage(e))
        } finally {
            setItemBusy(item.updateId, null)
        }
    }

    const changeVersion = async (
        item: SandboxRuntimeItem,
        version: string
    ): Promise<void> => {
        const change = sandboxVersionChange(item)
        if (!change) return
        setError(null)
        setItemBusy(item.updateId, 'changing')
        try {
            if (change.via === 'sandbox')
                await client.sandboxes.installFramework(
                    sandbox.id,
                    item.framework,
                    version
                )
            else if (change.mode === 'rebuild')
                await client.agents.upgradeFrameworkStream(
                    change.agentId,
                    version,
                    () => undefined
                )
            else await client.agents.upgradeFramework(change.agentId, version)
            await onChanged()
        } catch (e) {
            setError(apiErrorMessage(e))
        } finally {
            setItemBusy(item.updateId, null)
        }
    }

    return (
        <Section
            title={t('web.agentRuntimesList.runtimesTitle')}
            action={
                options.length > 0 ? (
                    <CreateMenu
                        variant='icon'
                        triggerLabel={t(
                            'web.agentRuntimesList.installFramework'
                        )}
                        sheetTitle={t('web.agentRuntimesList.installFramework')}
                        options={options.map((option) => ({
                            key: option.framework,
                            lead: (
                                <FrameworkLogo
                                    framework={option.framework}
                                    size={16}
                                />
                            ),
                            label: frameworkLabel(option.framework),
                            disabled: option.blockedBy !== null,
                            detail: option.blockedBy
                                ? t('web.agentRuntimesList.alreadyRuns', {
                                      framework: frameworkLabel(
                                          option.blockedBy
                                      )
                                  })
                                : undefined,
                            onSelect: () => void install(option.framework)
                        }))}
                    />
                ) : undefined
            }
        >
            {error && <div className='workbench-alert-error mb-3'>{error}</div>}
            {items.length === 0 && installing.length === 0 ? (
                // Only a sandbox that is not ready yet can have nothing here:
                // a ready one always carries the CLIs its image ships.
                <EmptyState
                    kind='first-use'
                    tier='stack'
                    title={t('web.emptyState.runtimesTitle')}
                />
            ) : (
                <div className='settings-card'>
                    {items.map((item) => (
                        <RuntimeItemRow
                            key={item.updateId}
                            item={item}
                            catalog={catalog}
                            busy={busy[item.updateId] ?? null}
                            onOpen={() => void open(item)}
                            onChangeVersion={(version) =>
                                void changeVersion(item, version)
                            }
                        />
                    ))}
                    {installing.map((framework) => (
                        <div
                            key={framework}
                            aria-busy='true'
                            className='border-divider/60 flex items-center gap-3 border-t px-4 py-3 first:border-t-0'
                        >
                            <span className='inline-flex shrink-0'>
                                <FrameworkLogo
                                    framework={framework}
                                    size={28}
                                />
                            </span>
                            <span className='settings-card-label min-w-0 flex-1 truncate'>
                                {frameworkLabel(framework)}
                            </span>
                            {runtimeStatusTag('installing')}
                        </div>
                    ))}
                </div>
            )}
        </Section>
    )
}

export default SandboxRuntimes
