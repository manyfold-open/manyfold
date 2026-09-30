import test from 'node:test'
import assert from 'node:assert/strict'
import { renderAgentSetupGuide } from '../src/agentSetupGuide'
import { DEFAULT_CLI_API_URL } from '../src/cliVersion'

const INSTALL_URL = 'https://manyfold.ai/cli/install.sh'

const shBlocks = (markdown: string): string[] =>
    [...markdown.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((m) => m[1]!)

const section = (markdown: string, from: string, to: string): string => {
    const start = markdown.indexOf(from)
    assert.notEqual(start, -1, `missing ${from}`)
    const end = markdown.indexOf(to, start)
    return markdown.slice(start, end === -1 ? undefined : end)
}

const local = renderAgentSetupGuide({
    apiUrl: 'http://localhost:7110/api',
    webUrl: 'http://localhost:7111',
    cliChannel: 'stable',
    cliInstallUrl: INSTALL_URL
})
const production = renderAgentSetupGuide({
    apiUrl: DEFAULT_CLI_API_URL,
    webUrl: 'https://manyfold.ai',
    cliChannel: 'stable',
    cliInstallUrl: INSTALL_URL
})
const staging = renderAgentSetupGuide({
    apiUrl: 'https://api-staging.example.com/api',
    webUrl: 'https://app-staging.example.com',
    cliChannel: 'dev',
    cliInstallUrl: INSTALL_URL
})
const variants = { local, production, staging }

test('the default API guide lets the agent pick the profile it already has', () => {
    assert.match(production, /- Web app: `https:\/\/manyfold\.ai`/)
    assert.match(
        production,
        /Otherwise, if `default` has no `apiUrl` or has this one, use `default`/
    )
    assert.match(
        production,
        /Otherwise use `manyfold`, unless the list shows `manyfold` with another `apiUrl`/
    )
    assert.match(
        production,
        /^mf --profile <profile> --api-url 'https:\/\/api\.manyfold\.ai\/api' whoami --json$/m
    )
    assert.match(
        production,
        /^curl -fsSL https:\/\/manyfold\.ai\/cli\/install\.sh \| sh$/m
    )
    assert.doesNotMatch(production, /MF_CHANNEL/)
})

test('another deployment signs in to its own profile and never the default one', () => {
    const guide = renderAgentSetupGuide({
        apiUrl: 'https://api.example.com/api',
        webUrl: 'https://app.example.com',
        cliChannel: 'stable',
        cliInstallUrl: INSTALL_URL
    })
    assert.match(
        guide,
        /- CLI profile: `example-com`, unless step 2 finds another profile already signed in here/
    )
    assert.match(
        guide,
        /Otherwise use `example-com`\. If the list shows `example-com` with another `apiUrl`/
    )
    assert.match(
        guide,
        /^nohup mf --profile <profile> --api-url 'https:\/\/api\.example\.com\/api' login --json > "\$HOME\/\.cache\/manyfold\/agent-login\.log" 2>&1 < \/dev\/null &$/m
    )
    assert.doesNotMatch(guide, /--profile default/)
})

// Seen on a local stack [2026-09-29]: another profile was already signed in
// to the same API, yet the agent created the guide's own profile and sent the
// user through a second browser approval. Staging users hit the same wall.
test('a profile already signed in to this deployment is reused, wherever it runs', () => {
    for (const [name, guide] of Object.entries(variants)) {
        assert.match(
            guide,
            /1\. A listed profile has `"apiUrl": "[^"]+"` and `"loggedIn": true`: it is already signed in to this deployment\. Use it and go to step 3\./,
            name
        )
        assert.match(guide, /never sign in over a profile you reused/, name)
        assert.doesNotMatch(guide, /--profile (?!<profile>)\S+ --api-url/, name)
    }
})

// Seen on a local stack [2026-09-29]: on a second run the agent looked for mf
// on PATH only, missed the ~/.local/bin/mf the first run installed, and ran
// the installer over it.
test('a second run finds the mf the first one installed', () => {
    const [look] = shBlocks(section(local, '## Step 1', '## Step 2'))
    assert.ok(look)
    assert.match(
        look,
        /for bin in "\$\(command -v mf\)" "\$HOME\/\.local\/bin\/mf"; do/
    )
    assert.doesNotMatch(look, /curl|whoami|\blogin --json/)
    assert.match(local, /No `mf=` line: the Manyfold CLI is not installed/)
})

// A profile sends its saved token to whatever --api-url a command carries, so
// nothing may run on a profile before step 2 has matched it to this API.
test('no token is used before the profile is known to be this deployment’s', () => {
    for (const [name, guide] of Object.entries(variants)) {
        for (const block of shBlocks(section(guide, '## Step 1', '## Step 2')))
            assert.doesNotMatch(block, /whoami/, name)
        for (const block of shBlocks(
            section(guide, '### Choose the profile', '### 2a')
        ))
            assert.doesNotMatch(block, /whoami/, name)
    }
})

test('a token in MF_TOKEN stops the setup instead of being sent', () => {
    for (const [name, guide] of Object.entries(variants)) {
        assert.match(guide, /MF_TOKEN=\$\{MF_TOKEN:\+set\}/, name)
        assert.match(
            guide,
            /Stop and report B, asking the user to unset `MF_TOKEN` first/,
            name
        )
    }
})

// METAFONT, which TeX installs as `mf`, answers --version too.
test('another program called mf is not taken for the CLI', () => {
    const [look] = shBlocks(section(local, '## Step 1', '## Step 2'))
    assert.match(look!, /case "\$bin" in \/\*\) ;; \*\) continue ;; esac/)
    assert.match(
        look!,
        /case "\$\("\$bin" --version 2>\/dev\/null\)" in \[0-9\]\*\) ;; \*\) continue ;; esac/
    )
})

