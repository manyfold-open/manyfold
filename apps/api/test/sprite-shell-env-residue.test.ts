import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildShellEnvScript } from '../src/modules/agent-self/sprite-shell-env.service'

// A pre-#645 sprite carries managed env blocks written before the current
// marker vocabulary existed, so the marker-based sed can never see them. On a
// co-resident sandbox those world-readable, always-sourced files hold ANOTHER
// agent's live MF_API_TOKEN and MF_AGENT_ID, and re-export them over the
// per-exec identity (#650). The same residue is the unbounded `.local/bin`
// prepend growth #611 measured.
const OTHER_AGENT_TOKEN = 'mft_live_other_agent_do_not_leak'
const OTHER_AGENT_ID = 'agt_otheragent0000000000000'

const SECRETS = [
    'MF_API_TOKEN',
    'NCA_API_TOKEN',
    'MF_AGENT_ID',
    'NCA_AGENT_ID'
] as const

const LEGACY_PATH_PREPEND = 'export PATH="$HOME/.local/bin:$PATH"'

const USER_PATH_EXPORTS = [
    'export PATH="$PATH:$HOME/.local/bin"',
    'export PATH="$HOME/.local/bin:$HOME/custom/bin:$PATH"',
    'export PATH="$HOME/.local/bin-tools:$PATH"'
] as const

const FIXTURES: Record<string, string> = {
    // Marked legacy block (removable by the existing sed) PLUS bare residue
    // from a write that predates the markers.
    '.bashrc': [
        '# image bashrc',
        'export PATH="$HOME/.local/bin:$PATH"',
        '# mf-env-start',
        'export PATH="$HOME/.local/bin:$PATH"',
        "export MF_API_URL='https://api.example.test/api'",
        `export MF_API_TOKEN='${OTHER_AGENT_TOKEN}'`,
        `export MF_AGENT_ID='${OTHER_AGENT_ID}'`,
        "export MF_DEPLOY_ENV='staging'",
        '# mf-env-end',
        `export MF_API_TOKEN='${OTHER_AGENT_TOKEN}'`,
        `export MF_AGENT_ID='${OTHER_AGENT_ID}'`,
        "alias ll='ls -la'",
        ''
    ].join('\n'),
    // nca-era block whose only content is residue: draining it must take the
    // delimiters with it rather than leave an empty managed block behind.
    '.profile': [
        '# image profile',
        '# nca-env-start',
        'export PATH="$HOME/.local/bin:$PATH"',
        `export NCA_API_TOKEN='${OTHER_AGENT_TOKEN}'`,
        `export NCA_AGENT_ID='${OTHER_AGENT_ID}'`,
        '# nca-env-end',
        `export NCA_AGENT_ID='${OTHER_AGENT_ID}'`,
        'export EDITOR=vim',
        ''
    ].join('\n'),
    // The reported shape: no delimiters at all, so nothing marker-based can
    // ever reach it.
    '.zshrc': [
        '# image zshrc',
        ...USER_PATH_EXPORTS,
        `export MF_API_TOKEN='${OTHER_AGENT_TOKEN}'`,
        `export NCA_API_TOKEN='${OTHER_AGENT_TOKEN}'`,
        `export MF_AGENT_ID='${OTHER_AGENT_ID}'`,
        'export PATH="$HOME/.local/bin:$PATH"',
        'export PATH="$HOME/.local/bin:$PATH"',
        'export PS1="> "',
        ''
    ].join('\n')
}

const withSeededHome = (fn: (home: string) => void): void => {
    const home = mkdtempSync(join(tmpdir(), 'mf-residue-'))
    try {
        for (const [name, body] of Object.entries(FIXTURES))
            writeFileSync(join(home, name), body)
        fn(home)
    } finally {
        rmSync(home, { recursive: true, force: true })
    }
}

const runShell = (home: string, script: string): string =>
    execFileSync('bash', ['--noprofile', '--norc', '-c', script], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home }
    }).trimEnd()

const reconcile = (home: string): void => {
    runShell(
        home,
        buildShellEnvScript({
            agentId: 'agt_thisagent00000000000000',
            apiBaseUrl: 'https://api.example.test/api',
            apiToken: 'mft_live_this_agent',
            deployEnv: 'staging'
        })
    )
}

const read = (home: string, name: string): string =>
    readFileSync(join(home, name), 'utf8')

const occurrences = (text: string, needle: string): number =>
    text.split(needle).length - 1

