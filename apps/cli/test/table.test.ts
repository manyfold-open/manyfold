import test from 'node:test'
import assert from 'node:assert/strict'
import { displayWidth, formatTable } from '../src/table'

test('columns line up under a header and the last one is not padded', () => {
    assert.deepEqual(
        formatTable(
            ['ID', 'LABEL', 'STATUS'],
            [
                ['chn_1', 'Fake Channel 1 Renamed', 'active'],
                ['chn_22', 'tg', 'draft']
            ]
        ),
        [
            'ID      LABEL                   STATUS',
            'chn_1   Fake Channel 1 Renamed  active',
            'chn_22  tg                      draft'
        ]
    )
})

test('a style goes on after the padding and never counts toward a width', () => {
    const mark = (text: string): string => `<${text}>`
    assert.deepEqual(
        formatTable(
            ['A', 'B'],
            [
                [['x', mark], 'y'],
                ['xyz', 'z']
            ]
        ),
        ['A    B', '<x>    y', 'xyz  z']
    )
})

test('wide characters take two columns and combining marks none', () => {
    const accent = String.fromCodePoint(0x301)
    assert.equal(displayWidth('渠道'), 4)
    assert.equal(displayWidth(`e${accent}`), 1)
    assert.deepEqual(
        formatTable(
            ['NAME', 'N'],
            [
                ['渠道', '1'],
                ['ab', '2']
            ]
        ),
        ['NAME  N', '渠道  1', 'ab    2']
    )
})

test('an empty last cell leaves no trailing spaces', () => {
    assert.deepEqual(formatTable(['ID', 'NOTES'], [['a', '']]), [
        'ID  NOTES',
        'a'
    ])
})
