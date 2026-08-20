import { useEffect, useState } from 'react'
import type { FC, ReactNode } from 'react'
import {
    MAX_ZIP_INFLATED_BYTES,
    PREVIEW_PARSE_TIMEOUT_MS
} from '@/components/chat/preview/previewKinds'
import { zipDeclaredInflatedSize } from '@/components/chat/preview/zipDeclaredSize'
import type { DocxWorkerResponse } from '@/components/chat/preview/docxWorker'
import { useI18n } from '@/lib/i18n'

interface DocxPreviewProps {
    data: ArrayBuffer
    title: string
}

type DocxState =
    | { status: 'loading' }
    | { status: 'ready'; html: string }
    | { status: 'error'; message: string }
    | { status: 'too-large' }
    | { status: 'timeout' }

const wrapDocxHtml = (body: string): string =>
    [
        '<!doctype html><html><head><meta charset="utf-8"><style>',
        'body{font-family:system-ui,-apple-system,sans-serif;margin:24px}',
        'img{max-width:100%}',
        'table{border-collapse:collapse}',
        'td,th{border:1px solid #d0d0d0;padding:4px 8px}',
        '</style></head><body>',
        body,
        '</body></html>'
    ].join('')

const DocxPreview: FC<DocxPreviewProps> = ({ data, title }): ReactNode => {
    const { t } = useI18n()
    const [state, setState] = useState<DocxState>({ status: 'loading' })

    useEffect(() => {
        setState({ status: 'loading' })
        // the 10 MB cap upstream measures compressed bytes; reject zip bombs
        // by their declared inflated size before any unzip work happens
        const declared = zipDeclaredInflatedSize(data)
        if (declared !== null && declared > MAX_ZIP_INFLATED_BYTES) {
            setState({ status: 'too-large' })
            return
        }
        let cancelled = false
        // mammoth parses in a worker so a hostile docx (e.g. lying zip headers
        // that inflate past their declared size) stays terminable
        const worker = new Worker(
            new URL('./docxWorker.ts', import.meta.url),
            { type: 'module' }
        )
        const timer = window.setTimeout(() => {
            worker.terminate()
            setState({ status: 'timeout' })
        }, PREVIEW_PARSE_TIMEOUT_MS)
        worker.onmessage = (event: MessageEvent<DocxWorkerResponse>) => {
            window.clearTimeout(timer)
            worker.terminate()
            if (cancelled) return
            const message = event.data
            if (message.ok)
                setState({ status: 'ready', html: wrapDocxHtml(message.html) })
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
    // sandbox='' = fully locked iframe (unlike HtmlPreview's allow-scripts):
    // mammoth output never needs scripts; data-URI images still render
    return (
        <iframe
            srcDoc={state.html}
            title={title}
            sandbox=''
            referrerPolicy='no-referrer'
            className='shadow-ring-light h-full min-h-[24rem] w-full rounded-md bg-white'
        />
    )
}

export default DocxPreview
