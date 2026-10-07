import assert from 'node:assert/strict'
import test from 'node:test'
import { isMobileDevice } from '../src/lib/mobileDevice'

const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const ANDROID =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'
const MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const WINDOWS =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'

test('phones and tablets are mobile', () => {
    assert.equal(isMobileDevice({ userAgent: IPHONE, maxTouchPoints: 5 }), true)
    assert.equal(
        isMobileDevice({ userAgent: ANDROID, maxTouchPoints: 5 }),
        true
    )
})

test('an iPad asking for the desktop site is told apart from a Mac', () => {
    assert.equal(isMobileDevice({ userAgent: MAC, maxTouchPoints: 5 }), true)
    assert.equal(isMobileDevice({ userAgent: MAC, maxTouchPoints: 0 }), false)
})

test('a desktop with a touch screen is not mobile', () => {
    assert.equal(
        isMobileDevice({ userAgent: WINDOWS, maxTouchPoints: 10 }),
        false
    )
})

test('client hints mark a mobile browser whatever its user agent says', () => {
    assert.equal(
        isMobileDevice({
            userAgent: WINDOWS,
            maxTouchPoints: 5,
            userAgentData: { mobile: true }
        }),
        true
    )
})
