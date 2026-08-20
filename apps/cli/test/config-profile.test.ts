import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
    resolveConfigPath,
    resolveProfile,
    resolveProfileSource,
    setProfileFlag
} from '../src/config'

const withEnv = async (
    overrides: Record<string, string | undefined>,
    fn: () => Promise<void>
): Promise<void> => {
    const previous = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(overrides)) {
        previous.set(key, process.env[key])
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    try {
        await fn()
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

test('resolveConfigPath puts the default profile under profiles/ like everyone else', async () => {
    await withEnv(
        {
            MF_CONFIG_DIR: undefined,
            MF_PROFILE: undefined
        },
        async () => {
            assert.equal(
                resolveConfigPath(),
                `${join(homedir(), '.manyfold')}/profiles/default/config.json`
            )
        }
    )
})

test('resolveConfigPath scopes non-default profiles to their own directory', async () => {
    await withEnv(
        {
            MF_CONFIG_DIR: '/tmp/mf-home',
            MF_PROFILE: 'staging'
        },
        async () => {
            assert.equal(
                resolveConfigPath(),
                '/tmp/mf-home/profiles/staging/config.json'
            )
        }
    )
})

test('an empty or blank MF_PROFILE falls back to the channel default', async () => {
    for (const value of ['', '   ']) {
        await withEnv({ MF_PROFILE: value }, async () => {
            assert.equal(resolveProfile(), 'default')
            assert.equal(resolveProfileSource(), 'channel-default')
        })
    }
})

test('profile names that could escape or mangle paths are rejected', async () => {
    for (const value of [
        '../pwn',
        '../../tmp/pwn',
        'a/b',
        'a.b',
        'team a',
        'Team',
        'a'.repeat(33),
        '-lead',
        '_x'
    ]) {
        await withEnv({ MF_PROFILE: value }, async () => {
            assert.throws(
                () => resolveProfile(),
                /invalid profile name/,
                `must reject ${JSON.stringify(value)}`
            )
        })
    }
})

test('valid profile names pass through unchanged', async () => {
    for (const value of [
        'spriterunner',
        'team-a',
        'a_b',
        '0x',
        'a'.repeat(32)
    ]) {
        await withEnv({ MF_PROFILE: value }, async () => {
            assert.equal(resolveProfile(), value)
            assert.equal(resolveProfileSource(), 'env')
        })
    }
})

test('the --profile flag beats MF_PROFILE and is validated the same way', async () => {
    await withEnv({ MF_PROFILE: 'from-env' }, async () => {
        setProfileFlag('from-flag')
        try {
            assert.equal(resolveProfile(), 'from-flag')
            assert.equal(resolveProfileSource(), 'flag')
            setProfileFlag('../pwn')
            assert.throws(() => resolveProfile(), /invalid profile name/)
        } finally {
            setProfileFlag(undefined)
        }
        assert.equal(resolveProfile(), 'from-env')
    })
})
