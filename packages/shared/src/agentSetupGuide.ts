import { DEFAULT_CLI_API_URL, type MfCliChannel } from './cliVersion'
import { cliProfileForApiUrl, isLoopbackHostname } from './profile-paths'

// The runbook an AI coding agent follows to connect itself to a Manyfold
// deployment: look around, get mf, sign the user in, verify, add the plugin,
// hand off. Each deployment renders its own copy (GET /api/agent-setup.md), so
// the API URL, CLI channel and profile in it are that deployment's, and a
// local dev stack serves the version under development. Every `mf` command
// below is drift-tested against the real command tree (apps/cli).
//
// Agents run each block verbatim, often as one command, so blocks stay POSIX
// sh and never contain a bare `mf ` word that is not a real command: the drift
// test reads any such word as an `mf` invocation.

export interface AgentSetupGuideInput {
    // This deployment's API base, `/api` prefix included.
    apiUrl: string
    // The address the guide was requested through, when it differs.
    requestedVia?: string
    // Unset when the deployment does not publish its web app URL.
    webUrl?: string
    cliChannel: MfCliChannel
    cliInstallUrl: string
}

// A dev-channel binary goes here, so the guide never replaces the user's own.
const AGENT_SETUP_DEV_CLI_DIR = '$HOME/.local/share/manyfold/dev/bin'

// The browser sign-in keeps its log and pid at fixed paths rather than in a
// mktemp file, so the wait command reads the same on every run and the user
// approves it once.
const LOGIN_STATE_DIR = '"$HOME/.cache/manyfold"'
const LOGIN_LOG = '"$HOME/.cache/manyfold/agent-login.log"'
const LOGIN_PID = '"$HOME/.cache/manyfold/agent-login.pid"'

// The Codex desktop app ships its own CLI, the one whose plugins it loads.
const CODEX_APP_CLI =
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'

const CLI_RELEASES_URL = 'https://github.com/manyfold-open/manyfold/releases'

const code = (value: string): string => `\`${value}\``

const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

const sh = (...commands: string[]): string[] => ['```sh', ...commands, '```']

// Read-only checks on the mf held in $bin: its version, its profiles (read
// from disk, no token leaves the machine), and whether it can sign in from
// another computer.
const mfProbes = (indent = ''): string[] => [
    `${indent}"$bin" --version`,
    `${indent}"$bin" profile list --json`,
    `${indent}"$bin" login --help | grep -e --print-auth-url || echo "no --print-auth-url"`
]

