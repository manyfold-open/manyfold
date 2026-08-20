import {
    MANAGED_PATH_BLOCK_END,
    MANAGED_PATH_BLOCK_START,
    buildManagedPathScript
} from '@manyfold/shared'
import { Injectable, Logger } from '@nestjs/common'
import {
    execSprite,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { resolveMfDeployEnv } from '@/common/deploy-env'

export const MF_SHELL_ENV_START = '# mf-env-start'
export const MF_SHELL_ENV_END = '# mf-env-end'

const NCA_SHELL_ENV_START = '# nca-env-start'
const NCA_SHELL_ENV_END = '# nca-env-end'

export interface SpriteShellEnvInput {
    client: SpritesClient
    spriteName: string
    agentId: string
    apiBaseUrl?: string
    apiToken?: string
    deployEnv?: string
    logger?: SpritesLogger
    timeoutMs?: number
    // When the env block carries the identity token (post-insert) the write is
    // load-bearing: a silent failure leaves the agent tokenless, so the caller
    // opts into a throw instead of the best-effort WARN used during provision.
    required?: boolean
}

const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

export const buildShellEnvBlock = (input: {
    agentId: string
    apiBaseUrl?: string
    apiToken?: string
    deployEnv?: string
}): string => {
    // Host-level env only. MF_API_TOKEN + MF_AGENT_ID are deliberately NOT
    // emitted: a sandbox VM's shell profile is shared by every co-resident
    // agent, so per-agent identity is injected per-exec instead (see
    // exec-driver-factory + the sprites terminal). agentId/apiToken stay in the
    // input shape for callers but are no longer written to the profile.
    // PATH is deliberately absent: it now lives in its own last-sorting managed
    // block (buildManagedPathScript) because this one is installed as
    // /etc/profile.d/mf.sh, which the image's own node fragment sorts after and
    // clobbers (#611). Two blocks, but one definition of where PATH comes from.
    const apiBaseUrl = input.apiBaseUrl?.trim()
    const deployEnv = resolveMfDeployEnv(input.deployEnv)
    const exports = [
        ...(apiBaseUrl ? [`export MF_API_URL=${shellQuote(apiBaseUrl)}`] : []),
        `export MF_DEPLOY_ENV=${shellQuote(deployEnv)}`
    ]
    return [MF_SHELL_ENV_START, ...exports, MF_SHELL_ENV_END].join('\n')
}

// Every shared shell file a managed write has ever landed in. The
// /etc/profile.d entries are the reason this list is not just the home files:
// the pre-rename `nca.sh` is mode 0644, always sourced, and is exactly where
// the #650 drill found a co-resident agent's live MF_API_TOKEN.
const MANAGED_SHELL_FILES = [
    '"$HOME/.bashrc"',
    '"$HOME/.profile"',
    '"$HOME/.zshrc"',
    '"$HOME/.bash_profile"',
    '"$HOME/.bash_login"',
    '"$HOME/.zprofile"',
    '/etc/profile.d/mf.sh',
    '/etc/profile.d/nca.sh'
]

// Line shapes a managed write produced before this file stopped emitting
// per-agent values, matched by CONTENT because the blocks that carry them
// predate the `# mf-env-*` markers and are therefore invisible to any
// marker-based sed (#650). Two families:
//
//   1. identity — `export MF_API_TOKEN=` / `MF_AGENT_ID=` and their NCA_
//      spellings. On a co-resident sandbox these are another agent's live
//      credentials, re-exported over the per-exec identity on every login.
//   2. the blind `export PATH="$HOME/.local/bin:$PATH"` prepend, which asserts
//      nothing about position and grows PATH once per source (#611).
//
// Deliberately NOT matched: `MF_API_URL` / `MF_DEPLOY_ENV` (host-level, no
// secret, same value for every agent on the sprite) — dropping those would
// leave an interactive shell on an existing sprite with no API URL until its
// next provision, and this reconcile also runs on paths that never rewrite the
// env block.
const RESIDUE_AWK = [
    'function residue(l) {',
    '  if (l ~ /^[ \\t]*export[ \\t]+(MF|NCA)_(API_TOKEN|AGENT_ID)=/) return 1',
    '  sub(/^[ \\t]*/, "", l)',
    '  sub(/[ \\t]*$/, "", l)',
    '  return l == "export PATH=\\"$HOME/.local/bin:$PATH\\""',
    '}',
    'function flush(   i) {',
    '  print bstart',
    '  for (i = 1; i <= bn; i++) print bbuf[i]',
    '}',
    // The guarded PATH block is the one place a `.local/bin` statement is
    // correct, so it is copied through untouched rather than pattern-matched.
    '$0 == pstart { guard = 1 }',
    'guard { print; if ($0 == pend) guard = 0; next }',
    '$0 == mfstart || $0 == ncastart {',
    '  if (blk) flush()',
    '  blk = 1; bn = 0; kept = 0; bstart = $0',
    '  bend = ($0 == mfstart) ? mfend : ncaend',
    '  next',
    '}',
    // A block whose every line was residue is noise; drop its delimiters with
    // it instead of leaving an empty managed block for the next pass to find.
    'blk && $0 == bend {',
    '  if (kept) { flush(); print }',
    '  blk = 0; bn = 0; kept = 0',
    '  next',
    '}',
    'blk {',
    '  if (residue($0)) next',
    '  bn = bn + 1; bbuf[bn] = $0',
    '  if ($0 ~ /[^ \\t]/) kept = 1',
    '  next',
    '}',
    'residue($0) { next }',
    '{ print }',
    // An unterminated block is a file we do not understand: emit what we held
    // back rather than truncate it.
    'END { if (blk) flush() }'
].join('\n')

// Content-based cleanup of legacy managed residue in the shared shell files.
// Best-effort by construction (it runs inside `set -eu` installers on images
// where /etc/profile.d may be read-only), and a strict no-op on a file that
// carries none of the shapes above — including one holding only the current
// `# mf-env-*` and `# mf-path-*` blocks.
export const buildLegacyShellResiduePurgeScript = (): string =>
    [
        'mf_purge_shell_residue() {',
        '  mf_purge_file="$1"',
        '  [ -f "$mf_purge_file" ] || return 0',
        '  [ -w "$mf_purge_file" ] || return 0',
        '  mf_purge_tmp="$(mktemp "${TMPDIR:-/tmp}/mf-purge.XXXXXX" 2>/dev/null)" || return 0',
        '  if awk ' +
            `-v pstart="${MANAGED_PATH_BLOCK_START}" ` +
            `-v pend="${MANAGED_PATH_BLOCK_END}" ` +
            `-v mfstart="${MF_SHELL_ENV_START}" ` +
            `-v mfend="${MF_SHELL_ENV_END}" ` +
            `-v ncastart="${NCA_SHELL_ENV_START}" ` +
            `-v ncaend="${NCA_SHELL_ENV_END}" '`,
        RESIDUE_AWK,
        // Rewrite THROUGH the original file rather than renaming a temp over
        // it: /etc/profile.d/nca.sh must keep its mode and owner, or a shell
        // that can no longer read it stops sourcing the managed env at all.
        '  \' "$mf_purge_file" > "$mf_purge_tmp" 2>/dev/null; then',
        '    cmp -s "$mf_purge_tmp" "$mf_purge_file" || cat "$mf_purge_tmp" > "$mf_purge_file" 2>/dev/null || true',
        '  fi',
        '  rm -f "$mf_purge_tmp" 2>/dev/null || true',
        '  return 0',
        '}',
        `for mf_purge_target in ${MANAGED_SHELL_FILES.join(' ')}; do`,
        '  mf_purge_shell_residue "$mf_purge_target"',
        'done'
    ].join('\n')

// The whole shared-shell reconcile, in the order it has to happen: strip the
// legacy residue first, then install the guarded PATH block, so the block is
// the only `.local/bin` statement left standing. Every surface that touches an
// existing sprite runs this — provision, npm framework install/upgrade and `mf`
// CLI install/upgrade — which is what carries the cleanup to sandboxes that are
// already provisioned (#611, #650).
export const buildManagedShellReconcileScript = (): string =>
    [buildLegacyShellResiduePurgeScript(), buildManagedPathScript()].join('\n')

export const buildShellEnvScript = (input: {
    agentId: string
    apiBaseUrl?: string
    apiToken?: string
    deployEnv?: string
}): string => {
    const block = buildShellEnvBlock(input)
    return [
        'set -eu',
        // Build the env block as literal text so missing optional values cannot
        // become shell commands such as `undefined`.
        `BLOCK="$(cat <<'MF_SHELL_ENV_BLOCK'\n${block}\nMF_SHELL_ENV_BLOCK\n)"`,
        'remove_legacy_undefined_env_block() {',
        '  target="$1"',
        '  [ -f "$target" ] || return 0',
        '  tmp="$target.mf-tmp"',
        "  awk '",
        '    $0 == "undefined" {',
        '      if (in_block) {',
        '        buffer = buffer $0 ORS',
        '        if (saw_managed_env) {',
        '          in_block = 0; buffer = ""; saw_managed_env = 0; next',
        '        }',
        '        printf "%s", buffer',
        '        in_block = 0; buffer = ""; saw_managed_env = 0; next',
        '      }',
        '      in_block = 1; buffer = $0 ORS; saw_managed_env = 0; next',
        '    }',
        '    in_block {',
        '      buffer = buffer $0 ORS',
        '      if ($0 ~ /^export MF_API_URL=/ || $0 ~ /^export MF_AGENT_ID=/ || $0 ~ /^export NCA_API_URL=/ || $0 ~ /^export NCA_AGENT_ID=/ || $0 ~ /^export MF_DEPLOY_ENV=/ || ($0 ~ /^export PATH=/ && index($0, ".local/bin") > 0)) saw_managed_env = 1',
        '      next',
        '    }',
        '    { print }',
        '    END { if (in_block) printf "%s", buffer }',
        '  \' "$target" > "$tmp" && mv "$tmp" "$target"',
        '}',
        // Try /etc/profile.d/mf.sh first (works on images that source profile.d).
        // Falls back silently if we lack permission.
        'if [ -w /etc/profile.d ] || mkdir -p /etc/profile.d 2>/dev/null; then',
        '  printf \'%s\\n\' "$BLOCK" > /etc/profile.d/mf.sh 2>/dev/null || true',
        '  chmod 0644 /etc/profile.d/mf.sh 2>/dev/null || true',
        'fi',
        // Always write to ~/.bashrc and ~/.profile so interactive shells work even
        // when /etc/profile.d is not sourced. Idempotent: replace any prior block.
        'for shell_init in "$HOME/.bashrc" "$HOME/.profile"; do',
        '  touch "$shell_init"',
        '  remove_legacy_undefined_env_block "$shell_init" || true',
        `  sed -i.bak '/${NCA_SHELL_ENV_START}/,/${NCA_SHELL_ENV_END}/d' "$shell_init" 2>/dev/null || true`,
        `  sed -i.bak '/${MF_SHELL_ENV_START}/,/${MF_SHELL_ENV_END}/d' "$shell_init" 2>/dev/null || true`,
        '  rm -f "$shell_init.bak" 2>/dev/null || true',
        // Separator only when the file does not already end in one — see the
        // same guard in buildManagedPathScript.
        '  if [ -n "$(tail -n 1 "$shell_init" 2>/dev/null)" ]; then printf \'\\n\' >> "$shell_init"; fi',
        '  printf \'%s\\n\' "$BLOCK" >> "$shell_init"',
        'done',
        // Sprite images built before the nca → mf rename only ship `nca`;
        // bridge the new command name so the helper docs keep working.
        'if ! command -v mf >/dev/null 2>&1 && command -v nca >/dev/null 2>&1; then',
        '  mkdir -p "$HOME/.local/bin" 2>/dev/null || true',
        '  ln -sf "$(command -v nca)" "$HOME/.local/bin/mf" 2>/dev/null || true',
        'fi',
        // Last, so the activation block lands after the env block in every file
        // it shares: whichever managed block is written last is the one a shell
        // reads last, and PATH ordering is the whole point of this one. The
        // residue purge rides along and therefore also sees the block just
        // appended above — which is why that block must carry no per-agent
        // value for the purge to be a no-op on it.
        buildManagedShellReconcileScript(),
        'echo MF_SHELL_ENV_OK'
    ].join('\n')
}

export const STAGING_CLI_INSTALL_URL =
    'https://cdn1.manyfold.ai/cli/staging/install.sh'
export const STABLE_CLI_INSTALL_URL = 'https://cdn1.manyfold.ai/cli/install.sh'
export type MfCliInstallChannel = 'stable' | 'staging'

export const cliInstallChannelForDeployEnv = (
    deployEnv: string
): MfCliInstallChannel => (deployEnv === 'staging' ? 'staging' : 'stable')

// Installs over ~/.local/bin/mf — the same path the nca→mf bridge symlink
// occupies — so sprites resolve the selected binary ahead of whatever the base
// image ships. "Ahead of the image" is only true once the managed PATH block is
// in place, so this reconciles it too: a sandbox with no agent never runs a
// framework install, and a CLI upgrade is the touchpoint it does have (#611).
export const buildCliInstallScript = (
    channel: MfCliInstallChannel,
    version?: string
): string => {
    const url =
        channel === 'staging' ? STAGING_CLI_INSTALL_URL : STABLE_CLI_INSTALL_URL
    const marker =
        channel === 'staging' ? 'MF_STAGING_CLI_OK' : 'MF_STABLE_CLI_OK'
    // install.sh honours VERSION=x.y.z to pin a specific build; left unset it
    // resolves the channel's latest. Callers validate `version` against the
    // catalog before it reaches this shell.
    const versionEnv = version ? `VERSION="${version}" ` : ''
    return [
        'set -eu',
        `curl -fsSL ${url} | ${versionEnv}MF_INSTALL_DIR="$HOME/.local/bin" sh`,
        '"$HOME/.local/bin/mf" --version',
        buildManagedShellReconcileScript(),
        `echo ${marker}`
    ].join('\n')
}

@Injectable()
export class SpriteShellEnvService {
    private readonly log = new Logger(SpriteShellEnvService.name)

    async write(input: SpriteShellEnvInput): Promise<void> {
        const script = buildShellEnvScript({
            agentId: input.agentId,
            apiBaseUrl: input.apiBaseUrl,
            apiToken: input.apiToken,
            deployEnv: resolveMfDeployEnv(input.deployEnv)
        })
        const result = await execSprite(
            input.client,
            input.spriteName,
            {
                cmd: ['bash', '-lc', script],
                stdin: '',
                timeoutMs: input.timeoutMs ?? 30_000
            },
            input.logger
        )
        if (
            result.exitCode !== 0 ||
            !result.stdout.includes('MF_SHELL_ENV_OK')
        ) {
            const detail =
                `failed to install MF_* shell env on ${input.spriteName}: ` +
                `exit=${result.exitCode} stderr=${result.stderr.slice(0, 256)}`
            if (input.required) throw new Error(detail)
            this.log.warn(detail)
        }
    }

    async installStagingCli(input: {
        client: SpritesClient
        spriteName: string
        logger?: SpritesLogger
        timeoutMs?: number
    }): Promise<void> {
        await this.installCli({ ...input, channel: 'staging' })
    }

    async installCli(input: {
        client: SpritesClient
        spriteName: string
        channel: MfCliInstallChannel
        logger?: SpritesLogger
        timeoutMs?: number
    }): Promise<void> {
        const marker =
            input.channel === 'staging'
                ? 'MF_STAGING_CLI_OK'
                : 'MF_STABLE_CLI_OK'
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
        if (result.exitCode !== 0 || !result.stdout.includes(marker)) {
            this.log.warn(
                `failed to install ${input.channel} CLI on ${input.spriteName}: ` +
                    `exit=${result.exitCode} stderr=${result.stderr.slice(0, 256)}`
            )
        }
    }
}
