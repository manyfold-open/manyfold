import { CLI_INSTALL_URL } from '@/common/brand'
import { buildManagedPathScript } from '@manyfold/shared'
import { Injectable, Logger } from '@nestjs/common'
import {
    execSprite,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { resolveMfDeployEnv } from '@/common/deploy-env'

export const MF_SHELL_ENV_START = '# mf-env-start'
export const MF_SHELL_ENV_END = '# mf-env-end'

interface HostShellEnv {
    apiBaseUrl?: string
    deployEnv?: string
}

export interface SpriteShellEnvInput extends HostShellEnv {
    client: SpritesClient
    spriteName: string
    logger?: SpritesLogger
    timeoutMs?: number
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

@Injectable()
export class SpriteShellEnvService {
    private readonly log = new Logger(SpriteShellEnvService.name)

    async write(input: SpriteShellEnvInput): Promise<void> {
        const result = await execSprite(
            input.client,
            input.spriteName,
            {
                cmd: ['bash', '-lc', buildShellEnvScript(input)],
                stdin: '',
                timeoutMs: input.timeoutMs ?? 30_000
            },
            input.logger
        )
        if (result.exitCode !== 0 || !result.stdout.includes('MF_SHELL_ENV_OK'))
            this.log.warn(
                `failed to install MF_* shell env on ${input.spriteName}: ` +
                    `exit=${result.exitCode} stderr=${result.stderr.slice(0, 256)}`
            )
    }

    async installCli(input: {
        client: SpritesClient
        spriteName: string
        channel: MfCliInstallChannel
        logger?: SpritesLogger
        timeoutMs?: number
    }): Promise<void> {
        const marker =
            input.channel === 'dev' ? 'MF_DEV_CLI_OK' : 'MF_STABLE_CLI_OK'
        const result = await execSprite(
            input.client,
            input.spriteName,
            {
                cmd: ['bash', '-lc', buildCliInstallScript(input.channel)],
                stdin: '',
                timeoutMs: input.timeoutMs ?? 180_000
            },
            input.logger
        )
        if (result.exitCode !== 0 || !result.stdout.includes(marker))
            this.log.warn(
                `failed to install ${input.channel} CLI on ${input.spriteName}: ` +
                    `exit=${result.exitCode} stderr=${result.stderr.slice(0, 256)}`
            )
    }
}
