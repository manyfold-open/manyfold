import { NEW_RUNTIME_OPTIONS } from '@/lib/newRuntimeOptions'

// Where a row that LEAVES this flow actually goes.
//
// Seen on staging [2026-09-15]: all four of these were hand-written URLs —
// `/runtimes?connect=daemon`, `/runtimes?buy=cloud-computer`,
// `/runtimes/<id>?addAccount=1`, `/settings/providers` — and not one was a
// route. The runtime pages live under `/settings`, and nothing anywhere read
// those query parameters. Every one of them fell through to the catch-all,
// which lands the user in a chat with the half-finished create abandoned
// without a word.
//
// So they are values in one module now, where a node:test can hold them
// against the router's own table. The two new-machine ones are read from
// `NEW_RUNTIME_OPTIONS`, which exists precisely so "where does a new runtime
// of this kind get made" is not answered in two places.
const newRuntimeExit = (kind: 'daemon' | 'k8s'): string =>
    NEW_RUNTIME_OPTIONS.find((option) => option.kind === kind)?.to ??
    '/settings/runtimes'

export const EXIT_CONNECT_COMPUTER = newRuntimeExit('daemon')
export const EXIT_RENT_CLOUD_COMPUTER = newRuntimeExit('k8s')

// Signing in happens on the machine's own page, which is where the account
// list and its "Add account" live. There is no deep link that opens that
// dialog for us, so the button must not promise one.
export const exitToMachineAccounts = (runtimeId: string | null): string =>
    runtimeId === null ? '/settings/runtimes' : `/settings/runtimes/${runtimeId}`

export const EXIT_CONNECT_EXTERNAL_PROVIDER =
    '/settings/runtimes/external-agent-providers'
