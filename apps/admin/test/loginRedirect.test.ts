import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loginUrl, nextPath, safeRedirectPath } from '../src/lib/loginRedirect'

test('loginUrl carries the whole deep link, query included', () => {
    assert.equal(
        loginUrl(nextPath({ pathname: '/accounts/users', search: '?q=ada' })),
        '/login?redirect_url=%2Faccounts%2Fusers%3Fq%3Dada'
    )
    assert.equal(
        loginUrl(nextPath({ pathname: '/runtimes/rt_1', search: '' })),
        '/login?redirect_url=%2Fruntimes%2Frt_1'
    )
})

test('loginUrl leaves the dashboard implicit', () => {
    assert.equal(loginUrl(nextPath({ pathname: '/', search: '' })), '/login')
    assert.equal(loginUrl(''), '/login')
})

test('what loginUrl produces is what the login page accepts', () => {
    for (const next of [
        '/accounts/users?q=ada',
        '/model-providers/keys',
        '/channels'
    ]) {
        const decoded = new URL(
            loginUrl(next),
            'https://admin.example.com'
        ).searchParams.get('redirect_url')
        assert.equal(decoded, next)
        assert.equal(safeRedirectPath(decoded), next)
    }
})

test('safeRedirectPath rejects anything that is not an internal path', () => {
    assert.equal(safeRedirectPath('/accounts/users'), '/accounts/users')
    assert.equal(safeRedirectPath('//evil.com/users'), null)
    assert.equal(safeRedirectPath('https://evil.com/'), null)
    assert.equal(safeRedirectPath('javascript:alert(1)'), null)
    assert.equal(safeRedirectPath(undefined), null)
    assert.equal(safeRedirectPath(null), null)
})

// No renderer in this suite, so pin the two halves of the round trip by source:
// the guard must not bounce to a destination-less login, and the login page
// must actually read the parameter back.
test('ProtectedRoute sends the attempted location to the login page', () => {
    const source = readFileSync(
        new URL('../src/components/ProtectedRoute.tsx', import.meta.url),
        'utf8'
    )
    assert.ok(
        !/to=\{adminRoutes\.login\}/.test(source),
        'ProtectedRoute must not navigate to a bare login route'
    )
    assert.match(source, /loginUrl\(nextPath\(location\)\)/)
})

test('the login page consumes redirect_url', () => {
    const source = readFileSync(
        new URL('../src/pages/Login.tsx', import.meta.url),
        'utf8'
    )
    assert.match(source, /safeRedirectPath\(params\.get\('redirect_url'\)\)/)
})

// The OAuth bounce only ever returns to an origin, so the in-app path has to
// travel inside the absolute URL handed to the API — a bare origin drops it.
test('the OAuth start URL carries the in-app path', () => {
    const source = readFileSync(
        new URL('../src/lib/auth.tsx', import.meta.url),
        'utf8'
    )
    assert.ok(
        !/const back = `\$\{window\.location\.origin\}\/`/.test(source),
        'startOauth must not send a bare origin as redirect_url'
    )
    assert.match(
        source,
        /const back = `\$\{window\.location\.origin\}\$\{\s*safeRedirectPath\(redirectUrl\) \?\? '\/'\s*\}`/
    )
})
