import { DEFAULT_CLI_API_URL } from '@manyfold/shared'

// Which deployment the machine should report to. A fresh CLI defaults to the
// hosted API, so every other deployment has to say so on the command line or
// the daemon registers against someone else's platform; the hosted one leaves
// the command as short as it has always been. `--api-url` outranks a profile's
// stored value, so it also survives a machine that has signed in elsewhere.
export const daemonApiUrlArgs = (apiBaseUrl: string): string =>
    apiBaseUrl === DEFAULT_CLI_API_URL ? '' : ` --api-url ${apiBaseUrl}`

// Two ways to run the same token. install.sh forwards everything after `-s --`
// to the freshly installed binary, so the first line installs the CLI then
// registers + starts the daemon in one copy-paste. The second is for machines
// that already have `mf`. `-y` skips the start prompt either way.
export const daemonInstallCommand = (
    token: string,
    apiBaseUrl: string
): string =>
    `curl -fsSL https://manyfold.ai/cli/install.sh | sh -s -- daemon register --token ${token}${daemonApiUrlArgs(apiBaseUrl)} -y`

export const daemonRegisterCommand = (
    token: string,
    apiBaseUrl: string
): string =>
    `mf daemon register --token ${token}${daemonApiUrlArgs(apiBaseUrl)} -y`

// Token-less onboarding: install.sh reattaches a controlling terminal so the
// forwarded `mf setup` can run its browser sign-in, then registers + starts the
// daemon under the signed-in account. No secret in the command, so it never
// needs a per-machine token — nothing to leak into shell history or a screen
// share, nothing to re-issue.
export const daemonSetupCommand = (apiBaseUrl: string): string =>
    `curl -fsSL https://manyfold.ai/cli/install.sh | sh -s -- setup${daemonApiUrlArgs(apiBaseUrl)}`
