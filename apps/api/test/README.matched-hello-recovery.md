# Matched Hello Lookup Recovery

The deterministic regression in `daemon-resume-skipped-recheck.test.ts` holds
H1's lookup with a barrier, rejects H2's lookup after its matched hello, then
releases H1. Exactly one retry must remain in the existing 60-second tier.
Mock timers drive recovery, repeated lookup failure, newer hello supersession,
local-carrier terminal veto, and shutdown without wall-clock sleeps.

The corresponding case in `daemon-exec-resume-recheck.pg.test.ts` holds the real
SQL response inside the first query's await window and rejects only the second
query in the test process. Recovery uses the real open-row SQL and
`ChatRepository.claimTurnForResume`: the exact ref differs from the message ID,
generation advances from 1 to 2, the new owner is running, and no terminal is
written. The test-only query wrapper is removed before retry. No production
fault-injection switch is added.

## Verification On A Released Revision

Record the exact deployed API revision and run these checks from that revision
in an exclusive fixture process or machine. Provision a dedicated loopback
PostgreSQL container with an ephemeral credential, then use the existing
scratch-database audit runner from `apps/api`:

```sh
PG_TEST_SCRATCH=1 PG_TEST_ADMIN_URL="$OWNED_PG_ADMIN_URL" \
  pnpm exec tsx scripts/run-pg-audit.ts
```

The URL must belong to the newly created fixture container, never a shared
development or staging database. The runner creates, migrates, and drops its
own scratch database; remove the fixture container and its volumes afterward.
Require zero failed, cancelled, or skipped tests. Preserve the TAP output and
cleanup evidence. This verifies the injected H1/H2 interleaving and durable SQL
ownership against the released source, not a live daemon reconnect by itself.

For deployed integration, use a separately registered QA daemon/profile and
fixture-only agent. Start a controlled long-running Chat turn, disconnect only
that fixture transport, and reconnect it with the same buffered ref. Confirm
the API's matched hello resumes the turn once, then inspect the QA message's
`turn_executions` owner/generation and `chat_stream_events` terminal rows. If
the deployment observes the lookup-failure interleaving, require recovery in
the bounded tier without another hello, zero false `server_restart` terminals,
and no ownerless open turn. A normal reconnect alone does not prove that fault
case; retain the deterministic fixture evidence separately.

Do not disturb a user's daemon or change shared database/network settings to
force the race. Remove only the fixture session, agent, daemon registration,
container, and database after readback. Exact merge CI and deployed readback
remain release-owner acceptance checks.
