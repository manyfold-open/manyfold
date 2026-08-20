import { useEffect, useRef, useState } from 'react'
import type { FC, ReactNode } from 'react'
import DataTable from '@/components/chat/preview/DataTable'
import EmptyState from '@/components/EmptyState'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import {
    PREVIEW_PARSE_TIMEOUT_MS,
    SQLITE_MAX_ROWS
} from '@/components/chat/preview/previewKinds'
import type {
    SqliteQueryResult,
    SqliteWorkerRequest,
    SqliteWorkerResponse
} from '@/components/chat/preview/sqliteWorker'
import { useI18n } from '@/lib/i18n'

const pillClass = (active: boolean): string =>
    [
        'text-caption inline-flex h-7 shrink-0 items-center rounded-md px-2.5 font-medium transition-colors',
        active
            ? 'text-fg shadow-ring-light bg-soft'
            : 'text-muted hover:text-fg hover:bg-soft'
    ].join(' ')

const sqliteErrorMessage = (
    message: string,
    translate: (key: string) => string
): string =>
    message === 'database is not open'
        ? translate('web.workspaceFiles.previewDatabaseNotOpen')
        : message

const CenteredNote: FC<{ children: ReactNode }> = ({ children }): ReactNode => (
    <div className='text-ui text-muted flex h-full items-center justify-center text-center'>
        {children}
    </div>
)

type DbState =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'timeout' }
    | { status: 'ready'; objects: string[] }

type QueryState =
    | { status: 'pending' }
    | { status: 'error'; message: string }
    | { status: 'ready'; result: SqliteQueryResult }

interface SqlitePreviewProps {
    data: ArrayBuffer
    walWarning: boolean
}

