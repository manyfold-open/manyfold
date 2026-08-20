import type { FC, ReactNode } from 'react'
import { useMemo } from 'react'
import { useI18n } from '@/lib/i18n'

type DiffLineType = 'add' | 'remove' | 'context'

interface DiffLine {
    type: DiffLineType
    text: string
    oldNo?: number
    newNo?: number
}

interface Props {
    oldText?: string
    newText?: string
    unifiedPatch?: string
    maxLines?: number
}

const ToolDiffViewer: FC<Props> = ({
    oldText,
    newText,
    unifiedPatch,
    maxLines = 600
}): ReactNode => {
    const { t } = useI18n()
    const lines = useMemo(() => {
        if (unifiedPatch) return parseUnifiedPatch(unifiedPatch)
        if (oldText == null && newText != null)
            return splitLines(newText).map<DiffLine>((text, i) => ({
                type: 'add',
                text,
                newNo: i + 1
            }))
        if (oldText != null && newText == null)
            return splitLines(oldText).map<DiffLine>((text, i) => ({
                type: 'remove',
                text,
                oldNo: i + 1
            }))
        return diffLines(splitLines(oldText ?? ''), splitLines(newText ?? ''))
    }, [oldText, newText, unifiedPatch])

    if (lines.length === 0)
        return (
            <div className='text-caption text-subtle font-mono'>
                {t('web.chat.tools.emptyDiff')}
            </div>
        )

    const truncated = lines.length > maxLines
    const shown = truncated ? lines.slice(0, maxLines) : lines

    return (
        <div className='shadow-ring-light overflow-hidden rounded-md font-mono'>
            <div className='text-caption max-h-[60vh] overflow-auto bg-[#fafafa]'>
                {shown.map((l, i) => (
                    <DiffRow key={i} line={l} />
                ))}
                {truncated && (
                    <div className='text-caption text-subtle border-divider border-t bg-white px-3 py-1.5'>
                        {t('web.chat.tools.moreLinesTruncated', {
                            count: lines.length - maxLines
                        })}
                    </div>
                )}
            </div>
        </div>
    )
}

const DiffRow: FC<{ line: DiffLine }> = ({ line }) => {
    const bg =
        line.type === 'add'
            ? 'bg-[#ecfdf3]'
            : line.type === 'remove'
              ? 'bg-[#fef2f2]'
              : 'bg-transparent'
    const marker =
        line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '
    const markerColor =
        line.type === 'add'
            ? 'text-[#0a8a3e]'
            : line.type === 'remove'
              ? 'text-workflow-ship'
              : 'text-subtle'
    return (
        <div className={`flex ${bg}`}>
            <span className='text-subtle w-10 px-2 text-right select-none'>
                {line.oldNo ?? ''}
            </span>
            <span className='text-subtle w-10 px-2 text-right select-none'>
                {line.newNo ?? ''}
            </span>
            <span
                className={`${markerColor} w-5 text-center font-medium select-none`}
            >
                {marker}
            </span>
            <span className='text-fg flex-1 pr-3 break-all whitespace-pre-wrap'>
                {line.text || ' '}
            </span>
        </div>
    )
}

const splitLines = (s: string): string[] => {
    if (s === '') return []
    const lines = s.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    return lines
}

const diffLines = (a: string[], b: string[]): DiffLine[] => {
    const n = a.length
    const m = b.length
    const dp: number[][] = Array.from({ length: n + 1 }, () =>
        new Array(m + 1).fill(0)
    )
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            dp[i][j] =
                a[i] === b[j]
                    ? dp[i + 1][j + 1] + 1
                    : Math.max(dp[i + 1][j], dp[i][j + 1])

    const out: DiffLine[] = []
    let i = 0
    let j = 0
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            out.push({
                type: 'context',
                text: a[i],
                oldNo: i + 1,
                newNo: j + 1
            })
            i++
            j++
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            out.push({ type: 'remove', text: a[i], oldNo: i + 1 })
            i++
        } else {
            out.push({ type: 'add', text: b[j], newNo: j + 1 })
            j++
        }
    }
    while (i < n) {
        out.push({ type: 'remove', text: a[i], oldNo: i + 1 })
        i++
    }
    while (j < m) {
        out.push({ type: 'add', text: b[j], newNo: j + 1 })
        j++
    }
    return out
}

const parseUnifiedPatch = (patch: string): DiffLine[] => {
    const out: DiffLine[] = []
    let oldNo = 0
    let newNo = 0
    for (const raw of patch.split('\n')) {
        if (
            raw.startsWith('---') ||
            raw.startsWith('+++') ||
            raw.startsWith('***')
        ) {
            out.push({ type: 'context', text: raw })
            continue
        }
        if (raw.startsWith('@@')) {
            const m = raw.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/)
            if (m) {
                oldNo = parseInt(m[1], 10)
                newNo = parseInt(m[2], 10)
            }
            out.push({ type: 'context', text: raw })
            continue
        }
        if (raw.startsWith('+')) {
            out.push({ type: 'add', text: raw.slice(1), newNo })
            newNo++
            continue
        }
        if (raw.startsWith('-')) {
            out.push({ type: 'remove', text: raw.slice(1), oldNo })
            oldNo++
            continue
        }
        out.push({
            type: 'context',
            text: raw.startsWith(' ') ? raw.slice(1) : raw,
            oldNo,
            newNo
        })
        oldNo++
        newNo++
    }
    return out
}

export default ToolDiffViewer
