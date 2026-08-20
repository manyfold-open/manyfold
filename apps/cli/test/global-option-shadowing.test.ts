import test from 'node:test'
import assert from 'node:assert/strict'
import type { Command } from 'commander'
import { buildProgram } from '../src/program'

// Commander parses non-positionally: the root program consumes its global
// options (--agent-id, --token, …) from anywhere on the command line, so a
// subcommand redeclaring the same flag NEVER receives a value. Redeclaring
// is allowed only as help surface, and only when the action resolves the
// value via @/agent-context. This test forces every new collision to be a
// conscious decision: add it here AND route it through the resolver.
const ALLOWED_SHADOWED_FLAGS = new Set([
    'mf automations create --agent-id',
    'mf automations list --agent-id',
    'mf backups list --agent-id',
    'mf channels create --agent-id',
    'mf channels list --agent-id',
    'mf daemon register --token',
    'mf login --api-url',
    'mf login --token',
    'mf setup --api-url',
    'mf setup --token',
    'mf skills discover --agent-id',
    'mf skills install --agent-id',
    'mf skills installed --agent-id',
    'mf usage events --agent-id',
    'mf usage sessions --agent-id',
    'mf usage summary --agent-id',
    'mf usage timeseries --agent-id'
])

const collectCollisions = (
    cmd: Command,
    path: string,
    rootFlags: ReadonlySet<string>,
    out: string[]
): void => {
    for (const sub of cmd.commands) {
        const subPath = `${path} ${sub.name()}`
        for (const opt of sub.options) {
            if (opt.long && rootFlags.has(opt.long))
                out.push(`${subPath} ${opt.long}`)
        }
        collectCollisions(sub, subPath, rootFlags, out)
    }
}

test('subcommands only shadow root global options via the allowlist', () => {
    const program = buildProgram()
    const rootFlags = new Set(
        program.options.flatMap((opt) => (opt.long ? [opt.long] : []))
    )
    const collisions: string[] = []
    collectCollisions(program, 'mf', rootFlags, collisions)
    for (const collision of collisions) {
        assert.ok(
            ALLOWED_SHADOWED_FLAGS.has(collision),
            `'${collision}' redeclares a root global option. The root program ` +
                `consumes that flag wherever it appears, so the subcommand's ` +
                `local option never receives a value. Resolve it via ` +
                `src/agent-context.ts (or an equivalent root-aware helper) ` +
                `and add the flag to ALLOWED_SHADOWED_FLAGS.`
        )
    }
    for (const allowed of ALLOWED_SHADOWED_FLAGS) {
        assert.ok(
            collisions.includes(allowed),
            `'${allowed}' is allowlisted but no longer exists — remove it ` +
                `from ALLOWED_SHADOWED_FLAGS`
        )
    }
})
