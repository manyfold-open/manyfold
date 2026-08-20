import { CHAT_EXEC_MAX_TIMEOUT_MS } from '@manyfold/shared'
import test from 'node:test'
import assert from 'node:assert/strict'
import { manyfoldRuntimeEnv } from '../src/modules/chat/adapters/exec-driver-factory'
import {
    deriveMaxRunAfterDisconnectSeconds,
    SPRITE_EXEC_MAX_DETACH_SECONDS,
    wrapSpriteCommand
} from '../src/modules/chat/adapters/sprites-exec-driver'

test('manyfoldRuntimeEnv injects staging API and agent identity for sprite chat exec', () => {
    const config = {
        get: (key: string) =>
            key === 'PUBLIC_API_BASE_URL'
                ? 'https://api.example.com'
                : key === 'MF_DEPLOY_ENV'
                  ? 'staging'
                  : undefined
    }

    assert.deepEqual(manyfoldRuntimeEnv(config as never, 'agt_staging'), {
        MF_AGENT_ID: 'agt_staging',
        MF_API_URL: 'https://api.example.com/api',
        MF_DEPLOY_ENV: 'staging'
    })
})

test('manyfoldRuntimeEnv still injects agent id when API URL is not configured', () => {
    assert.deepEqual(
        manyfoldRuntimeEnv({ get: () => undefined } as never, 'agt_only'),
        { MF_AGENT_ID: 'agt_only', MF_DEPLOY_ENV: 'local' }
    )
})

test('wrapSpriteCommand always wraps and sources managed env even without a dir', () => {
    const wrapped = wrapSpriteCommand(['claude', '--version'], undefined)
    assert.equal(wrapped[0], 'bash')
    assert.equal(wrapped[1], '-c')
    // No cd when dir is undefined, but it must still wrap and source the token.
    assert.doesNotMatch(wrapped[2], /\bcd /)
    assert.match(wrapped[2], /export PATH="\$HOME\/\.local\/bin:\$PATH"/)
    assert.match(wrapped[2], /exec 'claude' '--version'/)
    assert.match(wrapped[2], /\/etc\/profile\.d\/mf\.sh/)
    assert.match(wrapped[2], /\/etc\/profile\.d\/nca\.sh/)
    assert.match(wrapped[2], /# mf-env-start/)
    assert.match(wrapped[2], /# mf-env-end/)
})

test('wrapSpriteCommand prefers staging mf installed in home local bin', () => {
    const wrapped = wrapSpriteCommand(['claude', '--version'], '/workspace/a b')
    assert.equal(wrapped[0], 'bash')
    assert.equal(wrapped[1], '-c')
    assert.match(wrapped[2], /export PATH="\$HOME\/\.local\/bin:\$PATH"/)
    assert.match(
        wrapped[2],
        /cd '\/workspace\/a b' && exec 'claude' '--version'/
    )
    // Managed env must be sourced before the command so MF_API_TOKEN is set.
    assert.match(wrapped[2], /\/etc\/profile\.d\/mf\.sh/)
    assert.match(wrapped[2], /\/etc\/profile\.d\/nca\.sh/)
})

test('wrapSpriteCommand relocates HOME for codex only on the final exec', () => {
    const ws = '/home/sprite/.manyfold/workspaces/agt_1'
    const wrapped = wrapSpriteCommand(
        ['codex', 'exec', '--json'],
        ws,
        { MF_API_TOKEN: 'tok' },
        ws
    )
    // PATH + managed-env still resolve against the REAL $HOME (pinned codex
    // binary, MF_API_TOKEN), because HOME is set only on the child exec.
    assert.match(wrapped[2], /export PATH="\$HOME\/\.local\/bin:\$PATH"/)
    assert.match(wrapped[2], /export MF_API_TOKEN='tok';/)
    assert.match(
        wrapped[2],
        /exec env HOME='\/home\/sprite\/\.manyfold\/workspaces\/agt_1' CODEX_HOME="\$HOME\/\.codex" 'codex' 'exec' '--json'/
    )
})

test('wrapSpriteCommand leaves HOME untouched without codex relocation', () => {
    const wrapped = wrapSpriteCommand(['claude', '--version'], '/ws')
    assert.doesNotMatch(wrapped[2], /HOME=/)
})

test('deriveMaxRunAfterDisconnectSeconds tracks finite turn caps (rounded up)', () => {
    assert.equal(deriveMaxRunAfterDisconnectSeconds(60_000), 60)
    assert.equal(deriveMaxRunAfterDisconnectSeconds(3_600_000), 3_600)
    assert.equal(deriveMaxRunAfterDisconnectSeconds(1_500), 2)
})

test('deriveMaxRunAfterDisconnectSeconds clamps unlimited turns to the 24h detach cap', () => {
    assert.equal(
        deriveMaxRunAfterDisconnectSeconds(CHAT_EXEC_MAX_TIMEOUT_MS),
        SPRITE_EXEC_MAX_DETACH_SECONDS
    )
})
