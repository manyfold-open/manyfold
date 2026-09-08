import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalResumeService } from '@/modules/terminal/terminal-resume.service'

/* Pointing the terminal's TUI at a session a turn is still running does not
   join that conversation — it collides with it. Codex says so out loud:

     thread/resume failed: thread <id> already has an active writer (code -32600)

   which is what reached a user instead of a shell on production [2026-09-07],
   after a turn suspended with its CLI still executing on the sandbox.

   The gate is `chat_sessions.inflight_message_id` rather than a live-stream
   check because only a done/error terminal releases it. It therefore still
   reads as held through a SUSPENDED turn — precisely the state where the API
   has stopped watching and the CLI has not stopped writing.

   The outcome travels with the verdict: the client cannot predict this gate
   from its own stream view, so it records what the API reports and rebuilds
   the shell into the TUI once the turn ends. */

const dbReturning = (
    row: { ref: string | null; inflightMessageId: string | null } | undefined
): never =>
    ({
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => (row ? [row] : [])
                })
            })
        })
    }) as never

const resolveFor = async (
    row: { ref: string | null; inflightMessageId: string | null },
    overrides: Partial<{ framework: 'codex' | 'claude-code' | 'hermes' }> = {}
): ReturnType<TerminalResumeService['resolve']> =>
    new TerminalResumeService(dbReturning(row), {} as never).resolve({
        agentId: 'agt_1',
        runtimeId: 'rt_1',
        framework: overrides.framework ?? 'codex',
        chatSessionId: 'cs_1',
        modelCredentialsAllowed: true,
        injectModelCredentials: false
    })

test('an idle session still resumes into its TUI', async () => {
    assert.deepEqual(
        await resolveFor({ ref: 'thread-1', inflightMessageId: null }),
        {
            resume: {
                command: [
                    'codex',
                    'resume',
                    'thread-1',
                    '--dangerously-bypass-approvals-and-sandbox'
                ],
                env: {}
            },
            outcome: 'applied'
        }
    )
})

test('a session with a turn in flight opens a plain shell and says why', async () => {
    assert.deepEqual(
        await resolveFor({ ref: 'thread-1', inflightMessageId: 'msg_live' }),
        { resume: null, outcome: 'turn-in-flight' }
    )
})

// The claim is about the turn, not about the ref: a session whose CLI has not
// named itself yet was already unresumable, and must not start reporting a
// turn just because nothing holds the lock — nor because something does.
test('a missing session ref is unavailable whether or not a turn is in flight', async () => {
    assert.deepEqual(
        await resolveFor({ ref: null, inflightMessageId: null }),
        { resume: null, outcome: 'unavailable' }
    )
    assert.deepEqual(
        await resolveFor({ ref: null, inflightMessageId: 'msg_live' }),
        { resume: null, outcome: 'unavailable' }
    )
})

// A framework with no resume form never reaches the session at all, so its
// verdict is the durable one the client already knows how to explain.
test('an unsupported framework is unavailable, not in flight', async () => {
    assert.deepEqual(
        await resolveFor(
            { ref: 'sess', inflightMessageId: 'msg_live' },
            { framework: 'hermes' }
        ),
        { resume: null, outcome: 'unavailable' }
    )
})
