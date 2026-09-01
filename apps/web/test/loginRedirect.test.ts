import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loginUrl, nextPath, safeRedirectPath } from '../src/lib/loginRedirect'

const at = (
    pathname: string,
    search = ''
): { pathname: string; search: string } => ({
    pathname,
    search
})

test('loginUrl carries the whole deep link, query included', () => {
    // The reported case: a shared /agents/new link is useless to a signed-out
    // visitor unless `framework` survives the bounce through /login.
    assert.equal(
        loginUrl(nextPath(at('/agents/new', '?framework=narranexus'))),
        '/login?redirect_url=%2Fagents%2Fnew%3Fframework%3Dnarranexus'
    )
    assert.equal(
        loginUrl(nextPath(at('/agents/ag_1/chat', '?sessionId=cs_2&draft=1'))),
        '/login?redirect_url=%2Fagents%2Fag_1%2Fchat%3FsessionId%3Dcs_2%26draft%3D1'
    )
})

test('loginUrl handles a bare path and the root', () => {
    assert.equal(
        loginUrl(nextPath(at('/workspace'))),
        '/login?redirect_url=%2Fworkspace'
    )
    assert.equal(loginUrl(nextPath(at('/'))), '/login')
    assert.equal(loginUrl(''), '/login')
})

test('what loginUrl produces is what the login page accepts', () => {
    for (const next of [
        '/agents/new?framework=narranexus',
        '/connections?connected=github',
        '/settings/plan-and-billing?topup=1',
        '/skills/shared/shr_1'
    ]) {
        const decoded = new URL(
            loginUrl(next),
            'https://app.example.com'
        ).searchParams.get('redirect_url')
        assert.equal(decoded, next)
        assert.equal(safeRedirectPath(decoded), next)
    }
})

test('safeRedirectPath rejects anything that is not an internal path', () => {
    assert.equal(safeRedirectPath('/agents'), '/agents')
    assert.equal(safeRedirectPath('//evil.com/agents'), null)
    assert.equal(safeRedirectPath('https://evil.com/'), null)
    assert.equal(safeRedirectPath('javascript:alert(1)'), null)
    assert.equal(safeRedirectPath(''), null)
    assert.equal(safeRedirectPath(null), null)
})

// The guard is a React component and this suite has no renderer, so pin the
// one property that matters: it must never bounce to a destination-less
// /login. Reverting it to `to='/login'` has to fail something.
test('ProtectedRoute sends the attempted location to the login page', () => {
    const source = readFileSync(
        new URL('../src/components/ProtectedRoute.tsx', import.meta.url),
        'utf8'
    )
    assert.ok(
        !/to='\/login'/.test(source),
        'ProtectedRoute must not navigate to a bare /login'
    )
    assert.match(source, /loginUrl\(nextPath\(location\)\)/)
})
