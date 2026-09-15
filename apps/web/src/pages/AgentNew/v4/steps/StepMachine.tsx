import type { FC, ReactNode } from 'react'
import type { AgentFramework } from '@manyfold/shared'
import { BoxIcon, CloudComputerIcon, LocalDaemonIcon, PlusIcon } from '@/components/icons'
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
    NewMachineOption,
    SignInCost
} from '@/pages/AgentNew/v4/machineOptions'
import { MACHINE_KIND_KEY } from '@/pages/AgentNew/v4/summaryLabels'

const SIGN_IN_KEY: Record<SignInCost, string> = {
    none: 'web.agentNewV4.cost.noSignIn',
    'next-step': 'web.agentNewV4.cost.signInNextStep',
    after: 'web.agentNewV4.cost.signInAfter',
    'already-if-signed-in': 'web.agentNewV4.cost.signInOnThatComputer'
}

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
        return t('web.agentNewV4.machine.notInstallable', { cli })
    if (row.state === 'service-slot-taken')
        return t('web.agentNewV4.machine.slotTaken', {
            other: row.blockedBy !== undefined ? frameworkLabel(row.blockedBy) : ''
        })
    if (row.state === 'framework-fixed')
        return t('web.agentNewV4.machine.frameworkFixed', {
            other: row.blockedBy !== undefined ? frameworkLabel(row.blockedBy) : ''
        })
    return row.agentsCount > 0
        ? t('web.agentNewV4.machine.readyWithAgents', {
              cli,
              count: String(row.agentsCount)
          })
        : t('web.agentNewV4.machine.readyNoAgents', { cli })
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

const NEW_MACHINE_DETAIL: Record<NewMachineKind, string> = {
    sandbox: 'web.agentNewV4.newMachine.sandboxDetail',
    ownComputer: 'web.agentNewV4.newMachine.ownComputerDetail',
    cloudComputer: 'web.agentNewV4.newMachine.cloudComputerDetail'
}

// Step ② for anything that needs a machine from us. Two groups: what the user
// already has, and a new one. Installing a CLI is NOT a row here — it is what
// picking a machine that lacks it does, which is why "new" has three entries
// rather than four.
export const StepMachine: FC<{
    framework: AgentFramework
    machines: MachineOption[]
    newMachines: NewMachineOption[]
    selectedId: string | null
    onSelectMachine: (row: MachineOption) => void
    onSelectNew: (option: NewMachineOption) => void
}> = ({
    framework,
    machines,
    newMachines,
    selectedId,
    onSelectMachine,
    onSelectNew
}): ReactNode => {
    const { t } = useI18n()
    const cli = frameworkLabel(framework)
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
                                            {t(SIGN_IN_KEY[row.signInCost])}
                                        </span>
                                    )}
                                </>
                            }
                            selected={selectedId === row.id}
                            disabled={row.disabled}
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
                        detail={t(NEW_MACHINE_DETAIL[option.kind], { cli })}
                        mark={<NewMachineMark kind={option.kind} />}
                        meta={
                            <>
                                {option.kind === 'sandbox' &&
                                    option.limit !== undefined && (
                                        <span className='block'>
                                            {t('web.agentNewV4.newMachine.quota', {
                                                used: String(option.used ?? 0),
                                                limit: String(option.limit)
                                            })}
                                        </span>
                                    )}
                                {option.kind === 'cloudComputer' &&
                                    option.disabled && (
                                        <span className='block'>
                                            {t(
                                                'web.agentNewV4.newMachine.needsPlan'
                                            )}
                                        </span>
                                    )}
                                <span className='text-muted block'>
                                    {t(SIGN_IN_KEY[option.signInCost])}
                                </span>
                            </>
                        }
                        selected={selectedId === 'new:' + option.kind}
                        disabled={option.disabled}
                        onSelect={() => onSelectNew(option)}
                    />
                ))}
            </OptionGroup>
        </>
    )
}
