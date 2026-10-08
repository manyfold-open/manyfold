import type { FC, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AgentFramework } from '@manyfold/shared'
import {
    BoxIcon,
    CloudComputerIcon,
    InfoIcon,
    LocalDaemonIcon,
    PlusIcon
} from '@/components/icons'
import { frameworkLabel } from '@/lib/frameworkMeta'
import { useI18n } from '@/lib/i18n'
import type { TFn } from '@/lib/i18n'
import {
    OptionGroup,
    OptionRow
} from '@/pages/AgentNew/v4/components/OptionRow'
import type {
    MachineOption,
    NewMachineKind,
    NewMachineOption
} from '@/pages/AgentNew/v4/machineOptions'
import {
    MACHINE_KIND_KEY,
    newMachineWaitLabel,
    waitLabel
} from '@/pages/AgentNew/v4/summaryLabels'
import {
    installMinutes,
    installsAtCreate
} from '@/pages/AgentNew/v4/frameworkCatalog'
import { EXIT_MANAGE_SANDBOXES } from '@/pages/AgentNew/v4/exits'

// The second line of a machine row: what is on it, in terms of the framework
// the user picked in step ①. Naming the CLI is only possible because the type
// was asked first — "your computer does not have Gemini CLI" instead of a
// shapeless "cannot install here".
const machineDetail = (
    row: MachineOption,
    framework: AgentFramework,
    t: TFn
): string => {
    const cli = frameworkLabel(framework)
    if (row.state === 'needs-install')
        return row.idle
            ? t('web.agentNewV4.machine.needsInstallIdle', { cli })
            : t('web.agentNewV4.machine.needsInstall', { cli })
    if (row.state === 'not-installable')
        return row.hostKind === 'k8s'
            ? t('web.agentNewV4.machine.podHostNoService', { cli })
            : t('web.agentNewV4.machine.notInstallable', { cli })
    if (row.state === 'service-slot-taken')
        return t('web.agentNewV4.machine.slotTaken', {
            other: row.blockedBy !== undefined ? frameworkLabel(row.blockedBy) : ''
        })
    if (row.state === 'unavailable')
        return row.unavailableReason === 'offline'
            ? t('web.agentNewV4.machine.daemonOffline')
            : row.unavailableReason === 'maintenance'
              ? t('web.agentNewV4.machine.sandboxMaintenance')
              : row.unavailableReason !== 'failed'
                ? t('web.agentNewV4.machine.podHostStarting')
                : row.hostKind === 'sprites'
                  ? t('web.agentNewV4.machine.sandboxFailed')
                  : t('web.agentNewV4.machine.podHostFailed')
    // What is installed and how many agents it carries — not whether it is
    // "working" or "signed in", which this list cannot know without waking it.
    if (row.agentsCount === 0)
        return t('web.agentNewV4.machine.readyNoAgents', { cli })
    return row.agentsCount === 1
        ? t('web.agentNewV4.machine.readyWithOneAgent', { cli })
        : t('web.agentNewV4.machine.readyWithAgents', {
              cli,
              count: String(row.agentsCount)
          })
}

const NEW_MACHINE_ICON: Record<NewMachineKind, typeof PlusIcon> = {
    sandbox: PlusIcon,
    ownComputer: LocalDaemonIcon,
    cloudComputer: CloudComputerIcon
}

const NewMachineMark: FC<{ kind: NewMachineKind }> = ({ kind }): ReactNode => {
    const Icon = NEW_MACHINE_ICON[kind]
    return <Icon className='h-5 w-5' />
}

const NEW_MACHINE_TITLE: Record<NewMachineKind, string> = {
    sandbox: 'web.agentNewV4.newMachine.sandbox',
    ownComputer: 'web.agentNewV4.newMachine.ownComputer',
    cloudComputer: 'web.agentNewV4.newMachine.cloudComputer'
}

// A new machine's second line: what picking it builds — or, when it cannot be
// picked, why not. Decision R asks every disabled row for its reason.
const newMachineDetail = (
    option: NewMachineOption,
    framework: AgentFramework,
    t: TFn
): string => {
    const cli = frameworkLabel(framework)
    if (option.kind === 'sandbox')
        return option.disabled
            ? t('web.agentNewV4.newMachine.sandboxFull', {
                  used: String(option.used ?? 0),
                  limit: String(option.limit ?? 0)
              })
            : installsAtCreate(framework)
              ? t('web.agentNewV4.newMachine.sandboxDetailService', { cli })
              : t('web.agentNewV4.newMachine.sandboxDetail', { cli })
    if (option.kind === 'ownComputer')
        return option.disabled
            ? t('web.agentNewV4.newMachine.ownComputerUnsupported', { cli })
            : t('web.agentNewV4.newMachine.ownComputerDetail', { cli })
    return t('web.agentNewV4.newMachine.cloudComputerDetail')
}

