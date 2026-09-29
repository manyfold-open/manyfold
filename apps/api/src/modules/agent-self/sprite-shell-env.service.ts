import { CLI_INSTALL_URL } from '@/common/brand'
import { buildManagedPathScript } from '@manyfold/shared'
import { resolveMfDeployEnv } from '@/common/deploy-env'

export const MF_SHELL_ENV_START = '# mf-env-start'
export const MF_SHELL_ENV_END = '# mf-env-end'

interface HostShellEnv {
    apiBaseUrl?: string
    deployEnv?: string
}

const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

export const buildShellEnvBlock = (input: HostShellEnv): string => {
    // Profiles are shared by every agent on the host. Identity belongs to
    // each execution, and PATH has its own last-sorting managed block.
    const apiBaseUrl = input.apiBaseUrl?.trim()
    const deployEnv = resolveMfDeployEnv(input.deployEnv)
    return [
        MF_SHELL_ENV_START,
        ...(apiBaseUrl ? [`export MF_API_URL=${shellQuote(apiBaseUrl)}`] : []),
        `export MF_DEPLOY_ENV=${shellQuote(deployEnv)}`,
        MF_SHELL_ENV_END
    ].join('\n')
}

export const buildShellEnvScript = (input: HostShellEnv): string => {
    const block = buildShellEnvBlock(input)
    return [
        'set -eu',
        `BLOCK="$(cat <<'MF_SHELL_ENV_BLOCK'\n${block}\nMF_SHELL_ENV_BLOCK\n)"`,
        'if [ -w /etc/profile.d ] || mkdir -p /etc/profile.d 2>/dev/null; then',
        '  printf \'%s\\n\' "$BLOCK" > /etc/profile.d/mf.sh 2>/dev/null || true',
        '  chmod 0644 /etc/profile.d/mf.sh 2>/dev/null || true',
        'fi',
        'for shell_init in "$HOME/.bashrc" "$HOME/.profile"; do',
        '  touch "$shell_init"',
        `  sed -i.bak '/${MF_SHELL_ENV_START}/,/${MF_SHELL_ENV_END}/d' "$shell_init" 2>/dev/null || true`,
        '  rm -f "$shell_init.bak" 2>/dev/null || true',
        '  if [ -n "$(tail -n 1 "$shell_init" 2>/dev/null)" ]; then printf \'\\n\' >> "$shell_init"; fi',
        '  printf \'%s\\n\' "$BLOCK" >> "$shell_init"',
        'done',
        buildManagedPathScript(),
        'echo MF_SHELL_ENV_OK'
    ].join('\n')
}

export type MfCliInstallChannel = 'stable' | 'dev'

export const cliInstallChannelForDeployEnv = (
    deployEnv: string
): MfCliInstallChannel => (deployEnv === 'staging' ? 'dev' : 'stable')

export const buildCliInstallScript = (
    channel: MfCliInstallChannel,
    version?: string
): string => {
    const marker = channel === 'dev' ? 'MF_DEV_CLI_OK' : 'MF_STABLE_CLI_OK'
    const versionEnv = version ? `VERSION="${version}" ` : ''
    const channelEnv = channel === 'dev' ? 'MF_CHANNEL=dev ' : ''
    return [
        'set -eu',
        `curl -fsSL ${CLI_INSTALL_URL} | ${versionEnv}${channelEnv}MF_INSTALL_DIR="$HOME/.local/bin" sh`,
        '"$HOME/.local/bin/mf" --version',
        buildManagedPathScript(),
        `echo ${marker}`
    ].join('\n')
}

// herdr inside a sandbox (ADR-0031): the same installer herdr publishes for
// users, into the bin dir the sprite's PATH already carries. The version line
// after it is what the caller parses; the marker is the success contract.
export const HERDR_INSTALL_URL = 'https://herdr.dev/install.sh'
export const HERDR_INSTALL_MARKER = 'MF_HERDR_OK'

// herdr greets its first TUI client with a welcome dialog, which in a sandbox
// lands over the first handed-off conversation in the browser viewer and has
// to be dismissed before the TUI under it can be used. The platform owns this
// herdr, so the dialog is marked seen when herdr arrives — only when there is
// no config yet, so a sandbox whose herdr was configured by hand keeps it.
// Seen on a local sandbox [2026-09-22]: the dialog covered Claude Code's
// first-run screens on the first Switch to herdr.
const HERDR_CONFIG_SEED = 'onboarding = false'

export const buildHerdrInstallScript = (): string =>
    [
        'set -eu',
        `curl -fsSL ${HERDR_INSTALL_URL} | HERDR_INSTALL_DIR="$HOME/.local/bin" sh`,
        'mkdir -p "$HOME/.config/herdr"',
        `[ -e "$HOME/.config/herdr/config.toml" ] || printf '%s\\n' '${HERDR_CONFIG_SEED}' > "$HOME/.config/herdr/config.toml"`,
        'echo "herdr-installed=$("$HOME/.local/bin/herdr" --version 2>/dev/null | head -1)"',
        `echo ${HERDR_INSTALL_MARKER}`
    ].join('\n')
