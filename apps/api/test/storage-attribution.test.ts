import assert from 'node:assert/strict'
import test from 'node:test'
import {
    attributeStoragePaths,
    resolvedStoragePath
} from '../src/modules/agents/sprite-storage/storage-attribution'
import { MeasurementObservation } from '../src/modules/agents/sprite-storage/measurement-observation'

test('parent, child and grandchild deduct only the direct measured child', () => {
    const result = attributeStoragePaths(
        [
            { key: 'parent', path: '/foo', bytes: 100 },
            { key: 'child', path: '/foo/child', bytes: 40 },
            { key: 'grandchild', path: '/foo/child/grandchild', bytes: 10 },
            { key: 'separate', path: '/foobar', bytes: 50 }
        ],
        null
    )
    assert.deepEqual(Object.fromEntries(result.attributed), {
        parent: 60,
        child: 30,
        grandchild: 10,
        separate: 50
    })
    assert.equal(result.unionBytes, 150)
    assert.equal(result.complete, true)
})

test('same-path aliases have one stable contribution', () => {
    const result = attributeStoragePaths(
        [
            { key: 'b', path: '/foo/', bytes: 100 },
            { key: 'a', path: '/foo', bytes: 100 }
        ],
        null
    )
    assert.deepEqual(Object.fromEntries(result.attributed), { b: 0, a: 100 })
    assert.equal(result.unionBytes, 100)
})

test('unknown roots and missing sections do not fabricate a partition', () => {
    const unknown = attributeStoragePaths(
        [
            { key: 'home', path: '~/.config', bytes: 100 },
            { key: 'workspace', path: '/actual/.config/workspace', bytes: 40 }
        ],
        null
    )
    assert.equal(unknown.attributed.get('home'), null)
    assert.equal(unknown.complete, false)
    assert.equal(unknown.unionBytes, null)
    const missing = attributeStoragePaths(
        [
            { key: 'home', path: '/config', bytes: 100 },
            { key: 'workspace', path: '/config/workspace', bytes: null }
        ],
        null
    )
    assert.equal(missing.attributed.get('home'), null)
    assert.equal(missing.attributed.get('workspace'), null)
    assert.equal(missing.complete, false)
    assert.equal(
        missing.unionBytes,
        100,
        'the successfully measured ancestor still covers the missing child'
    )
})

test('inconsistent parent/child or alias readings remain unknown instead of clamping', () => {
    for (const paths of [
        [
            { key: 'home', path: '/config', bytes: 30 },
            { key: 'workspace', path: '/config/workspace', bytes: 40 }
        ],
        [
            { key: 'home', path: '/config', bytes: 30 },
            { key: 'workspace', path: '/config', bytes: 40 }
        ]
    ]) {
        const result = attributeStoragePaths(paths, null)
        assert.equal(result.attributed.get('home'), null)
        assert.equal(result.complete, false)
        assert.equal(result.unionBytes, null)
    }
})

test('tilde comparison requires a real supplied root and preserves separate config directories', () => {
    assert.equal(resolvedStoragePath('~/.config', null), null)
    const result = attributeStoragePaths(
        [
            { key: 'home-a', path: '~/.config', bytes: 100 },
            { key: 'workspace', path: '/actual/.config/workspace', bytes: 40 },
            { key: 'home-b', path: '/another/config', bytes: 50 }
        ],
        '/actual'
    )
    assert.deepEqual(Object.fromEntries(result.attributed), {
        'home-a': 60,
        workspace: 40,
        'home-b': 50
    })
    assert.equal(result.unionBytes, 150)
})

test('phase observation ignores private framed paths even when they contain timing markers', () => {
    const observation = new MeasurementObservation('fixture-attempt', 'chat')
    observation.startExec(8000)
    const privatePath =
        '/private-user/path\n__NCA_STORAGE_PHASE__ home_du start 1\n'
    const frame = `\0__NCA_STORAGE_PATH__\0${1}\0${privatePath}\0`
    for (const chunk of [
        frame.slice(0, 9),
        frame.slice(9, 30),
        frame.slice(30)
    ])
        observation.stdout(chunk)
    assert.equal(observation.phase, 'connect')
    observation.stdout(
        '__NCA_STORAGE_PHASE__ df start 1000000\n__NCA_STORAGE_PHASE__ df end 1004000\n'
    )
    assert.deepEqual(observation.timings.get('df'), { durationMs: 4, count: 1 })
    assert.equal(observation.timings.has('home_du'), false)
    assert.equal(JSON.stringify(observation).includes('private-user'), false)
})