// Step ② for anything that needs a machine from us. Two groups: what the user
// already has, and a new one. Installing a CLI is NOT a row here — it is what
// picking a machine that lacks it does, which is why "new" has three entries
// rather than four.
//
// The right-hand column says what picking a row costs in waiting, and
// nothing about signing in: that depends on how the agent is paid for, which
// is step ③'s question.
export const StepMachine: FC<{
    framework: AgentFramework
    machines: MachineOption[]
    newMachines: NewMachineOption[]
    selectedId: string | null
    // Set while the picked row is being built or installed onto. The other
    // rows freeze in place: picking one mid-build relabelled the button for a
    // machine nobody was building, and the build carried on with the first
    // pick anyway.
    locked?: boolean
    onSelectMachine: (row: MachineOption) => void
    onSelectNew: (option: NewMachineOption) => void
}> = ({
    framework,
    machines,
    newMachines,
    selectedId,
    locked = false,
    onSelectMachine,
    onSelectNew
}): ReactNode => {
    const { t } = useI18n()
    const cli = frameworkLabel(framework)
    const minutes = installMinutes(framework)
    const sandboxFull = newMachines.some(
        (option) => option.kind === 'sandbox' && option.disabled
    )
    return (
        <>
            {machines.length > 0 && (
                <OptionGroup title={t('web.agentNewV4.machine.yours')}>
                    {machines.map((row) => (
                        <OptionRow
                            key={row.id}
                            title={row.title}
                            detail={machineDetail(row, framework, t)}
                            mark={
                                row.hostKind === 'daemon' ? (
                                    <LocalDaemonIcon className='h-5 w-5' />
                                ) : row.hostKind === 'k8s' ? (
                                    <CloudComputerIcon className='h-5 w-5' />
                                ) : (
                                    <BoxIcon className='h-5 w-5' />
                                )
                            }
                            meta={
                                <>
                                    <span className='block'>
                                        {t(MACHINE_KIND_KEY[row.hostKind])}
                                    </span>
                                    {!row.disabled && (
                                        <span className='text-muted block'>
                                            {waitLabel(row.wait, cli, minutes, t)}
                                        </span>
                                    )}
                                </>
                            }
                            selected={selectedId === row.id}
                            disabled={
                                row.disabled ||
                                (locked && selectedId !== row.id)
                            }
                            onSelect={() => onSelectMachine(row)}
                        />
                    ))}
                </OptionGroup>
            )}
            <OptionGroup title={t('web.agentNewV4.machine.newOne')}>
                {newMachines.map((option) => (
                    <OptionRow
                        key={option.kind}
                        title={t(NEW_MACHINE_TITLE[option.kind], { cli })}
                        detail={newMachineDetail(option, framework, t)}
                        mark={<NewMachineMark kind={option.kind} />}
                        meta={
                            option.disabled ? (
                                option.kind === 'cloudComputer' ? (
                                    t('web.agentNewV4.newMachine.cloudComputerOff')
                                ) : undefined
                            ) : (
                                <>
                                    {option.kind === 'sandbox' &&
                                        option.limit !== undefined && (
                                            <span className='block'>
                                                {t(
                                                    'web.agentNewV4.newMachine.quota',
                                                    {
                                                        used: String(
                                                            option.used ?? 0
                                                        ),
                                                        limit: String(
                                                            option.limit
                                                        )
                                                    }
                                                )}
                                            </span>
                                        )}
                                    <span className='text-muted block'>
                                        {newMachineWaitLabel(
                                            option.kind,
                                            cli,
                                            installsAtCreate(framework),
                                            t
                                        )}
                                    </span>
                                </>
                            )
                        }
                        selected={selectedId === 'new:' + option.kind}
                        disabled={
                            option.disabled ||
                            (locked && selectedId !== 'new:' + option.kind)
                        }
                        onSelect={() => onSelectNew(option)}
                    />
                ))}
            </OptionGroup>
            {/* A full quota is the one disabled row with a way out the user
                controls, so it gets one: the page where sandboxes are
                deleted. It is a link they choose, not a row that leaves. */}
            {sandboxFull && (
                <p className='text-caption text-subtle mt-2 flex items-start gap-2 px-3'>
                    <InfoIcon
                        className='mt-0.5 h-3.5 w-3.5 shrink-0'
                        aria-hidden='true'
                    />
                    <span>
                        {t('web.agentNewV4.newMachine.sandboxFullHint')}{' '}
                        <Link
                            to={EXIT_MANAGE_SANDBOXES}
                            className='text-link underline-offset-2 hover:underline'
                        >
                            {t('web.agentNewV4.newMachine.manageSandboxes')}
                        </Link>
                    </span>
                </p>
            )}
        </>
    )
}
