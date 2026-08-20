import { sql, type SQL } from 'drizzle-orm'
import {
    chatMessages,
    chatMessageSources,
    chatSessions,
    plans,
    turnExecutions,
    users
} from '@manyfold/db'
import { ASSISTANT_BLOCKS_TRUNCATION_MARKER } from '@/modules/chat/assistant-blocks'
import {
    isRepresentableWindowDays,
    RETENTION_WINDOW_MAX_DAYS
} from './retention-window'

// What a clear removes is the raw runner transcript cached alongside a turn —
// never the canonical transcript. content_blocks_json, and therefore
// everything the product shows a user, is untouched, and so is
// plans.message_history_retention_days: no plan promise is narrowed by this.
//
// The default window is still derived rather than picked. 180 is the longest
// finite window the shipped plan seed carries (0068_plan_limits_expansion:
// free 30, hobby 90, plus 180, pro NULL), so a clear at this age cannot take
// a payload sooner than a plan we already sell would have deleted the whole
// message. That seed is no guarantee about a self-hosted database, so it is a
// floor and not the answer: resolveEffectiveRawClearDays widens it to the
// live maximum whenever an operator's own plans table promises more.
export const SOURCE_RAW_CLEAR_FLOOR_DAYS = 180

// Rows per batch, and the inter-batch pause the sibling sweeps use. A row is
// one transcript line rather than one token, so a batch this size is orders
// of magnitude smaller than a compaction batch of the same size.
export const SOURCE_RAW_CLEAR_BATCH_SIZE = 200
export const SOURCE_RAW_CLEAR_BATCH_PAUSE_MS = 200
// One cap, not the two compaction needs: rows are counted directly here, so
// there is no unknown rows-per-candidate ratio to bound separately.
export const SOURCE_RAW_CLEAR_MAX_ROWS_PER_RUN = 50_000

export interface RawClearWindow {
    days: number
    invalid: boolean
}

// Fail closed. This sweep destroys payloads with no env set, so the dangerous
// misreading of `MF_SOURCE_RAW_CLEAR_AFTER_DAYS=18O` is not "it stayed off",
// it is "a typo silently enabled a 180-day clear". An unparseable or
// unrepresentable value therefore disables the sweep and is reported, rather
// than falling back to a default the operator plainly did not mean to accept.
export const resolveRawClearWindow = (
    raw: string | undefined
): RawClearWindow => {
    if (raw === undefined || raw.trim() === '')
        return { days: SOURCE_RAW_CLEAR_FLOOR_DAYS, invalid: false }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return { days: 0, invalid: true }
    if (parsed <= 0) return { days: 0, invalid: false }
    const days = Math.max(SOURCE_RAW_CLEAR_FLOOR_DAYS, Math.floor(parsed))
    if (!isRepresentableWindowDays(days)) return { days: 0, invalid: true }
    return { days, invalid: false }
}

// Never clear a payload before the most generous plan window in THIS database
// has expired. The seeded floor above is only what our own plans table says
// today; an operator who sells a 3650-day plan gets a 3650-day raw window
// without touching the env, and the widening is one-way, so no plan edit can
// make the sweep more aggressive than the configured value.
export const resolveEffectiveRawClearDays = (
    configuredDays: number,
    planFloorDays: number
): number =>
    configuredDays === 0 ? 0 : Math.max(configuredDays, planFloorDays)

export const planRetentionFloorQuery = (): SQL => sql`
    select coalesce(max(message_history_retention_days), 0)::int as days
    from ${plans}
    where message_history_retention_days > 0
`

export const rawClearCutoff = (now: Date, afterDays: number): Date =>
    new Date(now.getTime() - afterDays * 24 * 60 * 60 * 1000)

export interface RawClearCursor {
    createdAt: string
    id: string
}

// `-infinity` rather than a sentinel date: the cursor is a real timestamptz
// bound, and every run restarts from it.
export const INITIAL_RAW_CLEAR_CURSOR: RawClearCursor = {
    createdAt: '-infinity',
    id: ''
}

export type RawClearScope =
    | { kind: 'age'; cutoff: Date; after: RawClearCursor }
    | { kind: 'plan'; cutoff: Date; userId: string }

export interface RawClearBatch {
    scanned: number
    cleared: number
    cursor: RawClearCursor | null
}

