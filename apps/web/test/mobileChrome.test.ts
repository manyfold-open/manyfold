import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

// Below `md` the shell's own header holds the only button that opens the
// sidebar, so a page reached through the shell has navigation only if that
// header renders or the page draws a menu button itself. Both halves of that
// deal are one-line changes in files that know nothing about each other, and
// when they drifted apart the result was not a cosmetic bug: /agents/new sat
// in the shell's suppression list from when v1 drew its own mobile header, the
// v3 rewrite dropped that header, and a new account — sent straight to
// /agents/new because it has no agent to open — reached a form with no way to
// anywhere else in the product. These pin the pairing from both sides.

const srcRoot = new URL('../src/', import.meta.url)

const read = (rel: string): string =>
    readFileSync(new URL(rel, srcRoot), 'utf8')

const shell = read('components/AppShell.tsx')

const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) return walk(full)
        return /\.tsx?$/.test(entry.name) ? [full] : []
    })

test('only routes whose page draws a menu button suppress the shell header', () => {
    const declaration = /const pageOwnMobileHeader = Boolean\(([^)]*)\)/.exec(
        shell
    )
    assert.ok(declaration, 'pageOwnMobileHeader is no longer declared this way')
    const routes = declaration[1]
        .split('||')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((name) => {
            const match = new RegExp(
                `const ${name} = useMatch\\('([^']+)'\\)`
            ).exec(shell)
            assert.ok(match, `${name} is not a useMatch(...) route`)
            return match[1]
        })
    // Adding a route here means promising that its page renders a top bar
    // carrying the menu button. Update this list only together with that page.
    assert.deepEqual(routes, ['/agents/:id/chat'])
})

test('the chat page draws the menu button it took responsibility for', () => {
    const chat = read('pages/AgentChat.tsx')
    assert.match(chat, /openMobileSidebar/)
    assert.match(chat, /onClick=\{onOpenMobileMenu\}/)
})

test('no other page draws a menu button beside the shell header', () => {
    const allowed = new Set(['components/AppShell.tsx', 'pages/AgentChat.tsx'])
    const root = new URL('.', srcRoot).pathname
    const offenders = walk(root)
        .filter((file) =>
            readFileSync(file, 'utf8').includes('openMobileSidebar')
        )
        .map((file) => relative(root, file))
        .filter((file) => !allowed.has(file))
    assert.deepEqual(offenders, [])
})
