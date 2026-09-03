import test from 'node:test'
import assert from 'node:assert/strict'
import { SpritesError, type ExecSessionInfo } from '@manyfold/sprites'
import {
    abandonedExecSessions,
    SpriteStatusSyncService
} from '../src/modules/agents/sprite-status/sprite-status-sync.service'

const NOW = Date.parse('2026-09-03T12:00:00Z')
const SIX_HOURS = 6 * 60 * 60_000

const session = (over: Partial<ExecSessionInfo> = {}): ExecSessionInfo => ({
    id: 'sess-1',
    command: 'cat',
    workdir: '/home/sprite',
    created: '2026-08-31T22:36:16Z',
    last_activity: '0001-01-01T00:00:00Z',
    is_active: true,
    tty: false,
    bytes_per_second: 0,
    ...over
})

// The exact prod payload shape (nca-api, sprite sbx-agqftt5t…, 2026-09-03): a
// `cat` left by a cancelled upload, is_active with the zero last_activity, and
// the sibling `rm` cleanup session that had already finished.
test('an is_active session idle past the window is abandoned, a finished one is not', () => {
    const abandoned = abandonedExecSessions(
        [
            session({ id: 'live-cat' }),
            session({ id: 'done-rm', command: 'rm', is_active: false })
        ],
        NOW,
        SIX_HOURS
    )
    assert.deepEqual(
        abandoned.map((a) => a.session.id),
        ['live-cat']
    )
    assert.ok(abandoned[0].idleMs > SIX_HOURS)
})

// WHY: the reaper must never truncate a healthy long turn. The turn watchdog's
// default ceiling is 2h and the window is 6h, so a session that started an hour
// ago has to survive — a reaper that reaped on is_active alone would kill every
// running turn in the fleet on its first tick.
test('a young is_active session is left alone', () => {
    assert.deepEqual(
        abandonedExecSessions(
            [
                session({
                    created: new Date(NOW - 60 * 60_000).toISOString()
                })
            ],
            NOW,
            SIX_HOURS
        ),
        []
    )
})

// WHY: sprites.dev populates last_activity on some sprites and not others, so
// the age must come from whichever stamp is real. Reading the zero time
// literally would age every session from year 1 (test 1 depends on the
// fallback); ignoring a fresh last_activity would reap a long-lived session
// that is actively streaming.
test('the age comes from the newest usable stamp', () => {
    const recentlyActive = session({
        created: '2026-08-31T22:36:16Z',
        last_activity: new Date(NOW - 60_000).toISOString()
    })
    assert.deepEqual(
        abandonedExecSessions([recentlyActive], NOW, SIX_HOURS),
        [],
        'a fresh last_activity must override an old created'
    )
})

// WHY fail closed here: with no parseable timestamp there is no evidence of
// abandonment at all, and killing a live turn is far worse than leaving a
// session for a later tick (or for the empty-host reaper).
test('a session with no usable timestamp is never reaped', () => {
    assert.deepEqual(
        abandonedExecSessions(
            [
                session({ created: undefined, last_activity: undefined }),
                session({ created: 'not-a-date', last_activity: '' })
            ],
            NOW,
            SIX_HOURS
        ),
        []
    )
})

interface HostRow {
    id: string
    userId: string
    accountId: string | null
    spriteName: string | null
}

const makeDb = (hosts: HostRow[]) => ({
    select: () => ({
        from: () => ({
            where: () => ({
                limit: async () => hosts
            })
        })
    })
})

interface ClientSpec {
    sessions?: ExecSessionInfo[]
    listError?: Error
}

