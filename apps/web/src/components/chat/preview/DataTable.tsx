import type { FC, ReactNode } from 'react'
import ShortcutTooltip from '@/components/ShortcutTooltip'

interface DataTableProps {
    headers?: string[]
    rows: string[][]
    note?: string
}

const DataTable: FC<DataTableProps> = ({ headers, rows, note }): ReactNode => (
    <div>
        <div className='shadow-ring overflow-x-auto rounded-md'>
            <table className='text-caption w-full border-collapse'>
                {headers && (
                    <thead>
                        <tr>
                            {headers.map((header, index) => (
                                <th
                                    key={index}
                                    className='bg-surface-subtle whitespace-nowrap px-3 py-2 text-left font-medium'
                                >
                                    {header}
                                </th>
                            ))}
                        </tr>
                    </thead>
                )}
                <tbody>
                    {rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                            {row.map((cell, cellIndex) => (
                                <td
                                    key={cellIndex}
                                    className='max-w-[24rem] whitespace-nowrap px-3 py-2 shadow-[inset_0_1px_0_0_rgba(0,0,0,0.08)]'
                                >
                                    <ShortcutTooltip
                                        label={cell}
                                        className='max-w-full'
                                    >
                                        <span className='min-w-0 truncate'>
                                            {cell}
                                        </span>
                                    </ShortcutTooltip>
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
        {note && <div className='text-caption text-muted mt-2'>{note}</div>}
    </div>
)

export default DataTable
