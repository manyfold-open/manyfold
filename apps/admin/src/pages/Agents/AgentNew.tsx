import {
    AgentCreateStep,
    AgentRuntime,
    CreateAgentBody,
    K8sClusterSummary,
    SandboxSummary,
    SdkSpritesAccountSummary,
    SdkUserSummary,
    UserExternalAgentProviderSummary,
    externalSteps,
    isExternal,
    k8sCliSteps,
    k8sSteps,
    normalizeAgentName,
    spritesSteps,
    validateAgentName
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { t } from '@manyfold/i18n'
import { useApiClient } from '@/lib/apiClient'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { adminRoutes } from '@/routes'
import { Button, Card, CardBody, Heading, Input } from '@/ui'
import { CreateProgress } from './components/CreateProgress'
import { ClaudeCodeFields } from './components/ClaudeCodeFields'
import {
    claudeCodeInitial,
    claudeCodeIsValid,
    claudeCodeToPayload,
    type ClaudeCodeFieldsValue
} from './components/ClaudeCodeFields.helpers'
import { CodexFields } from './components/CodexFields'
import {
    codexInitial,
    codexIsValid,
    codexToPayload,
    type CodexFieldsValue
} from './components/CodexFields.helpers'
import { GeminiCliFields } from './components/GeminiCliFields'
import {
    geminiCliInitial,
    geminiCliIsValid,
    geminiCliToPayload,
    type GeminiCliFieldsValue
} from './components/GeminiCliFields.helpers'
import { OpenclawFields } from './components/OpenclawFields'
import {
    openclawInitial,
    openclawIsValid,
    openclawToPayload,
    type OpenclawFieldsValue
} from './components/OpenclawFields.helpers'
import { HermesFields } from './components/HermesFields'
import {
    hermesInitial,
    hermesIsValid,
    hermesToPayload,
    type HermesFieldsValue
} from './components/HermesFields.helpers'

type Framework = Extract<
    CreateAgentBody['framework'],
    | 'claude-code'
    | 'codex'
    | 'gemini-cli'
    | 'openclaw'
    | 'hermes'
    | 'dify'
    | 'langflow'
>

interface ProgressState {
    steps: AgentCreateStep[]
    currentIndex: number
    failedStep: AgentCreateStep | null
    errorMessage: string | null
    done: boolean
}

const isExternalFramework = (framework: Framework): boolean =>
    isExternal(framework)

const resolveSteps = (
    framework: Framework,
    runtime: AgentRuntime
): AgentCreateStep[] => {
    if (runtime === 'external') return externalSteps
    if (runtime === 'sprites') return spritesSteps
    if (
        framework === 'claude-code' ||
        framework === 'codex' ||
        framework === 'gemini-cli'
    )
        return k8sCliSteps
    return k8sSteps
}

const supportsRuntimeChoice = (framework: Framework): boolean =>
    framework === 'claude-code' ||
    framework === 'codex' ||
    framework === 'gemini-cli'

const defaultRuntimeFor = (framework: Framework): AgentRuntime => {
    if (isExternalFramework(framework)) return 'external'
    return supportsRuntimeChoice(framework) ? 'sprites' : 'k8s'
}

const needsClusterId = (
    framework: Framework,
    runtime: AgentRuntime
): boolean => {
    if (framework === 'openclaw' || framework === 'hermes') return true
    return runtime === 'k8s'
}

const frameworkCardClass = (active: boolean): string =>
    [
        'flex cursor-pointer items-center gap-3 rounded border px-2 py-1.5 text-body text-heading transition-colors',
        active
            ? 'border-brand bg-brand-subtle'
            : 'border-border bg-white hover:border-brand-light'
    ].join(' ')

const frameworkOptions: Array<{ value: Framework; labelKey: string }> = [
    { value: 'claude-code', labelKey: 'admin.agents.new.frameworkClaudeCode' },
    { value: 'codex', labelKey: 'admin.agents.new.frameworkCodex' },
    { value: 'gemini-cli', labelKey: 'admin.agents.new.frameworkGeminiCli' },
    { value: 'openclaw', labelKey: 'admin.agents.new.frameworkOpenclaw' },
    { value: 'hermes', labelKey: 'admin.agents.new.frameworkHermes' },
    { value: 'dify', labelKey: 'admin.agents.new.frameworkDify' },
    { value: 'langflow', labelKey: 'admin.agents.new.frameworkLangflow' }
]

const AgentNew: FC = (): ReactNode => {
    const client = useApiClient()
    const navigate = useNavigate()
    const { user: me, isAdmin } = useCurrentUser()
    const agentsApi = isAdmin ? client.admin.agents : client.agents

    const [name, setName] = useState('')
    const [framework, setFramework] = useState<Framework>('claude-code')
    const [runtime, setRuntime] = useState<AgentRuntime>('sprites')
    const [clusters, setClusters] = useState<K8sClusterSummary[] | null>(null)
    const [clusterId, setClusterId] = useState<string>('')
    const [clustersError, setClustersError] = useState<string | null>(null)
    const [accounts, setAccounts] = useState<SdkSpritesAccountSummary[] | null>(
        null
    )
    const [accountId, setAccountId] = useState<string>('')
    const [accountsError, setAccountsError] = useState<string | null>(null)
    const [sandboxes, setSandboxes] = useState<SandboxSummary[] | null>(null)
    const [sandboxId, setSandboxId] = useState<string>('')
    const [users, setUsers] = useState<SdkUserSummary[] | null>(null)
    const [ownerUserId, setOwnerUserId] = useState<string>('')
    const [claudeCode, setClaudeCode] =
        useState<ClaudeCodeFieldsValue>(claudeCodeInitial)
    const [codex, setCodex] = useState<CodexFieldsValue>(codexInitial)
    const [geminiCli, setGeminiCli] =
        useState<GeminiCliFieldsValue>(geminiCliInitial)
    const [openclaw, setOpenclaw] =
        useState<OpenclawFieldsValue>(openclawInitial)
    const [hermes, setHermes] = useState<HermesFieldsValue>(hermesInitial)
    const [externalProviders, setExternalProviders] = useState<
        UserExternalAgentProviderSummary[] | null
    >(null)
    const [externalProviderId, setExternalProviderId] = useState<string>('')
    const [externalRemoteId, setExternalRemoteId] = useState<string>('')
    const [externalProvidersError, setExternalProvidersError] = useState<
        string | null
    >(null)
    const [error, setError] = useState<string | null>(null)
    const [progress, setProgress] = useState<ProgressState | null>(null)

    const streamOpen = progress !== null && !progress.done

    useEffect(() => {
        if (!needsClusterId(framework, runtime)) return
        if (clusters !== null) return
        client.admin.clusters
            .list()
            .then((rows) => {
                setClusters(rows)
                if (rows.length === 1) setClusterId(rows[0].id)
            })
            .catch((e: Error) => setClustersError(e.message))
    }, [client, framework, runtime, clusters])

    useEffect(() => {
        if (!isAdmin) return
        if (runtime !== 'sprites') return
        if (accounts !== null) return
        client.admin.spritesAccounts
            .list()
            .then((rows) => {
                const enabled = rows.filter((r) => r.status === 'enabled')
                setAccounts(enabled)
                if (enabled.length === 1) setAccountId(enabled[0].id)
            })
            .catch((e: Error) => setAccountsError(e.message))
    }, [client, isAdmin, runtime, accounts])

    useEffect(() => {
        const execKind =
            framework === 'claude-code' ||
            framework === 'codex' ||
            framework === 'gemini-cli'
        if (runtime !== 'sprites' || !execKind) return
        if (sandboxes !== null) return
        client.sandboxes
            .list()
            .then(setSandboxes)
            .catch(() => setSandboxes([]))
    }, [client, runtime, framework, sandboxes])

    useEffect(() => {
        if (!isAdmin) return
        if (users !== null) return
        client.admin.users
            .list()
            .then((rows) => {
                setUsers(rows)
            })
            .catch(() => {
                setUsers([])
            })
    }, [client, isAdmin, users])

    useEffect(() => {
        if (me && ownerUserId === '') setOwnerUserId(me.id)
    }, [me, ownerUserId])

    useEffect(() => {
        if (!isExternalFramework(framework)) return
        setExternalProvidersError(null)
        client.externalAgentProviders
            .list(framework as 'dify' | 'langflow')
            .then((rows) => {
                setExternalProviders(rows)
                if (rows.length === 1) setExternalProviderId(rows[0].id)
            })
            .catch((e: Error) => setExternalProvidersError(e.message))
    }, [client, framework])

    const clusterRequired = needsClusterId(framework, runtime)
    const clusterValid = !clusterRequired || clusterId !== ''

    const accountSelectorShown = isAdmin && runtime === 'sprites'
    const accountRequired = accountSelectorShown
    const accountValid = !accountRequired || accountId !== ''

    const sandboxAttachShown =
        runtime === 'sprites' &&
        (framework === 'claude-code' ||
            framework === 'codex' ||
            framework === 'gemini-cli')

    const externalIsValid =
        externalProviderId.trim().length > 0 &&
        externalRemoteId.trim().length > 0
    const activeIsValid =
        framework === 'claude-code'
            ? claudeCodeIsValid(claudeCode)
            : framework === 'codex'
              ? codexIsValid(codex)
              : framework === 'gemini-cli'
                ? geminiCliIsValid(geminiCli)
                : framework === 'openclaw'
                  ? openclawIsValid(openclaw)
                  : framework === 'hermes'
                    ? hermesIsValid(hermes)
                    : externalIsValid
    const nameValidation = validateAgentName(name)
    const normalizedName = nameValidation.valid
        ? nameValidation.value
        : normalizeAgentName(name)
    const nameValidationMessage =
        nameValidation.valid || name.length === 0
            ? null
            : nameValidation.message

    const canSubmit =
        nameValidation.valid &&
        activeIsValid &&
        clusterValid &&
        accountValid &&
        !streamOpen

    const buildBody = (): CreateAgentBody => {
        const runtimeField = supportsRuntimeChoice(framework) ? { runtime } : {}
        const clusterField = clusterRequired ? { clusterId } : {}
        const accountField =
            accountSelectorShown && accountId ? { accountId } : {}
        const ownerField =
            isAdmin && me && ownerUserId && ownerUserId !== me.id
                ? { targetUserId: ownerUserId }
                : {}
        const sandboxField =
            runtime === 'sprites' && sandboxId ? { sandboxId } : {}
        if (framework === 'claude-code') {
            return {
                name: normalizedName,
                framework,
                ...runtimeField,
                ...clusterField,
                ...accountField,
                ...ownerField,
                ...sandboxField,
                claudeCodeCredentials: claudeCodeToPayload(claudeCode)
            }
        }
        if (framework === 'codex') {
            return {
                name: normalizedName,
                framework,
                ...runtimeField,
                ...clusterField,
                ...accountField,
                ...ownerField,
                ...sandboxField,
                codexCredentials: codexToPayload(codex)
            }
        }
        if (framework === 'gemini-cli') {
            return {
                name: normalizedName,
                framework,
                ...runtimeField,
                ...clusterField,
                ...accountField,
                ...ownerField,
                ...sandboxField,
                geminiCliCredentials: geminiCliToPayload(geminiCli)
            }
        }
        if (framework === 'openclaw') {
            return {
                name: normalizedName,
                framework,
                ...clusterField,
                ...ownerField,
                openclawCredentials: openclawToPayload(openclaw)
            }
        }
        if (framework === 'dify') {
            return {
                name: normalizedName,
                framework,
                runtime: 'external' as const,
                ...ownerField,
                difyBinding: {
                    providerId: externalProviderId,
                    appId: externalRemoteId.trim()
                }
            }
        }
        if (framework === 'langflow') {
            return {
                name: normalizedName,
                framework,
                runtime: 'external' as const,
                ...ownerField,
                langflowBinding: {
                    providerId: externalProviderId,
                    flowId: externalRemoteId.trim()
                }
            }
        }
        return {
            name: normalizedName,
            framework: 'hermes',
            ...clusterField,
            ...ownerField,
            hermesCredentials: hermesToPayload(hermes)
        }
    }

    const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        setError(null)
        const steps = resolveSteps(framework, runtime)
        setProgress({
            steps,
            currentIndex: -1,
            failedStep: null,
            errorMessage: null,
            done: false
        })
        try {
            await agentsApi.createStream(buildBody(), (ev) => {
                if (ev.type === 'step')
                    setProgress((p) =>
                        p ? { ...p, currentIndex: ev.index } : p
                    )
                if (ev.type === 'error')
                    setProgress((p) =>
                        p
                            ? {
                                  ...p,
                                  failedStep: ev.step,
                                  errorMessage: ev.message,
                                  done: true
                              }
                            : p
                    )
            })
            setProgress((p) =>
                p ? { ...p, currentIndex: p.steps.length, done: true } : p
            )
            navigate(adminRoutes.agents)
        } catch (err) {
            const message = (err as Error).message
            setError(message)
            setProgress((p) =>
                p
                    ? {
                          ...p,
                          errorMessage: p.errorMessage ?? message,
                          done: true
                      }
                    : p
            )
        }
    }

    const retry = (): void => {
        setProgress(null)
        setError(null)
    }

    return (
        <div className='mx-auto max-w-2xl'>
            <Link
                to={adminRoutes.agents}
                className='text-caption text-body hover:text-heading mb-2 inline-block'
            >
                ← {t('admin.agents.new.back')}
            </Link>
            <Heading level={2} className='mb-2'>
                {t('admin.agents.new.title')}
            </Heading>
            <p className='admin-page-description mb-3'>
                {t('admin.agents.new.subtitle')}
            </p>

            <Card elevation='elevated'>
                <CardBody>
                    {progress ? (
                        <div className='space-y-2'>
                            <div>
                                <Heading level={3} className='mb-1'>
                                    {t('admin.agents.new.progress.title')}
                                </Heading>
                                <p className='text-caption-sm text-body font-mono'>
                                    {name} · {framework}
                                </p>
                            </div>
                            <CreateProgress
                                steps={progress.steps}
                                currentIndex={progress.currentIndex}
                                failedStep={progress.failedStep}
                                errorMessage={progress.errorMessage}
                            />
                            {progress.done && progress.failedStep && (
                                <Button
                                    type='button'
                                    variant='primary'
                                    size='md'
                                    className='w-full'
                                    onClick={retry}
                                >
                                    {t('admin.agents.new.progress.retry')}
                                </Button>
                            )}
                        </div>
                    ) : (
                        <form onSubmit={submit} className='space-y-2'>
                            <Input
                                id='name'
                                label={t('admin.agents.new.nameLabel')}
                                placeholder={t(
                                    'admin.agents.new.namePlaceholder'
                                )}
                                hint={t('admin.agents.new.nameHint')}
                                required
                                minLength={1}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                            {nameValidationMessage && (
                                <p className='text-caption-sm text-accent-ruby'>
                                    {nameValidationMessage}
                                </p>
                            )}

                            {isAdmin && me && (
                                <div>
                                    <label
                                        htmlFor='ownerUserId'
                                        className='text-caption text-label mb-1 block font-normal'
                                    >
                                        {t('admin.agents.new.ownerLabel')}
                                    </label>
                                    <select
                                        id='ownerUserId'
                                        className='border-border text-body text-heading focus:border-brand focus:ring-brand block h-10 w-full rounded border bg-white px-3 focus:ring-1 focus:outline-none'
                                        value={ownerUserId}
                                        onChange={(e): void =>
                                            setOwnerUserId(e.target.value)
                                        }
                                    >
                                        <option value={me.id}>
                                            {me.email} (
                                            {t('admin.agents.new.ownerSelf')})
                                        </option>
                                        {(users ?? [])
                                            .filter((u) => u.id !== me.id)
                                            .map((u) => (
                                                <option key={u.id} value={u.id}>
                                                    {u.email}
                                                </option>
                                            ))}
                                    </select>
                                    <p className='text-caption-sm text-body mt-1'>
                                        {t('admin.agents.new.ownerHint')}
                                    </p>
                                </div>
                            )}

                            <div>
                                <span className='text-caption text-label mb-1 block font-normal'>
                                    {t('admin.agents.new.frameworkLabel')}
                                </span>
                                <div className='grid grid-cols-2 gap-3'>
                                    {frameworkOptions.map((opt) => (
                                        <label
                                            key={opt.value}
                                            className={frameworkCardClass(
                                                framework === opt.value
                                            )}
                                        >
                                            <input
                                                type='radio'
                                                name='framework'
                                                value={opt.value}
                                                checked={
                                                    framework === opt.value
                                                }
                                                onChange={() => {
                                                    setFramework(opt.value)
                                                    setRuntime(
                                                        defaultRuntimeFor(
                                                            opt.value
                                                        )
                                                    )
                                                }}
                                                className='accent-brand'
                                            />
                                            {t(opt.labelKey)}
                                        </label>
                                    ))}
                                </div>
                            </div>

                            {supportsRuntimeChoice(framework) && (
                                <div>
                                    <span className='text-caption text-label mb-1 block font-normal'>
                                        {t('admin.agents.new.runtimeLabel')}
                                    </span>
                                    <div className='grid grid-cols-2 gap-3'>
                                        <label
                                            className={frameworkCardClass(
                                                runtime === 'sprites'
                                            )}
                                        >
                                            <input
                                                type='radio'
                                                name='runtime'
                                                value='sprites'
                                                checked={runtime === 'sprites'}
                                                onChange={() =>
                                                    setRuntime('sprites')
                                                }
                                                className='accent-brand'
                                            />
                                            {t(
                                                'admin.agents.new.runtimeSprites'
                                            )}
                                        </label>
                                        <label
                                            className={frameworkCardClass(
                                                runtime === 'k8s'
                                            )}
                                        >
                                            <input
                                                type='radio'
                                                name='runtime'
                                                value='k8s'
                                                checked={runtime === 'k8s'}
                                                onChange={() =>
                                                    setRuntime('k8s')
                                                }
                                                className='accent-brand'
                                            />
                                            {t('admin.agents.new.runtimeK8s')}
                                        </label>
                                    </div>
                                    <p className='text-caption-sm text-body mt-1'>
                                        {t('admin.agents.new.runtimeHint')}
                                    </p>
                                </div>
                            )}

                            {clusterRequired && (
                                <div>
                                    <label
                                        htmlFor='clusterId'
                                        className='text-caption text-label mb-1 block font-normal'
                                    >
                                        {t('admin.agents.new.clusterLabel')}
                                    </label>
                                    {clusters && clusters.length === 0 ? (
                                        <div className='border-border-dashed rounded border border-dashed bg-white p-2'>
                                            <p className='text-caption text-body mb-3'>
                                                {t(
                                                    'admin.agents.new.clusterEmpty'
                                                )}
                                            </p>
                                            <Link
                                                to={adminRoutes.clusterNew}
                                                className='text-caption text-brand hover:text-brand-hover'
                                            >
                                                {t(
                                                    'admin.agents.new.clusterEmptyCta'
                                                )}{' '}
                                                →
                                            </Link>
                                        </div>
                                    ) : (
                                        <select
                                            id='clusterId'
                                            className='border-border text-body text-heading focus:border-brand focus:ring-brand block h-10 w-full rounded border bg-white px-3 focus:ring-1 focus:outline-none'
                                            value={clusterId}
                                            onChange={(e) =>
                                                setClusterId(e.target.value)
                                            }
                                            required
                                        >
                                            <option value=''>—</option>
                                            {(clusters ?? []).map((c) => (
                                                <option key={c.id} value={c.id}>
                                                    {c.name}
                                                    {c.lastHealthStatus !==
                                                        'ok' &&
                                                        ` (${t(`admin.clusters.health.${c.lastHealthStatus}`)})`}
                                                </option>
                                            ))}
                                        </select>
                                    )}
                                    <p className='text-caption-sm text-body mt-1'>
                                        {t('admin.agents.new.clusterHint')}
                                    </p>
                                    {clustersError && (
                                        <p className='text-caption-sm text-accent-ruby mt-1'>
                                            {clustersError}
                                        </p>
                                    )}
                                </div>
                            )}

                            {accountSelectorShown && (
                                <div>
                                    <label
                                        htmlFor='accountId'
                                        className='text-caption text-label mb-1 block font-normal'
                                    >
                                        {t('admin.agents.new.accountLabel')}
                                    </label>
                                    {accounts && accounts.length === 0 ? (
                                        <div className='border-border-dashed rounded border border-dashed bg-white p-2'>
                                            <p className='text-caption text-body mb-3'>
                                                {t(
                                                    'admin.agents.new.accountEmpty'
                                                )}
                                            </p>
                                            <Link
                                                to={
                                                    adminRoutes.sandboxAccountNew
                                                }
                                                className='text-caption text-brand hover:text-brand-hover'
                                            >
                                                {t(
                                                    'admin.agents.new.accountEmptyCta'
                                                )}{' '}
                                                →
                                            </Link>
                                        </div>
                                    ) : (
                                        <select
                                            id='accountId'
                                            className='border-border text-body text-heading focus:border-brand focus:ring-brand block h-10 w-full rounded border bg-white px-3 focus:ring-1 focus:outline-none'
                                            value={accountId}
                                            onChange={(e) =>
                                                setAccountId(e.target.value)
                                            }
                                            required
                                        >
                                            <option value=''>—</option>
                                            {(accounts ?? []).map((a) => (
                                                <option key={a.id} value={a.id}>
                                                    {a.slug} · {a.orgSlug} (
                                                    {a.activeSprites})
                                                </option>
                                            ))}
                                        </select>
                                    )}
                                    <p className='text-caption-sm text-body mt-1'>
                                        {t('admin.agents.new.accountHint')}
                                    </p>
                                    {accountsError && (
                                        <p className='text-caption-sm text-accent-ruby mt-1'>
                                            {accountsError}
                                        </p>
                                    )}
                                </div>
                            )}

                            {sandboxAttachShown && (
                                <div>
                                    <label
                                        htmlFor='sandboxId'
                                        className='text-caption text-label mb-1 block font-normal'
                                    >
                                        Sandbox
                                    </label>
                                    <select
                                        id='sandboxId'
                                        className='border-border text-body text-heading focus:border-brand focus:ring-brand block h-10 w-full rounded border bg-white px-3 focus:ring-1 focus:outline-none'
                                        value={sandboxId}
                                        onChange={(e) =>
                                            setSandboxId(e.target.value)
                                        }
                                    >
                                        <option value=''>
                                            Provision a new sandbox
                                        </option>
                                        {(sandboxes ?? []).map((s) => (
                                            <option key={s.id} value={s.id}>
                                                {s.name} (
                                                {s.spriteStatus ?? 'cold'},{' '}
                                                {s.agentsCount} agents)
                                            </option>
                                        ))}
                                    </select>
                                    <p className='text-caption-sm text-body mt-1'>
                                        Attach to an existing sandbox, or leave as
                                        “new” to provision a fresh VM for this
                                        agent.
                                    </p>
                                </div>
                            )}

                            {framework === 'claude-code' && (
                                <ClaudeCodeFields
                                    value={claudeCode}
                                    onChange={setClaudeCode}
                                />
                            )}
                            {framework === 'codex' && (
                                <CodexFields
                                    value={codex}
                                    onChange={setCodex}
                                />
                            )}
                            {framework === 'gemini-cli' && (
                                <GeminiCliFields
                                    value={geminiCli}
                                    onChange={setGeminiCli}
                                />
                            )}
                            {framework === 'openclaw' && (
                                <OpenclawFields
                                    value={openclaw}
                                    onChange={setOpenclaw}
                                />
                            )}
                            {framework === 'hermes' && (
                                <HermesFields
                                    value={hermes}
                                    onChange={setHermes}
                                />
                            )}
                            {isExternalFramework(framework) && (
                                <div className='space-y-2'>
                                    <div>
                                        <label
                                            htmlFor='externalProviderId'
                                            className='text-caption text-label mb-1 block font-normal'
                                        >
                                            {t(
                                                'admin.agents.new.externalProviderLabel'
                                            )}
                                        </label>
                                        {externalProviders &&
                                        externalProviders.length === 0 ? (
                                            <div className='border-border-dashed rounded border border-dashed bg-white p-2'>
                                                <p className='text-caption text-body mb-2'>
                                                    {t(
                                                        'admin.agents.new.externalProviderEmpty'
                                                    )}
                                                </p>
                                                <p className='text-caption-sm text-body'>
                                                    {t(
                                                        'admin.agents.new.externalProviderEmptyHint'
                                                    )}
                                                </p>
                                            </div>
                                        ) : (
                                            <select
                                                id='externalProviderId'
                                                className='border-border text-body text-heading focus:border-brand focus:ring-brand block h-10 w-full rounded border bg-white px-3 focus:ring-1 focus:outline-none'
                                                value={externalProviderId}
                                                onChange={(e) =>
                                                    setExternalProviderId(
                                                        e.target.value
                                                    )
                                                }
                                                required
                                            >
                                                <option value=''>—</option>
                                                {(externalProviders ?? []).map(
                                                    (p) => (
                                                        <option
                                                            key={p.id}
                                                            value={p.id}
                                                        >
                                                            {p.label} ·{' '}
                                                            {p.endpointUrl}
                                                        </option>
                                                    )
                                                )}
                                            </select>
                                        )}
                                        {externalProvidersError && (
                                            <p className='text-caption-sm text-accent-ruby mt-1'>
                                                {externalProvidersError}
                                            </p>
                                        )}
                                    </div>
                                    <Input
                                        id='externalRemoteId'
                                        label={
                                            framework === 'langflow'
                                                ? t(
                                                      'admin.agents.new.langflowFlowIdLabel'
                                                  )
                                                : t(
                                                      'admin.agents.new.difyAppIdLabel'
                                                  )
                                        }
                                        placeholder={
                                            framework === 'langflow'
                                                ? 'flow id (UUID) or endpoint name'
                                                : 'app-xxxxxxxx'
                                        }
                                        value={externalRemoteId}
                                        onChange={(e) =>
                                            setExternalRemoteId(e.target.value)
                                        }
                                        required
                                    />
                                </div>
                            )}

                            {error && (
                                <div className='border-accent-ruby/30 bg-accent-ruby/5 rounded border px-3 py-2'>
                                    <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                                        {error}
                                    </pre>
                                </div>
                            )}

                            {!activeIsValid && framework === 'hermes' && (
                                <p className='text-caption-sm text-body'>
                                    {t('admin.agents.new.submitDisabledHint')}
                                </p>
                            )}

                            <Button
                                type='submit'
                                variant='primary'
                                size='md'
                                disabled={!canSubmit}
                                className='w-full'
                            >
                                {t('admin.agents.new.submit')}
                            </Button>
                        </form>
                    )}
                </CardBody>
            </Card>
        </div>
    )
}

export default AgentNew