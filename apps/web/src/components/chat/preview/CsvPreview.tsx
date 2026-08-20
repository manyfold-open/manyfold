import { useMemo } from 'react'
import type { FC, ReactNode } from 'react'
import DataTable from '@/components/chat/preview/DataTable'
import EmptyState from '@/components/EmptyState'
import { parseCsv } from '@/components/chat/preview/parseCsv'
import {
    CSV_MAX_RENDER_COLS,
    CSV_MAX_RENDER_ROWS
} from '@/components/chat/preview/previewKinds'
import { useI18n } from '@/lib/i18n'

interface CsvPreviewProps {
    text: string
}

const CsvPreview: FC<CsvPreviewProps> = ({ text }): ReactNode => {
    const { t } = useI18n()
    const table = useMemo(() => {
        const records = parseCsv(text)
        if (records.length === 0) return null
        const headerRow = records[0]
        const colCount = Math.min(headerRow.length, CSV_MAX_RENDER_COLS)
        const headers = headerRow.slice(0, colCount)
        const rows = records.slice(1, 1 + CSV_MAX_RENDER_ROWS).map((record) => {
            const cells = record.slice(0, colCount)
            while (cells.length < colCount) cells.push('')
            return cells
        })
        return {
            headers,
            rows,
            rowsTruncated: records.length - 1 > CSV_MAX_RENDER_ROWS,
            colsTruncated: headerRow.length > CSV_MAX_RENDER_COLS
        }
    }, [text])

    if (!table)
        return (
            <EmptyState
                kind='no-results'
                tier='line'
                body={t('web.workspaceFiles.previewEmptyTable')}
                className='flex h-full items-center justify-center text-center'
            />
        )

    const noteParts: string[] = []
    if (table.rowsTruncated)
        noteParts.push(
            t('web.workspaceFiles.previewRowsTruncated', {
                count: CSV_MAX_RENDER_ROWS
            })
        )
    if (table.colsTruncated)
        noteParts.push(
            t('web.workspaceFiles.previewColsTruncated', {
                count: CSV_MAX_RENDER_COLS
            })
        )

    return (
        <DataTable
            headers={table.headers}
            rows={table.rows}
            note={noteParts.length > 0 ? noteParts.join(' ') : undefined}
        />
    )
}

export default CsvPreview