const makeService = (hosts: HostRow[], spec: ClientSpec = {}) => {
    const listed: string[] = []
    const kills: Array<{ spriteName: string; sessionId: string }> = []
    const events: Array<{ name: string; attrs: Record<string, unknown> }> = []
    const warnings: string[] = []
    const svc = new SpriteStatusSyncService(
        makeDb(hosts) as never,
        { getById: async () => ({ id: 'acc-1', slug: 'acct' }) } as never,
        {} as never,
        { emit: () => {}, emitHostUpdate: () => {} } as never,
        {
            event: (name: string, attrs: Record<string, unknown>) => {
                events.push({ name, attrs })
            }
        } as never,
        {
            measureIfDue: async () => {},
            measureHostIfDue: async () => {}
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {
            accrue: async () => {},
            settleHostNotRunning: async () => {},
            pruneOlderThan: async () => {}
        } as never
    )
    svc['clientFor' as never] = (() => ({
        listExecSessions: async (spriteName: string) => {
            listed.push(spriteName)
            if (spec.listError) throw spec.listError
            return spec.sessions ?? []
        },
        killExecSession: async (spriteName: string, sessionId: string) => {
            kills.push({ spriteName, sessionId })
        }
    })) as never
    svc['log' as never] = {
        warn: (msg: string) => warnings.push(msg),
        log: () => {}
    } as never
    return { svc, listed, kills, events, warnings }
}

const reap = async (svc: SpriteStatusSyncService) =>
    (svc['tickExecSessionReaper' as never] as () => Promise<void>).call(svc)

const host = (over: Partial<HostRow> = {}): HostRow => ({
    id: 'sbx_1',
    userId: 'usr_1',
    accountId: 'acc-1',
    spriteName: 'sbx-1',
    ...over
})

// WHY this test exists: the prod host had zero agents, zero runtimes, zero
// services and zero tasks, so SandboxesService.stop() was a no-op on every one
// of its 6-minute passes. This reaper is the only thing that can reach the one
// object that was actually pinning the VM.
test('the tick kills the abandoned session and leaves the live one running', async () => {
    const { svc, listed, kills, events } = makeService([host()], {
        sessions: [
            session({ id: 'stale' }),
            session({
                id: 'fresh',
                last_activity: new Date(Date.now() - 60_000).toISOString()
            }),
            session({ id: 'finished', is_active: false })
        ]
    })

    await reap(svc)

    assert.deepEqual(listed, ['sbx-1'])
    assert.deepEqual(kills, [{ spriteName: 'sbx-1', sessionId: 'stale' }])
    const [ev] = events
    assert.equal(ev.name, 'sprite_exec_session.reaped')
    assert.equal(ev.attrs.sessionId, 'stale')
    assert.equal(ev.attrs.hostId, 'sbx_1')
})

// WHY: the argv tail carries user file paths — the prod session's command was
// `rm -f …/all_files 02.zip.mf-part`. The binary name is the diagnostic; the
// arguments are the user's data and must not reach logs or telemetry.
test('only the argv head is recorded, never the arguments', async () => {
    const { svc, events, warnings } = makeService([host()], {
        sessions: [
            session({
                id: 'stale',
                command: 'rm -f /home/sprite/private/secret-plans.zip.mf-part'
            })
        ]
    })

    await reap(svc)

    assert.equal(events[0].attrs.command, 'rm')
    assert.ok(
        !JSON.stringify(events).includes('secret-plans'),
        'telemetry must not carry command arguments'
    )
    assert.ok(
        !warnings.join('\n').includes('secret-plans'),
        'logs must not carry command arguments'
    )
})

// WHY: the sweep rides the 1.5s sync wakeup, so without its own cadence gate it
// would list every running sprite's sessions ~40x a minute.
test('a second tick inside the interval does no vendor work', async () => {
    const { svc, listed } = makeService([host()], {
        sessions: [session({ id: 'stale' })]
    })

    await reap(svc)
    await reap(svc)

    assert.deepEqual(listed, ['sbx-1'], 'the interval gate must skip the retry')
})

// WHY: a row can point at a sprite the vendor has already deleted (prod has one
// such `revoked` row from 2026-07-02). That is expected, not an incident, so it
// must not log — while any other failure must, or a permanently unreapable host
// bills in silence.
test('a deleted sprite is skipped quietly, other failures are logged', async () => {
    const gone = makeService([host()], {
        listError: new SpritesError('not_found', 'gone', 404)
    })
    await reap(gone.svc)
    assert.deepEqual(gone.warnings, [])

    const broken = makeService([host()], {
        listError: new Error('sprites.dev 500')
    })
    await reap(broken.svc)
    assert.equal(broken.warnings.length, 1)
    assert.match(broken.warnings[0], /exec-session reap failed for host sbx_1/)
})

// WHY: a sandbox row without an account or sprite name has nothing to call
// against; reaching the client with either missing would throw per tick.
test('hosts with no account or sprite name are skipped', async () => {
    const { svc, listed } = makeService([
        host({ id: 'sbx_no_acct', accountId: null }),
        host({ id: 'sbx_no_name', spriteName: null })
    ])

    await reap(svc)

    assert.deepEqual(listed, [])
})
