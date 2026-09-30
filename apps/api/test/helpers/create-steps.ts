import assert from 'node:assert/strict'

// Every step a create emitted is on the list its client was given, in the
// list's order: a step off the list resets a progress bar, and one out of
// order sends it backwards.
export const assertStepsFollow = (
    emitted: readonly string[],
    listed: readonly string[]
): void => {
    let last = -1
    for (const step of emitted) {
        const at = listed.indexOf(step)
        assert.ok(
            at > last,
            `step "${step}" is ${at === -1 ? 'not on' : 'out of order in'} [${listed.join(', ')}] (emitted: ${emitted.join(', ')})`
        )
        last = at
    }
}