export const renderAgentSetupGuide = (input: AgentSetupGuideInput): string => {
    const isDefaultApi = input.apiUrl === DEFAULT_CLI_API_URL
    const dev = input.cliChannel === 'dev'
    const devMf = `"${AGENT_SETUP_DEV_CLI_DIR}/mf"`
    // The profile this guide signs in to when no listed one is signed in
    // here already. Production has no single name: it keeps `default`, or
    // falls back to `manyfold` when `default` belongs elsewhere.
    const ownProfile = isDefaultApi
        ? undefined
        : cliProfileForApiUrl(input.apiUrl)
    const loopback = isLoopbackHostname(new URL(input.apiUrl).hostname)
    const target = `--profile <profile> --api-url ${shellQuote(input.apiUrl)}`
    const signedIn = `${code('"kind": "human-session"')} or ${code('"kind": "human-api-token"')}`
    const hasThisApi = `${code(`"apiUrl": "${input.apiUrl}"`)} and ${code('"loggedIn": true')}`

    const deployment = [
        '## This deployment',
        '',
        `- API: ${code(input.apiUrl)}`,
        input.webUrl
            ? `- Web app: ${code(input.webUrl)}`
            : '- Web app: not published by this deployment. Ask the user for its address before you link to it.',
        `- CLI channel: ${code(input.cliChannel)}`,
        ownProfile
            ? `- CLI profile: ${code(ownProfile)}, unless step 2 finds another profile already signed in here. Written ${code('<profile>')} below.`
            : `- CLI profile: chosen in step 2, written ${code('<profile>')} below.`,
        dev
            ? `- ${code('mf')} command: ${code(devMf)}. Every ${code('mf')} in this guide means this path.`
            : `- ${code('mf')} command: chosen in step 1. Every ${code('mf')} in this guide means that command.`,
        ...(input.requestedVia && input.requestedVia !== input.apiUrl
            ? [
                  '',
                  `You fetched this guide through ${code(input.requestedVia)}, but this deployment's API is ${code(input.apiUrl)}. Use ${code(input.apiUrl)} in every command.`
              ]
            : [])
    ]

    const rules = [
        '## Rules',
        '',
        '1. Do the steps in order. Setup is complete only when step 3 passes.',
        '2. Wait for each command to finish, and never run two logins at once.',
        '3. Never ask the user for a token or an API key. The only thing they may send you is the one-time code in step 2b.',
        `4. Run ${code('mf setup')} or ${code('mf daemon')} commands only if the user asks: they register this computer as a Manyfold host.`,
        `5. Do not replace, update or delete an ${code('mf')} that is already installed, and do not edit shell startup files.`,
        `6. Run the ${code('mf')} commands exactly as written below. The ones that talk to the API carry ${code(target)}; keep it on any other ${code('mf')} command you run for this deployment, and never point another profile at this API: ${code('mf')} sends a profile's saved token to whatever ${code('--api-url')} it is given.`,
        '7. If your commands run in a sandbox that blocks network access or writes outside the workspace (Codex does by default), ask for approval to run the install, sign-in and plugin commands outside it before you run them: a sign-in the user approved is lost if it cannot be saved.',
        '8. Talk to the user in their language.'
    ]

    const lookAround = [
        '## Step 1: Look around',
        '',
        'If you cannot run shell commands, stop and report B. Otherwise run this as one command. It only reads: it changes nothing and sends nothing anywhere.',
        '',
        ...sh(
            'echo "MF_API_TOKEN=${MF_API_TOKEN:+set} MF_AGENT_ID=${MF_AGENT_ID:+set} MF_TOKEN=${MF_TOKEN:+set}"',
            'echo "SSH=${SSH_CONNECTION:+yes}${SSH_TTY:+yes} DISPLAY=${DISPLAY:-}${WAYLAND_DISPLAY:-} OS=$(uname -s)"',
            ...(dev
                ? []
                : [
                      'for bin in "$(command -v mf)" "$HOME/.local/bin/mf"; do',
                      '    case "$bin" in /*) ;; *) continue ;; esac',
                      '    case "$("$bin" --version 2>/dev/null)" in [0-9]*) ;; *) continue ;; esac',
                      '    echo "mf=$bin"',
                      ...mfProbes('    '),
                      '    break',
                      'done'
                  ])
        ),
        '',
        `- ${code('MF_API_TOKEN=set')} or ${code('MF_AGENT_ID=set')}: you are inside Manyfold (a managed agent or a Manyfold terminal) and already connected. Confirm with ${code('mf whoami --json')}, skip the other steps, and use ${code('mf help --agent')} as your guide.`,
        `- ${code('MF_TOKEN=set')}: that variable overrides any sign-in and would send its token to this deployment. Stop and report B, asking the user to unset ${code('MF_TOKEN')} first.`,
        ...(dev
            ? [
                  `- Otherwise, install this deployment's private copy of ${code('mf')}, which leaves any other installation alone even if one is on PATH, and check it:`,
                  '',
                  ...sh(
                      `curl -fsSL ${input.cliInstallUrl} | MF_CHANNEL=dev MF_INSTALL_DIR="${AGENT_SETUP_DEV_CLI_DIR}" sh`,
                      `bin=${devMf}`,
                      ...mfProbes()
                  ),
                  '',
                  `The lines after the install are its version, its profiles, and whether it has ${code('--print-auth-url')}.`
              ]
            : [
                  `- A line ${code('mf=<path>')}: that is the ${code('mf')} command, and every ${code('mf')} in this guide means that path. The lines after it are its version, its profiles, and whether it has ${code('--print-auth-url')}.`,
                  `- No ${code('mf=')} line: the Manyfold CLI is not installed, though another program called ${code('mf')} may be (METAFONT, for example). Install it. The installer takes the build for this computer from the stable channel, checks its SHA-256 against the release manifest, and writes only ${code('~/.local/bin/mf')}; it does not edit shell startup files. Then check it the same way:`,
                  '',
                  ...sh(
                      `curl -fsSL ${input.cliInstallUrl} | sh`,
                      'bin="$HOME/.local/bin/mf"',
                      ...mfProbes()
                  ),
                  '',
                  `From here on, ${code('mf')} means ${code('"$HOME/.local/bin/mf"')}.`
              ])
    ]

    const sameApi = [
        `A trailing ${code('/')} makes no difference`,
        loopback
            ? `, and neither does ${code('localhost')} against ${code('127.0.0.1')}`
            : '',
        '.'
    ].join('')
    const chooseProfile = [
        '### Choose the profile',
        '',
        `Use the profiles step 1 listed. ${code('<profile>')} in the commands below means the one you choose here:`,
        '',
        `1. A listed profile has ${hasThisApi}: it is already signed in to this deployment. Use it and go to step 3. ${sameApi}`,
        ...(ownProfile
            ? [
                  `2. Otherwise use ${code(ownProfile)}. If the list shows ${code(ownProfile)} with another ${code('apiUrl')}, it belongs to another deployment: stop and report B.`
              ]
            : [
                  `2. Otherwise, if ${code('default')} has no ${code('apiUrl')} or has this one, use ${code('default')}.`,
                  `3. Otherwise use ${code('manyfold')}, unless the list shows ${code('manyfold')} with another ${code('apiUrl')}; then stop and report B.`
              ])
    ]

    const whereIsTheBrowser = [
        "### Where the user's browser is",
        '',
        `- ${code('SSH=yes')}, or ${code('OS=Linux')} with nothing after ${code('DISPLAY=')}: the browser is on another computer. Use 2b.`,
        '- Otherwise it is on this computer. Use 2a.'
    ]

    const signInHere = [
        "### 2a. The user's browser is on this computer",
        '',
        ...sh(
            `mkdir -p ${LOGIN_STATE_DIR}`,
            `nohup mf ${target} login --json > ${LOGIN_LOG} 2>&1 < /dev/null &`,
            `echo "$!" > ${LOGIN_PID}`,
            'sleep 3',
            `cat ${LOGIN_LOG}`
        ),
        '',
        `Codex stops background processes as soon as a command returns, so this block does not work there. In Codex, run ${code(`mf ${target} login --json`)} in the foreground instead: it prints the same lines at once and keeps running until the user approves, while you keep reading its output. Any agent: if the log stays empty, or the process is gone before the log shows a result, do the same.`,
        '',
        `The log shows ${code('Open:')} with a sign-in link and ${code('Code:')} with a short code, and the link opens in the user's browser. Tell the user to approve Manyfold there, and give them both: the page shows the same code, so they can check the request is theirs.`,
        '',
        'Waiting for that approval is part of this step, not the end of your turn. Do not ask the user to tell you when they are done. Run this, and run it again for as long as it prints `waiting`; one run takes at most 100 seconds:',
        '',
        ...sh(
            `i=0; while [ "$i" -lt 50 ] && kill -0 "$(cat ${LOGIN_PID})" 2>/dev/null; do i=$((i + 1)); sleep 2; done`,
            `kill -0 "$(cat ${LOGIN_PID})" 2>/dev/null && echo waiting || cat ${LOGIN_LOG}`
        ),
        '',
        `Once the login has finished, the log ends with a JSON object. ${code('"ok": true')} means you are signed in: go to step 3. Anything else, for example ${code('login timed out')} after 15 minutes: use 2b.`
    ]

    const signInElsewhere = [
        '### 2b. The browser is on another computer, or 2a failed',
        '',
        `If you started a 2a login, stop it first: ${code(`kill "$(cat ${LOGIN_PID})"`)}.`,
        '',
        ...(dev
            ? [
                  `This needs ${code('--print-auth-url')}, and step 1 showed whether this ${code('mf')} has it. If it printed ${code('no --print-auth-url')}, this private copy is too old: run the install command from step 1 again, which updates it, and check once more.`
              ]
            : [
                  `This needs ${code('--print-auth-url')}, and step 1 showed whether this ${code('mf')} has it. If it printed ${code('no --print-auth-url')}, look for a newer release:`,
                  '',
                  ...sh('mf update --check'),
                  '',
                  `If that offers a newer version, ask the user whether you may update ${code('mf')}; if they agree, run ${code('mf update --yes')} and check ${code('mf login --help')} again. If there is no newer version, or the user says no, stop and report B: this ${code('mf')} release cannot sign in from another computer yet, so the user should paste the prompt into an agent on the computer where their browser is.`
              ]),
        '',
        ...sh(`mf ${target} login --print-auth-url --json`),
        '',
        `It prints a JSON object and exits. Give the user its ${code('authUrl')} and its ${code('userCode')} (the page shows the same code), and ask them to approve and then send you the code the page shows: it starts with ${code('mf_auth_')} and expires 15 minutes after the command ran. Ending your turn to wait for that code is expected here, and it is not the final report: do not write A or B yet.`,
        '',
        `When the code arrives, check that it is ${code('mf_auth_')} followed only by letters, digits, ${code('_')} or ${code('-')}, then finish with it inside the single quotes:`,
        '',
        ...sh(`mf ${target} login --auth-code '<code>' --json`),
        '',
        `Success prints ${code('"ok": true')}.`
    ]

    const step2 = [
        '## Step 2: Sign in',
        '',
        ...chooseProfile,
        '',
        ...whereIsTheBrowser,
        '',
        ...signInHere,
        '',
        ...signInElsewhere
    ]

    const step3 = [
        '## Step 3: Verify',
        '',
        ...sh(`mf ${target} whoami --json`, 'mf profile show <profile> --json'),
        '',
        `Setup is complete when ${code('whoami')} shows ${signedIn} with the user's email, and ${code('profile show')} has ${hasThisApi}.`,
        '',
        `Otherwise go back to step 2, once. If ${code('<profile>')} is a profile you reused there (choice 1), sign in with this guide's own profile instead${ownProfile ? `, ${code(ownProfile)}` : ' (choice 2 or 3)'}: never sign in over a profile you reused. If it fails again, report B.`
    ]

    const step4 = [
        '## Step 4: Add the Manyfold plugin',
        '',
        'The plugin gives new sessions a skill for working with Manyfold. It loads only in a new session, so do not try to use it in this one. Use the section for the agent you are: Claude Code and Codex both install it.',
        '',
        '### If you are Claude Code',
        '',
        ...sh(
            'claude plugin marketplace add manyfold-open/manyfold; claude plugin install manyfold@manyfold; claude plugin list'
        ),
        '',
        `Both are safe to repeat. The first fails harmlessly when a marketplace named ${code('manyfold')} already comes from somewhere else, such as a local checkout; the install uses that one. The plugin is in place when the list shows ${code('manyfold@manyfold')} enabled. If ${code('claude')} is not on PATH, use ${code('"$HOME/.local/bin/claude"')}; if that is missing too, ask the user to run ${code('/plugin marketplace add manyfold-open/manyfold')} and then ${code('/plugin install manyfold@manyfold')} in Claude Code.`,
        '',
        '### If you are Codex (the desktop app or its CLI)',
        '',
        ...sh(
            `codex_bin=${CODEX_APP_CLI}`,
            '[ -x "$codex_bin" ] || codex_bin=$(command -v codex)',
            '"$codex_bin" plugin marketplace add manyfold-open/manyfold; "$codex_bin" plugin add manyfold@manyfold; "$codex_bin" plugin list'
        ),
        '',
        `The desktop app's own CLI comes first; a ${code('codex')} on PATH works too when it has ${code('codex plugin')}. The plugin is in place when the list shows ${code('manyfold@manyfold')} as ${code('installed, enabled')}.`,
        '',
        '### Any other agent',
        '',
        'There is nothing to install. Read the always-current guide instead:',
        '',
        ...sh('mf help --agent')
    ]

    const mfCommand = `${dev ? devMf : 'mf'} ${target}`
    const step5 = [
        '## Step 5: Hand off',
        '',
        'Tell the user, in their language, that this agent is connected: their account email, this deployment, and whether the plugin was installed. Then give them this first message for a new session:',
        '',
        `> Use my Manyfold account through ${code(mfCommand)}${input.webUrl ? ` (web app: ${input.webUrl})` : ''}. List my agents and tell me what you can do for me.`,
        '',
        dev
            ? `Replace ${code('<profile>')} with the profile from step 2 and keep the rest exactly as written, as a quoted message the user can paste: a new session has no memory of this one.`
            : `Write the command the way you ran it: the full ${code('mf')} path from step 1 (for example ${code('"$HOME/.local/bin/mf"')}) in place of ${code('mf')}, and the profile from step 2 in place of ${code('<profile>')}. Keep the rest of the message as written, quoted so the user can paste it: a new session has no memory of this one.`
    ]

    const failures = [
        '## If something fails',
        '',
        '| Symptom | Cause | What to do |',
        '| --- | --- | --- |',
        `| ${code('command not found')} for ${code('mf')} or ${code('claude')} | The install directory is not on PATH | Call it by its full path (step 1, or ${code('"$HOME/.local/bin/claude"')}); do not edit shell files |`,
        `| ${code('Browser login endpoint is not available')} | The API is older than this CLI, or the API URL is wrong | Compare the URL with this guide; report B with the output |`,
        '| Connection refused, or the host does not resolve | The deployment is unreachable: a local dev stack is stopped, or its tunnel expired | Report B; the user has to bring it back |',
        '| The 2a log stays empty, or its process is gone before a result | The agent host stopped the background process (Codex does) | Run the login in the foreground (2a) |',
        `| ${code('login timed out')}, or the login ends with an error | The browser step did not finish within 15 minutes | Use 2b |`,
        `| ${code('401')} from ${code('whoami')} | Not signed in, or the saved token expired | Go back to step 2 as step 3 says |`,
        `| ${code('whoami')} shows an account the user did not approve | ${code('MF_TOKEN')} overrides the sign-in | Report B; ask the user to unset ${code('MF_TOKEN')} |`,
        `| ${code('Operation not permitted')}, or network access denied | A sandbox blocks the command | Ask for approval to run it outside the sandbox, then retry |`,
        `| No ${code('sh')} (Windows without WSL) | The installer needs a POSIX shell | Download the Windows zip from ${CLI_RELEASES_URL}, put ${code('mf.exe')} on PATH, then continue |`,
        '| The plugin install fails | Network or git problem | Retry once; if it still fails, finish without it and say so in the report |'
    ]

    const report = [
        '## Report',
        '',
        'Finish with exactly one of these:',
        '',
        `- **A — Connected.** The account email, the API, the profile, the ${code('mf')} command, whether the plugin was installed, and the first message for a new session from step 5, filled in.`,
        '- **B — Not connected.** The step that failed and the exact error output.'
    ]

    return [
        '# Connect this agent to Manyfold',
        '',
        `This guide is for the AI agent reading it. The Manyfold deployment below generated it: follow it to install the ${code('mf')} CLI, sign the user in, and connect this agent to their Manyfold account.`,
        '',
        ...deployment,
        '',
        ...rules,
        '',
        ...lookAround,
        '',
        ...step2,
        '',
        ...step3,
        '',
        ...step4,
        '',
        ...step5,
        '',
        ...failures,
        '',
        ...report,
        ''
    ].join('\n')
}
