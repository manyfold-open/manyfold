import { DEFAULT_CLI_API_URL, type MfCliChannel } from './cliVersion'
import { cliProfileForApiUrl } from './profile-paths'

// The runbook an AI coding agent follows to connect itself to a Manyfold
// deployment: install mf, sign the user in, verify, add the plugin, hand off.
// Each deployment renders its own copy (GET /api/agent-setup.md), so the API
// URL, CLI channel and profile in it are that deployment's, and a local dev
// stack serves the version under development. Every `mf` command below is
// drift-tested against the real command tree (apps/cli).

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

const CLI_RELEASES_URL = 'https://github.com/manyfold-open/manyfold/releases'

const code = (value: string): string => `\`${value}\``

const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

const sh = (...commands: string[]): string[] => ['```sh', ...commands, '```']

export const renderAgentSetupGuide = (input: AgentSetupGuideInput): string => {
    const isDefaultApi = input.apiUrl === DEFAULT_CLI_API_URL
    const dev = input.cliChannel === 'dev'
    const devMf = `"${AGENT_SETUP_DEV_CLI_DIR}/mf"`
    const profile = isDefaultApi
        ? '<profile>'
        : cliProfileForApiUrl(input.apiUrl)
    const target = `--profile ${profile} --api-url ${shellQuote(input.apiUrl)}`
    const signedIn = `${code('"kind": "human-session"')} or ${code('"kind": "human-api-token"')}`

    const deployment = [
        '## This deployment',
        '',
        `- API: ${code(input.apiUrl)}`,
        input.webUrl
            ? `- Web app: ${code(input.webUrl)}`
            : '- Web app: not published by this deployment. Ask the user for its address before you link to it.',
        `- CLI channel: ${code(input.cliChannel)}`,
        isDefaultApi
            ? `- CLI profile: chosen in step 2, written ${code('<profile>')} below.`
            : `- CLI profile: ${code(profile)}`,
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
        `6. Run the ${code('mf')} commands exactly as written below. The ones that talk to the API carry ${code(target)}; keep it on any other ${code('mf')} command you run for this deployment.`,
        '7. Talk to the user in their language.'
    ]

    const step0 = [
        '## Step 0: Where you are running',
        '',
        `- ${code('MF_API_TOKEN')} is set in your environment: you are inside Manyfold (a managed agent or a Manyfold terminal) and already connected. Confirm with ${code('mf whoami --json')}, skip the other steps, and use ${code('mf help --agent')} as your guide.`,
        '- You cannot run shell commands: stop and report B.',
        '- Otherwise, continue with step 1.'
    ]

    const step1 = dev
        ? [
              `## Step 1: Get the ${code('mf')} CLI`,
              '',
              `This deployment follows the dev channel. Install a private copy of ${code('mf')} that leaves any other installation alone, even if ${code('mf')} is already on PATH:`,
              '',
              ...sh(
                  `curl -fsSL ${input.cliInstallUrl} | MF_CHANNEL=dev MF_INSTALL_DIR="${AGENT_SETUP_DEV_CLI_DIR}" sh`,
                  `${devMf} --version`
              ),
              '',
              `From here on, ${code('mf')} means ${code(devMf)}.`
          ]
        : [
              `## Step 1: Get the ${code('mf')} CLI`,
              '',
              `If this works, use that ${code('mf')}:`,
              '',
              ...sh('mf --version'),
              '',
              'Otherwise install it:',
              '',
              ...sh(
                  `curl -fsSL ${input.cliInstallUrl} | sh`,
                  '"$HOME/.local/bin/mf" --version'
              ),
              '',
              `and use ${code('"$HOME/.local/bin/mf"')} wherever this guide says ${code('mf')}.`
          ]

    const chooseProfile = isDefaultApi
        ? [
              `Choose the CLI profile, written ${code('<profile>')} from here on:`,
              '',
              ...sh('mf profile list --json', 'mf profile show default --json'),
              '',
              `1. A listed profile has ${code(`"apiUrl": "${input.apiUrl}"`)} and ${code('"loggedIn": true')}: use it and go to step 3.`,
              `2. Otherwise, if ${code('default')} has no ${code('apiUrl')} or has this one, use ${code('default')}.`,
              `3. Otherwise use ${code('manyfold')}, unless ${code('mf profile show manyfold --json')} reports another ${code('apiUrl')}; then stop and report B.`,
              '',
              'Then sign in with 2a or 2b.'
          ]
        : [
              `This guide keeps this deployment in its own CLI profile, ${code(profile)}, so any other Manyfold login on this computer stays untouched. Check whether it is already signed in:`,
              '',
              ...sh(
                  `mf profile show ${profile} --json`,
                  `mf ${target} whoami --json`
              ),
              '',
              `- ${code('profile show')} reports an ${code('apiUrl')} other than ${code(input.apiUrl)}: the profile belongs to another deployment. Stop and report B.`,
              `- ${code('whoami')} succeeds with ${signedIn}: you are signed in. Go to step 3.`,
              '- Otherwise, sign in with 2a or 2b.'
          ]

    const step2 = [
        '## Step 2: Sign in',
        '',
        ...chooseProfile,
        '',
        "### 2a. The user's browser is on this computer",
        '',
        ...sh(
            'log=$(mktemp)',
            `nohup mf ${target} login --json > "$log" 2>&1 &`,
            'echo "log=$log pid=$!"'
        ),
        '',
        `This opens the sign-in page in the user's browser. Tell the user to approve Manyfold there; if no window appeared, give them the ${code('Open:')} URL from the log.`,
        '',
        `Waiting for that approval is part of this step, not the end of your turn. Do not ask the user to tell you when they are done: keep checking the log every few seconds until it contains ${code('"ok":true')}, shows an error, or 15 minutes pass. If it shows an error, or the process exits without it, use 2b.`,
        '',
        '### 2b. The browser is on another computer, or 2a failed',
        '',
        ...sh('mf login --help'),
        '',
        ...(dev
            ? [
                  `If the help lists no ${code('--print-auth-url')}, this ${code('mf')} is too old: run the install command from step 1 again, which updates the private copy, and check once more.`
              ]
            : [
                  `If the help lists no ${code('--print-auth-url')}, this ${code('mf')} is too old. Ask the user whether you may update it; if they agree, run the command below, otherwise report B.`,
                  '',
                  ...sh('mf update --yes')
              ]),
        '',
        ...sh(`mf ${target} login --print-auth-url --json`),
        '',
        `It prints a JSON object and exits. Give the user its ${code('authUrl')}, and ask them to approve and send you the code the page then shows: it starts with ${code('mf_auth_')} and expires 15 minutes after the command ran. Finish with their code:`,
        '',
        ...sh(`mf ${target} login --auth-code <code> --json`),
        '',
        `Success prints ${code('"ok":true')}.`
    ]

    const step3 = [
        '## Step 3: Verify',
        '',
        ...sh(
            `mf ${target} whoami --json`,
            `mf profile show ${profile} --json`
        ),
        '',
        `Setup is complete when ${code('whoami')} shows ${signedIn} with the user's email, and ${code('profile show')} has ${code(`"apiUrl": "${input.apiUrl}"`)} and ${code('"loggedIn": true')}. Anything else: go back to step 2.`
    ]

    const step4 = [
        '## Step 4: Add the Manyfold plugin',
        '',
        'The plugin gives new sessions a skill for working with Manyfold. It loads only in a new session, so do not try to use it in this one.',
        '',
        '### Claude Code',
        '',
        ...sh('claude plugin list'),
        '',
        `If ${code('manyfold@manyfold')} is missing, add it. When a marketplace named ${code('manyfold')} already exists, for example a local checkout, keep it and run only the second command.`,
        '',
        ...sh(
            'claude plugin marketplace add manyfold-open/manyfold',
            'claude plugin install manyfold@manyfold'
        ),
        '',
        '### Codex',
        '',
        `Use the Codex CLI bundled with the Codex desktop app, not another ${code('codex')} on PATH:`,
        '',
        ...sh(
            'codex plugin marketplace add manyfold-open/manyfold',
            'codex plugin add manyfold@manyfold'
        ),
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
            ? 'Keep the command exactly as written: a new session has no memory of this one.'
            : `Write the command the way you ran it: if ${code('mf')} is not on PATH, put its full path from step 1 in place of ${code('mf')}${isDefaultApi ? `, and replace ${code('<profile>')} with the profile from step 2` : ''}. A new session has no memory of this one.`
    ]

    const failures = [
        '## If something fails',
        '',
        '| Symptom | Cause | What to do |',
        '| --- | --- | --- |',
        `| ${code('mf: command not found')} right after installing | ${code('~/.local/bin')} is not on PATH | Call ${code('"$HOME/.local/bin/mf"')} by its full path; do not edit shell files |`,
        `| ${code('Browser login endpoint is not available')} | The API is older than this CLI, or the API URL is wrong | Compare the URL with this guide; report B with the output |`,
        '| Connection refused, or the host does not resolve | The deployment is unreachable: a local dev stack is stopped, or its tunnel expired | Report B; the user has to bring it back |',
        `| ${code('login timed out')}, or the login process exits | The browser step did not finish within 15 minutes | Run 2a once more, or use 2b |`,
        `| ${code('401')} from ${code('whoami')} | Not signed in, or the saved token expired | Sign in again (step 2) |`,
        '| Network access denied, for example in a Codex sandbox | The command needs the network | Request network access for it and retry |',
        `| No ${code('sh')} (Windows without WSL) | The installer needs a POSIX shell | Download the Windows zip from ${CLI_RELEASES_URL}, put ${code('mf.exe')} on PATH, then continue |`,
        '| The plugin install fails | Network or git problem | Retry once; if it still fails, finish without it and say so in the report |'
    ]

    const report = [
        '## Report',
        '',
        'Finish with exactly one of these:',
        '',
        `- **A — Connected.** The account email, the API, the profile, the ${code('mf')} command, and whether the plugin was installed.`,
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
        ...step0,
        '',
        ...step1,
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
