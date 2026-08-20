import type { AdminChatSessionTurn } from '@manyfold/shared'

type TurnEvidence = Pick<
    AdminChatSessionTurn,
    'compactedStreamRows' | 'streamCompactedAt'
>

interface TurnCompaction {
    compacted: boolean
    label: string
    at: string
}

// Admin reads the stream rows that are still stored, so a turn with almost no
// events is either a quiet turn or a compacted one and the page cannot tell
// which. This is the turn's own answer.
//
// The two figures are independent: the row count is cumulative over every run
// that touched the turn, the timestamp is only the last of them. A count with
// no timestamp is possible in stored data (nothing writes one, but nothing
// forbids one either), and saying so beats rendering `Invalid Date`.
export const turnCompaction = (
    turn: TurnEvidence,
    locale?: string
): TurnCompaction => {
    const rows = turn.compactedStreamRows
    if (!Number.isFinite(rows) || rows <= 0)
        return { compacted: false, label: '—', at: '' }
    const at = turn.streamCompactedAt
    const parsed = at === null ? Number.NaN : Date.parse(at)
    return {
        compacted: true,
        label: `compacted ×${rows.toLocaleString(locale)}`,
        at: Number.isNaN(parsed)
            ? 'time unknown'
            : new Date(parsed).toLocaleString(locale)
    }
}

interface SessionCompaction {
    turns: number
    rows: number
    note: string | null
}

// The session's event counts are a live count of surviving rows, so they are
// post-compaction by construction — which only misleads once something has
// actually been compacted. The note is scoped to "the turns listed" because
// that is all this page loads; claiming a session total would be a number
// nothing here measured.
export const sessionCompaction = (
    turns: readonly TurnEvidence[],
    locale?: string
): SessionCompaction => {
    let compacted = 0
    let rows = 0
    for (const turn of turns) {
        const value = turn.compactedStreamRows
        if (!Number.isFinite(value) || value <= 0) continue
        compacted += 1
        rows += value
    }
    return {
        turns: compacted,
        rows,
        note:
            compacted === 0
                ? null
                : `Counts are post-compaction: retention has deleted ${rows.toLocaleString(locale)} token/thinking row${rows === 1 ? '' : 's'} from ${compacted === 1 ? 'the turn' : `${compacted} of the turns`} listed below.`
    }
}