// The single definition of "this payload is safe to drop", shared by BOTH
// clearing paths. Plan-based retention had none of these exemptions, so a
// paying user's stuck turn could already lose its payload; keeping one
// predicate is what stops the two paths drifting apart again.
//
// Written entirely as `not exists` so it is null-safe by construction: a row
// whose message was already pruned has message_id NULL, no subquery matches,
// and every exemption passes. An earlier `is distinct from` spelling got this
// backwards — `null is distinct from null` is false — and exempted exactly
// the orphaned rows with the least reason to keep a payload.
//
//   turn_executions — adoption rebuilds a turn's seen state by JSON.parsing
//   raw_text (buildSeenStateFromPersisted). A cleared row parses to nothing:
//   the already-covered text prefix collapses to '' and every delivered token
//   re-appears as an unmatched delta run, which bails the whole adoption to
//   result_lost. listAdoptableTurnExecutions has no upper age bound, so no
//   choice of window rules this out — only the open execution row does. Only
//   Claude adoption actually parses these lines, so exempting every open
//   execution is deliberately broader than the reader strictly needs.
//
//   inflight_message_id — the live writer is still appending source rows to
//   that message. This is the one that bites plan-based retention in real
//   life: deleteMessageBatch already refuses to delete an inflight message,
//   so a turn orphaned while holding the lock keeps its message past the plan
//   cutoff while its payload was being cleared out from under it.
//
//   the truncation marker — the same durability contract the compaction sweep
//   honours, from the same constant. Once content_blocks_json is truncated
//   the raw lines are a full copy of a turn the transcript no longer has,
//   and the two sweeps must not drift into clearing different halves of it.
//
// None of the three can leave deleted content behind: turn_executions
// cascades on message delete and the other two key off a message that no
// longer exists, so plan retention's own rows stay clearable.
const payloadPresent = (alias: string): SQL => {
    const s = sql.raw(alias)
    return sql`
        ${s}.raw_cleared_at is null
        and (${s}.raw_text is not null or ${s}.raw_json is not null)
    `
}

const readersDone = (alias: string): SQL => {
    const s = sql.raw(alias)
    return sql`
        not exists (
            select 1
            from ${chatSessions} cs
            where cs.id = ${s}.session_id
              and cs.inflight_message_id = ${s}.message_id
        )
        and not exists (
            select 1
            from ${chatMessages} m
            where m.id = ${s}.message_id
              and left(
                      coalesce(m.content_blocks_json -> 0 ->> 'text', ''),
                      ${ASSISTANT_BLOCKS_TRUNCATION_MARKER.length}
                  ) = ${ASSISTANT_BLOCKS_TRUNCATION_MARKER}
        )
        and not exists (
            select 1
            from ${turnExecutions} te
            where te.message_id = ${s}.message_id
              and te.state in ('running', 'handoff', 'adopting')
        )
    `
}

const eligible = (alias: string): SQL =>
    sql`${payloadPresent(alias)} and ${readersDone(alias)}`

// Every exemption above hangs off the message row, so a message this run is
// about to delete takes all three with it: the FK nulls message_id,
// turn_executions cascades, and an orphan then passes every clause by
// construction — the same null-safety the rewrite made explicit.
//
// That is correct for the real run (plan retention deleted the transcript, so
// the raw copy must not outlive it) but it inverts a preview: sweepUser
// deletes messages BEFORE it clears sources, while a dry run mutates nothing,
// so a count taken against the pre-delete state promises to KEEP a row the
// real run clears. An old truncated non-inflight message is exactly that
// case. Previews treat a message scheduled for deletion as already gone.
//
// The cutoff is the one the run CAPTURED, passed in rather than re-derived
// from the live plans table and database now(). Re-deriving made this a
// second decision that merely usually agreed with the first: a plan upgraded
// mid-run, or a clock boundary crossed between the two reads, would let the
// preview omit a row the matching run deletes and clears. This mirrors
// deleteMessageBatch's predicate exactly, on the same instant.
const messageScheduledForDeletion = (alias: string, cutoff: Date): SQL => {
    const s = sql.raw(alias)
    return sql`
        exists (
            select 1
            from ${chatMessages} dm
            join ${chatSessions} dcs on dcs.id = dm.session_id
            where dm.id = ${s}.message_id
              and dm.created_at < ${cutoff.toISOString()}::timestamptz
              and dm.id is distinct from dcs.inflight_message_id
        )
    `
}

const previewEligible = (alias: string, cutoff: Date): SQL =>
    sql`${payloadPresent(alias)}
        and (
            ${messageScheduledForDeletion(alias, cutoff)}
            or (${readersDone(alias)})
        )`

// The two phases are disjoint by construction rather than by timing. The plan
// phase owns every user whose plan carries a finite window; the fleet-age
// phase owns the rest. In a real run the age sweep never saw those rows
// anyway — the plan phase had cleared them, so raw_cleared_at was set — but a
// dry run mutates nothing, so without this the age preview re-counted every
// row the plan preview had just reported. Stating the split as a predicate
// makes preview and run the same decision instead of two that differ by
// whatever the earlier phase happened to do first.
//
// The upper bound matches sweepRetention's own skip, so a plan window too
// large to sweep does not fall between the two phases.
const ownerSweptByPlanRetention = (alias: string): SQL => {
    const s = sql.raw(alias)
    return sql`
        exists (
            select 1
            from ${chatSessions} pcs
            join ${users} pu on pu.id = pcs.user_id
            join ${plans} pp on pp.id = pu.plan_id
            where pcs.id = ${s}.session_id
              and pp.message_history_retention_days > 0
              and pp.message_history_retention_days
                  <= ${RETENTION_WINDOW_MAX_DAYS}
        )
    `
}

