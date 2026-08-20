import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import UserAvatar from '../src/components/UserAvatar'

test('personal library items show the current user initials without a photo', () => {
    const html = renderToStaticMarkup(
        createElement(UserAvatar, {
            imageUrl: null,
            label: 'Ada Lovelace'
        })
    )
    assert.match(html, />AL<\/span>/)
})

test('personal library items show the fetched current user photo', () => {
    const html = renderToStaticMarkup(
        createElement(UserAvatar, {
            imageUrl: 'blob:current-user-avatar',
            label: 'Ada Lovelace'
        })
    )
    assert.match(html, /<img src="blob:current-user-avatar"/)
})
