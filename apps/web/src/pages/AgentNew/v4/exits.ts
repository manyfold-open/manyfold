import { NEW_RUNTIME_OPTIONS } from '@/lib/newRuntimeOptions'

// The one place this flow still sends the user somewhere else.
//
// Everything else a row can start now finishes inside the step that offered
// it: signing in opens the CLI's own login here, connecting your computer
// shows the command and waits here, connecting a Dify / Langflow / A2A
// service is a dialog here. Renting a cloud computer cannot join them — it
// ends in a purchase, the buy surface belongs to the cloud edition (open
// source only redirects), and a payment is not something to slip into the
// middle of another task. The row says "leaves this flow" and means it.
//
// Seen on staging [2026-09-15]: all four exits were once hand-written URLs
// that matched no route, so they fell through to the catch-all and dropped
// the user into a chat mid-create. What survives of that is the rule — the
// destination is read from `NEW_RUNTIME_OPTIONS`, which exists so "where does
// a new runtime of this kind get made" is answered once, and a node:test
// holds it against the router's own table.
export const EXIT_RENT_CLOUD_COMPUTER =
    NEW_RUNTIME_OPTIONS.find((option) => option.kind === 'k8s')?.to ??
    '/settings/runtimes'