const SqlitePreview: FC<SqlitePreviewProps> = ({
    data,
    walWarning
}): ReactNode => {
    const { t } = useI18n()
    const workerRef = useRef<Worker | null>(null)
    const timeoutRef = useRef<number | null>(null)
    const queryIdRef = useRef(0)
    const [dbState, setDbState] = useState<DbState>({ status: 'loading' })
    const [selected, setSelected] = useState('')
    const [mode, setMode] = useState<'rows' | 'schema'>('rows')
    const [query, setQuery] = useState<QueryState>({ status: 'pending' })

    useEffect(() => {
        setDbState({ status: 'loading' })
        setSelected('')
        setMode('rows')
        setQuery({ status: 'pending' })
        // sql.js runs in a worker so a hostile database (e.g. a view hiding an
        // unbounded recursive query that auto-executes on open) can never hang
        // the page: any request past PREVIEW_PARSE_TIMEOUT_MS is terminated
        const worker = new Worker(
            new URL('./sqliteWorker.ts', import.meta.url),
            { type: 'module' }
        )
        workerRef.current = worker
        const clearTimer = (): void => {
            if (timeoutRef.current !== null) {
                window.clearTimeout(timeoutRef.current)
                timeoutRef.current = null
            }
        }
        worker.onmessage = (event: MessageEvent<SqliteWorkerResponse>) => {
            const message = event.data
            if (message.type === 'opened') {
                clearTimer()
                setDbState({ status: 'ready', objects: message.objects })
                setSelected(message.objects[0] ?? '')
            } else if (message.type === 'openError') {
                clearTimer()
                setDbState({
                    status: 'error',
                    message: sqliteErrorMessage(message.message, t)
                })
            } else if (message.id === queryIdRef.current) {
                // stale responses keep the timer: it guards the newest request
                clearTimer()
                if (message.type === 'result')
                    setQuery({ status: 'ready', result: message.result })
                else
                    setQuery({
                        status: 'error',
                        message: sqliteErrorMessage(message.message, t)
                    })
            }
        }
        worker.onerror = (event: ErrorEvent) => {
            clearTimer()
            setDbState({
                status: 'error',
                message: event.message || t('web.workspaceFiles.previewWorkerFailed')
            })
        }
        timeoutRef.current = window.setTimeout(() => {
            worker.terminate()
            setDbState({ status: 'timeout' })
        }, PREVIEW_PARSE_TIMEOUT_MS)
        const request: SqliteWorkerRequest = { type: 'open', buffer: data }
        worker.postMessage(request)
        return () => {
            clearTimer()
            worker.terminate()
            workerRef.current = null
        }
    }, [data, t])

    useEffect(() => {
        const worker = workerRef.current
        if (!worker || dbState.status !== 'ready' || !selected) return
        const id = ++queryIdRef.current
        setQuery({ status: 'pending' })
        if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
        timeoutRef.current = window.setTimeout(() => {
            worker.terminate()
            setDbState({ status: 'timeout' })
        }, PREVIEW_PARSE_TIMEOUT_MS)
        const request: SqliteWorkerRequest = {
            type: 'query',
            id,
            name: selected,
            mode
        }
        worker.postMessage(request)
    }, [dbState, selected, mode])

    let body: ReactNode
    if (dbState.status === 'loading')
        body = (
            <CenteredNote>
                {t('web.workspaceFiles.previewLoading')}
            </CenteredNote>
        )
    else if (dbState.status === 'error')
        body = (
            <CenteredNote>
                {t('web.workspaceFiles.previewRenderError', {
                    message: dbState.message
                })}
            </CenteredNote>
        )
    else if (dbState.status === 'timeout')
        body = (
            <CenteredNote>
                {t('web.workspaceFiles.previewTimeout')}
            </CenteredNote>
        )
    else if (dbState.objects.length === 0)
        body = (
            <CenteredNote>
                {t('web.workspaceFiles.previewSqliteNoTables')}
            </CenteredNote>
        )
    else
        body = (
            <div className='flex flex-col gap-3'>
                <div className='flex flex-wrap items-center gap-3'>
                    <div className='text-caption text-muted flex items-center gap-2 font-medium'>
                        {t('web.workspaceFiles.previewSqliteTable')}
                        <WorkbenchSelect
                            size='sm'
                            className='w-44'
                            ariaLabel={t(
                                'web.workspaceFiles.previewSqliteTable'
                            )}
                            value={selected}
                            onChange={setSelected}
                            options={dbState.objects.map((name) => ({
                                value: name,
                                label: name
                            }))}
                        />
                    </div>
                    <div className='flex items-center gap-1'>
                        <button
                            type='button'
                            className={pillClass(mode === 'rows')}
                            onClick={() => setMode('rows')}
                        >
                            {t('web.workspaceFiles.previewSqliteRows')}
                        </button>
                        <button
                            type='button'
                            className={pillClass(mode === 'schema')}
                            onClick={() => setMode('schema')}
                        >
                            {t('web.workspaceFiles.previewSqliteSchema')}
                        </button>
                    </div>
                </div>
                {query.status === 'pending' ? (
                    <div className='text-caption text-muted'>
                        {t('web.workspaceFiles.previewLoading')}
                    </div>
                ) : query.status === 'error' ? (
                    <div className='text-caption text-muted'>
                        {t('web.workspaceFiles.previewRenderError', {
                            message: query.message
                        })}
                    </div>
                ) : query.result.rows.length === 0 ? (
                    <EmptyState
                        kind='no-results'
                        tier='line'
                        body={t('web.workspaceFiles.previewEmptyTable')}
                    />
                ) : (
                    <DataTable
                        headers={query.result.headers}
                        rows={query.result.rows}
                        note={
                            query.result.truncated
                                ? t('web.workspaceFiles.previewRowsTruncated', {
                                      count: SQLITE_MAX_ROWS
                                  })
                                : undefined
                        }
                    />
                )}
            </div>
        )

    return (
        <div className='flex h-full min-h-0 flex-col'>
            {walWarning && (
                <div className='text-caption text-warning mb-3 shrink-0'>
                    {t('web.workspaceFiles.previewSqliteWalWarning')}
                </div>
            )}
            <div className='min-h-0 flex-1'>{body}</div>
        </div>
    )
}

export default SqlitePreview