const scopeFilter = (scope: RawClearScope): SQL => {
    // A raw sql`` template has no column to infer an encoder from, and the
    // driver refuses a bare Date there — so timestamps are bound as text with
    // an explicit cast rather than left to the driver to guess.
    const cutoff = scope.cutoff.toISOString()
    if (scope.kind === 'plan')
        return sql`
        s.created_at < ${cutoff}::timestamptz
        and exists (
            select 1
            from ${chatSessions} owner
            where owner.id = s.session_id
              and owner.user_id = ${scope.userId}
        )`
    return sql`
        s.created_at < ${cutoff}::timestamptz
        and (s.created_at, s.id) >
            (${scope.after.createdAt}::timestamptz, ${scope.after.id})
        and not ${ownerSweptByPlanRetention('s')}`
}

// Selection and write in ONE statement, so there is no window between
// deciding a payload is droppable and dropping it: a turn that gains an open
// execution row cannot slip into the gap, because there is none. The
// predicate is repeated on the update so the reported figure is rows actually
// written — and so a concurrently committed change to the target row is
// re-checked under EvalPlanQual — rather than rows a stale select once liked.
//
// The keyset pages on (created_at, id) to match
// chat_message_sources_raw_pending_idx exactly: leading on created_at makes
// the scan a range that stops at the cutoff, so a drained fleet costs one
// empty range probe a day, not a walk over every uncleared row in the window.
//
// SKIP LOCKED so a row a live upsert is holding is stepped over rather than
// blocking the sweep behind it. Skipping is free: the cursor restarts at
// -infinity on the next run, so a skipped row is simply cleared tomorrow.
// A preview takes no locks at all and so cannot observe that deferral; its
// figure is an upper bound, and the log says so.
//
// The preview also swaps in previewEligible: a dry run mutates nothing, so it
// has to model the message deletions the real run performs first.
// Only the plan phase deletes messages before it clears, so only its preview
// has anything to model; the age phase now excludes those users outright and
// previews with the identical predicate its real run uses.
const rowFilter = (scope: RawClearScope, apply: boolean): SQL =>
    apply || scope.kind === 'age'
        ? eligible('s')
        : previewEligible('s', scope.cutoff)

export const rawClearStatement = (
    scope: RawClearScope,
    limit: number,
    apply: boolean
): SQL => {
    const clearedCte = apply
        ? sql`,
    cleared as (
        update ${chatMessageSources} u
        set raw_text = null,
            raw_json = null,
            raw_cleared_at = now(),
            updated_at = now()
        where u.id in (select id from candidate)
          and ${eligible('u')}
        returning u.id
    )`
        : sql``
    const clearedCount = apply
        ? sql`(select count(*) from cleared)::int`
        : sql`0`
    const locking = apply
        ? sql`
        for update of s skip locked`
        : sql``
    return sql`
    with candidate as (
        select s.id as id, s.created_at as created_at
        from ${chatMessageSources} s
        where ${scopeFilter(scope)}
          and ${rowFilter(scope, apply)}
        order by s.created_at, s.id
        limit ${limit}${locking}
    ),
    cursor_row as (
        select created_at, id
        from candidate
        order by created_at desc, id desc
        limit 1
    )${clearedCte}
    select
        (select count(*) from candidate)::int as scanned,
        ${clearedCount} as cleared,
        (select created_at from cursor_row) as cursor_at,
        (select id from cursor_row) as cursor_id
`
}

// Preview only, so it models the deletes sweepUser performs before it clears
// (see messageScheduledForDeletion) and takes no locks — a row a live writer
// holds counts here but is deferred by the real run, so this is an upper
// bound rather than an exact figure.
export const countClearableSourceRaw = (scope: RawClearScope): SQL => sql`
    select count(*)::int as value
    from ${chatMessageSources} s
    where ${scopeFilter(scope)}
      and ${rowFilter(scope, false)}
`

export const readRawClearBatch = (rows: unknown[]): RawClearBatch => {
    const row = rows[0] as
        | {
              scanned: number | string | null
              cleared: number | string | null
              cursor_at: Date | string | null
              cursor_id: string | null
          }
        | undefined
    const cursorAt = row?.cursor_at
    const cursorId = row?.cursor_id
    return {
        scanned: Number(row?.scanned ?? 0),
        cleared: Number(row?.cleared ?? 0),
        cursor:
            cursorAt == null || cursorId == null
                ? null
                : {
                      createdAt:
                          cursorAt instanceof Date
                              ? cursorAt.toISOString()
                              : cursorAt,
                      id: cursorId
                  }
    }
}
