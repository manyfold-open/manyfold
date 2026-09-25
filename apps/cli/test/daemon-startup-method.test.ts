import test from 'node:test'
import assert from 'node:assert/strict'
import {
    CONTAINER_SUPERVISOR_ENV,
    detectStartupMethod
} from '../src/daemon/startup-method'

const withEnv = (value: string | undefined, run: () => void): void => {
    const saved = process.env[CONTAINER_SUPERVISOR_ENV]
    if (value === undefined) delete process.env[CONTAINER_SUPERVISOR_ENV]
    else process.env[CONTAINER_SUPERVISOR_ENV] = value
    try {
        run()
    } finally {
        if (saved === undefined) delete process.env[CONTAINER_SUPERVISOR_ENV]
        else process.env[CONTAINER_SUPERVISOR_ENV] = saved
    }
}

test('a pod host boot loop marks its daemon as container-supervised', () => {
    withEnv('container', () => assert.equal(detectStartupMethod(), 'container'))
})

test('without the marker the daemon falls back to its platform detection', () => {
    withEnv(undefined, () =>
        assert.notEqual(detectStartupMethod(), 'container')
    )
    withEnv('something-else', () =>
        assert.notEqual(detectStartupMethod(), 'container')
    )
})