test('token variables are only ever tested for being set', () => {
    for (const [name, guide] of Object.entries(variants))
        for (const block of shBlocks(guide)) {
            for (const use of block.match(/\$\{?MF_\w*TOKEN\w*[^\s"]*/g) ?? [])
                assert.match(use, /^\$\{MF_\w+:\+set\}$/, `${name}: ${use}`)
            assert.doesNotMatch(block, /\b(env|printenv)\b/, name)
        }
})

// Seen on a local stack [2026-09-29]: with SSH_CONNECTION set and no browser
// to open, the agent chose the loopback login and was still polling it at the
// six-minute mark.
test('a remote shell goes straight to the code flow', () => {
    for (const [name, guide] of Object.entries(variants)) {
        assert.match(
            guide,
            /SSH=\$\{SSH_CONNECTION:\+yes\}\$\{SSH_TTY:\+yes\}/,
            name
        )
        assert.match(
            guide,
            /DISPLAY=\$\{DISPLAY:-\}\$\{WAYLAND_DISPLAY:-\}/,
            name
        )
        assert.match(
            guide,
            /`SSH=yes`, or `OS=Linux` with nothing after `DISPLAY=`: the browser is on another computer\. Use 2b\./,
            name
        )
    }
})

// Seen on a local stack [2026-09-29]: stable mf 4.8.0 has no
// --print-auth-url, and `mf update --yes` only reinstalls 4.8.0.
test('without --print-auth-url the stable guide checks for a release, then reports B', () => {
    const elsewhere = section(local, '### 2b', '## Step 3')
    const check = elsewhere.indexOf('\nmf update --check\n')
    assert.notEqual(check, -1)
    assert.ok(check < elsewhere.indexOf('mf update --yes'))
    assert.match(elsewhere, /cannot sign in from another computer yet/)
    assert.doesNotMatch(section(staging, '### 2b', '## Step 3'), /mf update/)
})

// Seen on a local stack [2026-09-29]: Codex stopped the nohup'ed login as soon
// as the command returned; it only got through by running it in the
// foreground.
test('a login the host stops in the background moves to the foreground', () => {
    const here = section(local, '### 2a', '### 2b')
    assert.match(
        here,
        /Codex stops background processes as soon as a command returns/
    )
    assert.match(
        here,
        /run `mf --profile <profile> --api-url '[^']+' login --json` in the foreground/
    )
    assert.match(
        here,
        /the process is gone before the log shows a result, do the same/
    )
})

// mf pretty-prints its JSON, so the log says `"ok": true`; a grep for the
// compact form never matches (checked against a real login log
// [2026-09-29]). The wait watches the process instead.
test('the wait is bounded, never starts with sleep and watches the process', () => {
    for (const [name, guide] of Object.entries(variants)) {
        assert.doesNotMatch(guide, /"ok":true/, name)
        const wait = shBlocks(section(guide, '### 2a', '### 2b')).find((b) =>
            b.includes('kill -0')
        )
        assert.ok(wait, name)
        assert.match(wait, /^i=0;/, name)
        const [, runs, pause] = wait.match(/-lt (\d+) .* sleep (\d+);/) ?? []
        assert.ok(Number(runs) * Number(pause) < 120, `${name}: ${wait}`)
    }
})

test('the blocks stay POSIX sh', () => {
    for (const [name, guide] of Object.entries(variants))
        for (const block of shBlocks(guide)) {
            assert.doesNotMatch(
                block,
                /&>|\[\[|\bseq |\btimeout |pipefail|echo -e/,
                `${name}: ${block}`
            )
            assert.doesNotMatch(
                block,
                /(^|[\s;])(path|status|commands)=/m,
                `${name}: ${block}`
            )
        }
})

test('the one-time code is shape-checked and quoted', () => {
    for (const [name, guide] of Object.entries(variants)) {
        assert.match(guide, /login --auth-code '<code>' --json$/m, name)
        assert.match(
            guide,
            /`mf_auth_` followed only by letters, digits, `_` or `-`/,
            name
        )
    }
})

test('the user gets the code the consent page asks them to match', () => {
    for (const [name, guide] of Object.entries(variants)) {
        assert.match(
            section(guide, '### 2a', '### 2b'),
            /give them both: the page shows the same code/,
            name
        )
        assert.match(
            section(guide, '### 2b', '## Step 3'),
            /its `userCode` \(the page shows the same code\)/,
            name
        )
    }
})

// Seen on a local stack [2026-09-29]: Codex spent eight commands looking for
// the CLI bundled with its desktop app, which now ships as ChatGPT.app.
test('the plugin steps verify themselves and name the desktop Codex CLI', () => {
    const blocks = shBlocks(section(local, '## Step 4', '## Step 5'))
    assert.ok(blocks.some((b) => /; claude plugin list$/m.test(b)))
    const codex = blocks.find((b) => b.includes('codex_bin'))
    assert.ok(codex)
    assert.match(
        codex,
        /^codex_bin=\/Applications\/ChatGPT\.app\/Contents\/Resources\/codex-cli\/bin\/codex$/m
    )
    assert.match(codex, /command -v codex/)
    assert.doesNotMatch(codex, /\*/)
})

// Seen on a local stack [2026-09-28]: a headless Claude Code run told the user
// to approve, polled for a minute, then ended its turn asking to be told when
// done, so the login it had started timed out unattended.
test('the browser approval is an active wait, not the end of the turn', () => {
    assert.match(local, /part of this step, not the end of your turn/)
    assert.match(local, /Do not ask the user to tell you when they are done/)
})

// Seen on a local stack [2026-09-28]: after a fresh install the agent ran
// "$HOME/.local/bin/mf" but handed off a message that said plain `mf`.
// Seen on a local stack [2026-09-29]: with `<profile>` in the template, two
// Sonnet runs reported A with a bare `mf --profile …` line instead of the
// message, so report A now has to carry the message itself.
test('the hand-off message carries the command the agent actually ran', () => {
    assert.match(
        production,
        /the full `mf` path from step 1 \(for example `"\$HOME\/\.local\/bin\/mf"`\) in place of `mf`, and the profile from step 2 in place of `<profile>`/
    )
    assert.match(
        staging,
        /Replace `<profile>` with the profile from step 2 and keep the rest exactly as written/
    )
    for (const [name, guide] of Object.entries(variants))
        assert.match(
            guide,
            /\*\*A — Connected\.\*\* .*the first message for a new session from step 5, filled in\./,
            name
        )
})

// install.sh reads MF_CHANNEL and MF_INSTALL_DIR itself, so they must be set
// on `sh`, not on `curl` (apps/cli/test/install-script.test.ts).
test('the dev channel installs a private copy and hands off its path', () => {
    assert.match(
        staging,
        /^curl -fsSL \S+ \| MF_CHANNEL=dev MF_INSTALL_DIR="\$HOME\/\.local\/share\/manyfold\/dev\/bin" sh$/m
    )
    assert.doesNotMatch(staging, /MF_\w+=\S+ curl/)
    assert.match(
        staging,
        /through `"\$HOME\/\.local\/share\/manyfold\/dev\/bin\/mf" --profile <profile> --api-url 'https:\/\/api-staging\.example\.com\/api'` \(web app: https:\/\/app-staging\.example\.com\)/
    )
})

test('the guide names the API to use when it was fetched elsewhere', () => {
    const guide = renderAgentSetupGuide({
        apiUrl: 'https://tunnel.example.com/api',
        requestedVia: 'http://localhost:7180/api',
        webUrl: 'http://localhost:7181',
        cliChannel: 'stable',
        cliInstallUrl: INSTALL_URL
    })
    assert.match(
        guide,
        /You fetched this guide through `http:\/\/localhost:7180\/api`, but this deployment's API is `https:\/\/tunnel\.example\.com\/api`/
    )
    const same = renderAgentSetupGuide({
        apiUrl: 'https://api.example.com/api',
        requestedVia: 'https://api.example.com/api',
        cliChannel: 'stable',
        cliInstallUrl: INSTALL_URL
    })
    assert.doesNotMatch(same, /You fetched this guide through/)
})

test('an unpublished web app URL is asked for, never guessed', () => {
    const guide = renderAgentSetupGuide({
        apiUrl: 'https://mf.example.org/api',
        cliChannel: 'stable',
        cliInstallUrl: INSTALL_URL
    })
    assert.match(guide, /- Web app: not published by this deployment/)
    assert.doesNotMatch(guide, /\(web app:/)
})

test('the API URL is single-quoted wherever a command carries it', () => {
    const guide = renderAgentSetupGuide({
        apiUrl: "https://mf.example.org/it's $(id)/api",
        cliChannel: 'stable',
        cliInstallUrl: INSTALL_URL
    })
    assert.match(
        guide,
        /--api-url 'https:\/\/mf\.example\.org\/it'\\''s \$\(id\)\/api'/
    )
    for (const line of guide
        .split('\n')
        .filter((l) => l.includes('--api-url ')))
        assert.match(line, /--api-url '/, line)
})
