import type {
    CreateUserMcpServerBody,
    McpCatalogTransport,
    UpdateUserMcpServerBody,
    UserMcpServer
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useState } from 'react'
import ProductDialog from '@/components/ProductDialog'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { useApiClient } from '@/lib/apiClient'
import { Spinner } from '@/components/Loading'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

const SERVER_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

const recordText = (value?: Record<string, string>): string =>
    value ? JSON.stringify(value, null, 2) : ''

const parseRecord = (value: string): Record<string, string> | undefined => {
    if (!value.trim()) return undefined
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('invalid-record')
    const record = parsed as Record<string, unknown>
    if (
        Object.entries(record).some(
            ([key, entry]) => !key.trim() || typeof entry !== 'string'
        )
    )
        throw new Error('invalid-record')
    return record as Record<string, string>
}

interface Props {
    server?: UserMcpServer
    onClose: () => void
    onSaved: (server: UserMcpServer) => void
}

const UserMcpServerDialog: FC<Props> = ({
    server,
    onClose,
    onSaved
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [name, setName] = useState(server?.name ?? '')
    const [serverKey, setServerKey] = useState(server?.serverKey ?? '')
    const [description, setDescription] = useState(server?.description ?? '')
    const [transport, setTransport] = useState<McpCatalogTransport>(
        server?.transport ?? 'http'
    )
    const [url, setUrl] = useState(server?.url ?? '')
    const [headers, setHeaders] = useState(recordText(server?.headers))
    const [command, setCommand] = useState(server?.command ?? '')
    const [args, setArgs] = useState((server?.args ?? []).join('\n'))
    const [env, setEnv] = useState(recordText(server?.env))
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const isHttp = transport === 'http'
    const canSave =
        !saving &&
        name.trim().length > 0 &&
        SERVER_KEY_RE.test(serverKey.trim()) &&
        (isHttp ? url.trim().length > 0 : command.trim().length > 0)

    const save = async (): Promise<void> => {
        if (!canSave) return
        setSaving(true)
        setError(null)
        try {
            const parsedHeaders = isHttp ? parseRecord(headers) : undefined
            const parsedEnv = isHttp ? undefined : parseRecord(env)
            const parsedArgs = isHttp
                ? undefined
                : args
                      .split('\n')
                      .map((arg) => arg.trim())
                      .filter(Boolean)
            let saved: UserMcpServer
            if (server) {
                const body: UpdateUserMcpServerBody = {
                    serverKey: serverKey.trim(),
                    name: name.trim(),
                    description: description.trim() || null,
                    transport,
                    url: isHttp ? url.trim() : null,
                    headers: isHttp ? (parsedHeaders ?? null) : null,
                    command: isHttp ? null : command.trim(),
                    args: isHttp ? null : (parsedArgs ?? []),
                    env: isHttp ? null : (parsedEnv ?? null)
                }
                saved = await client.mcp.library.update(server.id, body)
            } else {
                const body: CreateUserMcpServerBody = {
                    serverKey: serverKey.trim(),
                    name: name.trim(),
                    description: description.trim() || undefined,
                    transport,
                    url: isHttp ? url.trim() : undefined,
                    headers: parsedHeaders,
                    command: isHttp ? undefined : command.trim(),
                    args: parsedArgs,
                    env: parsedEnv
                }
                saved = await client.mcp.library.create(body)
            }
            onSaved(saved)
        } catch (err) {
            setError(
                err instanceof Error && err.message === 'invalid-record'
                    ? t('web.customize.myMcpInvalidRecord')
                    : apiErrorMessage(err)
            )
        } finally {
            setSaving(false)
        }
    }

    const submit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault()
        void save()
    }

    return (
        <ProductDialog
            title={t(
                server
                    ? 'web.customize.myMcpEditTitle'
                    : 'web.customize.myMcpCreateTitle'
            )}
            description={t('web.customize.myMcpFormSubtitle')}
            size='lg'
            onClose={onClose}
            onSubmit={submit}
            closeDisabled={saving}
            footer={
                <>
                    <button
                        type='button'
                        onClick={onClose}
                        disabled={saving}
                        className='workbench-button-secondary'
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        type='submit'
                        disabled={!canSave}
                        className='workbench-button-primary'
                    >
                        {saving ? (
                            <>
                                <Spinner size={16} className='mr-2' />
                                {t('common.saving')}
                            </>
                        ) : (
                            t('common.save')
                        )}
                    </button>
                </>
            }
        >
            {error && <div className='workbench-alert-error mb-4'>{error}</div>}

            <div className='space-y-4'>
                <div className='grid gap-4 sm:grid-cols-2'>
                    <label className='block'>
                        <span className='workbench-field-label'>
                            {t('web.customize.myMcpNameLabel')}
                        </span>
                        <input
                            value={name}
                            maxLength={120}
                            onChange={(event) => setName(event.target.value)}
                            className='workbench-input mt-1'
                        />
                    </label>
                    <label className='block'>
                        <span className='workbench-field-label'>
                            {t('web.customize.myMcpKeyLabel')}
                        </span>
                        <input
                            value={serverKey}
                            maxLength={64}
                            onChange={(event) =>
                                setServerKey(event.target.value)
                            }
                            className='workbench-input mt-1 font-mono'
                            placeholder='context7'
                        />
                        <span className='text-caption text-muted mt-1 block'>
                            {t('web.customize.myMcpKeyHint')}
                        </span>
                    </label>
                </div>

                <label className='block'>
                    <span className='workbench-field-label'>
                        {t('web.customize.myMcpDescriptionLabel')}
                    </span>
                    <textarea
                        value={description}
                        maxLength={1000}
                        rows={2}
                        onChange={(event) => setDescription(event.target.value)}
                        className='workbench-input mt-1 min-h-20 resize-y py-2.5'
                    />
                </label>

                <div>
                    <span className='workbench-field-label'>
                        {t('web.customize.myMcpTransportLabel')}
                    </span>
                    <WorkbenchSelect
                        className='mt-1 max-w-xs'
                        value={transport}
                        onChange={(value) =>
                            setTransport(value as McpCatalogTransport)
                        }
                        options={[
                            {
                                value: 'http',
                                label: t('web.customize.transportHttp')
                            },
                            {
                                value: 'stdio',
                                label: t('web.customize.transportStdio')
                            }
                        ]}
                    />
                </div>

                {isHttp ? (
                    <>
                        <label className='block'>
                            <span className='workbench-field-label'>
                                {t('web.customize.myMcpUrlLabel')}
                            </span>
                            <input
                                value={url}
                                maxLength={1000}
                                onChange={(event) => setUrl(event.target.value)}
                                className='workbench-input mt-1 font-mono'
                                placeholder='https://mcp.example.com/mcp'
                            />
                        </label>
                        <JsonRecordField
                            label={t('web.customize.myMcpHeadersLabel')}
                            hint={t('web.customize.myMcpHeadersHint')}
                            value={headers}
                            onChange={setHeaders}
                        />
                    </>
                ) : (
                    <>
                        <label className='block'>
                            <span className='workbench-field-label'>
                                {t('web.customize.myMcpCommandLabel')}
                            </span>
                            <input
                                value={command}
                                maxLength={255}
                                onChange={(event) =>
                                    setCommand(event.target.value)
                                }
                                className='workbench-input mt-1 font-mono'
                                placeholder='npx'
                            />
                        </label>
                        <label className='block'>
                            <span className='workbench-field-label'>
                                {t('web.customize.myMcpArgsLabel')}
                            </span>
                            <textarea
                                value={args}
                                rows={4}
                                onChange={(event) =>
                                    setArgs(event.target.value)
                                }
                                className='workbench-input mt-1 min-h-28 resize-y py-2.5 font-mono'
                            />
                            <span className='text-caption text-muted mt-1 block'>
                                {t('web.customize.myMcpArgsHint')}
                            </span>
                        </label>
                        <JsonRecordField
                            label={t('web.customize.myMcpEnvLabel')}
                            hint={t('web.customize.myMcpEnvHint')}
                            value={env}
                            onChange={setEnv}
                        />
                    </>
                )}
            </div>
        </ProductDialog>
    )
}

const JsonRecordField: FC<{
    label: string
    hint: string
    value: string
    onChange: (value: string) => void
}> = ({ label, hint, value, onChange }): ReactNode => (
    <label className='block'>
        <span className='workbench-field-label'>{label}</span>
        <textarea
            value={value}
            rows={4}
            onChange={(event) => onChange(event.target.value)}
            className='workbench-input mt-1 min-h-28 resize-y py-2.5 font-mono'
            placeholder={'{\n  "Authorization": "Bearer …"\n}'}
        />
        <span className='text-caption text-muted mt-1 block'>{hint}</span>
    </label>
)

export default UserMcpServerDialog