test('the reconcile removes every cross-agent token and identity residue', () => {
    withSeededHome((home) => {
        reconcile(home)
        for (const name of Object.keys(FIXTURES)) {
            const body = read(home, name)
            assert.equal(
                body.includes(OTHER_AGENT_TOKEN),
                false,
                `${name} still carries another agent's token`
            )
            assert.equal(
                body.includes(OTHER_AGENT_ID),
                false,
                `${name} still carries another agent's id`
            )
            for (const key of SECRETS)
                assert.equal(
                    body.includes(`export ${key}=`),
                    false,
                    `${name} still exports ${key}`
                )
        }
    })
})

test('the reconcile removes legacy blind .local/bin prepends', () => {
    withSeededHome((home) => {
        reconcile(home)
        for (const name of Object.keys(FIXTURES)) {
            const blind = read(home, name)
                .split('\n')
                .filter((line) => line.trim() === LEGACY_PATH_PREPEND)
            assert.deepEqual(
                blind,
                [],
                `${name} still carries an unguarded prepend`
            )
        }
    })
})

test('the reconcile preserves unrelated user PATH exports', () => {
    withSeededHome((home) => {
        reconcile(home)
        const zshrc = read(home, '.zshrc')
        for (const line of USER_PATH_EXPORTS)
            assert.equal(
                occurrences(zshrc, line),
                1,
                'user PATH export was changed: ' + line
            )
    })
})

test('the reconcile keeps unrelated user lines and the current blocks', () => {
    withSeededHome((home) => {
        reconcile(home)
        const bashrc = read(home, '.bashrc')
        assert.ok(bashrc.includes('# image bashrc'))
        assert.ok(bashrc.includes("alias ll='ls -la'"))
        assert.ok(bashrc.includes('export MF_API_URL='))
        assert.ok(bashrc.includes('export MF_DEPLOY_ENV='))
        assert.equal(occurrences(bashrc, '# mf-env-start'), 1)
        assert.ok(read(home, '.profile').includes('export EDITOR=vim'))
        assert.ok(read(home, '.zshrc').includes('export PS1="> "'))
        for (const name of Object.keys(FIXTURES))
            assert.equal(
                occurrences(read(home, name), '# mf-path-start'),
                1,
                `${name} has the wrong number of managed PATH blocks`
            )
    })
})

// A drained legacy block is pure noise; leaving the delimiters behind would
// also leave the next reconcile a block to re-drain forever.
test('a legacy block left with no content loses its delimiters too', () => {
    withSeededHome((home) => {
        reconcile(home)
        const profile = read(home, '.profile')
        assert.equal(profile.includes('# nca-env-start'), false)
        assert.equal(profile.includes('# nca-env-end'), false)
    })
})

// #611's exact-occurrence gate: a blind prepend plus the guarded block grows
// PATH on every nested login/interactive shell.
test('nested sourcing yields exactly one activation entry on PATH', () => {
    withSeededHome((home) => {
        reconcile(home)
        const path = runShell(
            home,
            [
                'PATH=/image/node/bin:/usr/bin:/bin',
                'export PATH',
                '. "$HOME/.profile"',
                '. "$HOME/.bashrc"',
                '. "$HOME/.bashrc"',
                'printf "%s\\n" "$PATH"'
            ].join('\n')
        )
        assert.equal(path.split(':')[0], `${home}/.local/bin`)
        assert.equal(occurrences(path, `${home}/.local/bin`), 1, path)
    })
})

// Blank-line drift between the two managed blocks is pre-existing cosmetics
// (each block is deleted in place and re-appended at the end); what must not
// drift is the content, which is what a re-run of an upgrade produces.
const contentLines = (body: string): string[] =>
    body.split('\n').filter((line) => line.trim() !== '')

test('a second reconcile adds no content and no duplicate block', () => {
    withSeededHome((home) => {
        reconcile(home)
        const after = Object.keys(FIXTURES).map((name) =>
            contentLines(read(home, name))
        )
        reconcile(home)
        reconcile(home)
        assert.deepEqual(
            Object.keys(FIXTURES).map((name) => contentLines(read(home, name))),
            after
        )
        for (const name of Object.keys(FIXTURES)) {
            assert.equal(occurrences(read(home, name), '# mf-path-start'), 1)
            assert.ok(occurrences(read(home, name), '# mf-env-start') <= 1)
        }
    })
})
