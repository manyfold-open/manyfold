import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import DataTable from '@/components/chat/preview/DataTable'
import EmptyState from '@/components/EmptyState'
import {
    MAX_ZIP_INFLATED_BYTES,
    PREVIEW_PARSE_TIMEOUT_MS,
    SHEET_MAX_ROWS
} from '@/components/chat/preview/previewKinds'
import { zipDeclaredInflatedSize } from '@/components/chat/preview/zipDeclaredSize'
import type {
    SheetSnapshot,
    XlsxWorkerResponse
} from '@/components/chat/preview/xlsxWorker'

type XlsxState =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'too-large' }
    | { status: 'timeout' }
    | { status: 'ready'; sheets: SheetSnapshot[] }

interface XlsxPreviewProps {
    data: ArrayBuffer
}

const XlsxPreview: FC<XlsxPreviewProps> = ({ data }): ReactNode => {
    const { t } = useI18n()
    const [state, setState] = useState<XlsxState>({ status: 'loading' })
    const [sheetIndex, setSheetIndex] = useState(0)

    useEffect(() => {
        setState({ status: 'loading' })
        setSheetIndex(0)
        // the 10 MB cap upstream measures compressed bytes; reject zip bombs
        // by their declared inflated size before any unzip work happens
        const declared = zipDeclaredInflatedSize(data)
        if (declared !== null && declared > MAX_ZIP_INFLATED_BYTES) {
            setState({ status: 'too-large' })
            return
        }
        let cancelled = false
        // exceljs parses in a worker so a hostile xlsx (e.g. lying zip headers
        // that inflate past their declared size) stays terminable
        const worker = new Worker(new URL('./xlsxWorker.ts', import.meta.url), {
            type: 'module'
        })
        const timer = window.setTimeout(() => {
            worker.terminate()
            setState({ status: 'timeout' })
        }, PREVIEW_PARSE_TIMEOUT_MS)
        worker.onmessage = (event: MessageEvent<XlsxWorkerResponse>) => {
            window.clearTimeout(timer)
            worker.terminate()
            if (cancelled) return
            const message = event.data
            if (message.ok)
                setState({ status: 'ready', sheets: message.sheets })
            else setState({ status: 'error', message: message.message })
        }
        worker.onerror = (event: ErrorEvent) => {
            window.clearTimeout(timer)
            worker.terminate()
            if (cancelled) return
            setState({
                status: 'error',
                message: event.message || t('web.workspaceFiles.previewWorkerFailed')
            })
        }
        worker.postMessage(data)
        return () => {
            cancelled = true
            window.clearTimeout(timer)
            worker.terminate()
        }
    }, [data, t])

    if (state.status === 'loading')
        return (
            <div className='text-ui text-muted flex h-full items-center justify-center text-center'>
                {t('web.workspaceFiles.previewLoading')}
            </div>
        )

    if (state.status === 'too-large')
        return (
            <div className='text-ui text-muted flex h-full items-center justify-center text-center'>
                {t('web.workspaceFiles.previewInflatedTooLarge')}
            </div>
        )

    if (state.status === 'timeout')
        return (
            <div className='text-ui text-muted flex h-full items-center justify-center text-center'>
                {t('web.workspaceFiles.previewTimeout')}
            </div>
        )

    if (state.status === 'error')
        return (
            <div className='text-ui text-muted flex h-full items-center justify-center text-center'>
                {t('web.workspaceFiles.previewRenderError', {
                    message: state.message
                })}
            </div>
        )

    if (state.sheets.length === 0)
        return (
            <EmptyState
                kind='no-results'
                tier='line'
                body={t('web.workspaceFiles.previewEmptyTable')}
                className='flex h-full items-center justify-center text-center'
            />
        )

    const activeIndex = Math.min(sheetIndex, state.sheets.length - 1)
    const activeSheet = state.sheets[activeIndex]

    return (
        <div className='flex h-full flex-col gap-4'>
            <div className='scrollbar-hidden flex shrink-0 items-center gap-1 overflow-x-auto'>
                {state.sheets.map((sheet, index) => (
                    <button
                        key={index}
                        type='button'
                        className={[
                            'text-ui inline-flex h-8 shrink-0 items-center rounded-md px-2.5 font-medium transition-colors',
                            index === activeIndex
                                ? 'text-fg shadow-ring-light bg-soft'
                                : 'text-muted hover:text-fg hover:bg-soft'
                        ].join(' ')}
                        onClick={() => setSheetIndex(index)}
                    >
                        {sheet.name}
                    </button>
                ))}
            </div>
            {activeSheet.rows.length === 0 ? (
                <EmptyState
                    kind='no-results'
                    tier='line'
                    body={t('web.workspaceFiles.previewEmptyTable')}
                    className='flex flex-1 items-center justify-center text-center'
                />
            ) : (
                <DataTable
                    rows={activeSheet.rows}
                    note={
                        activeSheet.truncated
                            ? t('web.workspaceFiles.previewRowsTruncated', {
                                  count: SHEET_MAX_ROWS
                              })
                            : undefined
                    }
                />
            )}
        </div>
    )
}

export default XlsxPreview
