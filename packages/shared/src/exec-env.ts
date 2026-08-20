// The env and PATH vocabulary an agent process is launched with. These names are
// a cross-tier contract, not local detail: the API injects them at the chat-turn
// dispatch seam, the sprite shell profile re-exports them, and the CLI reads them
// back out of `process.env` to resolve its own runtime identity. Re-typing the
// literals per call site is how a surface silently ends up injecting three of the
// four keys (#581).

export const MF_ENV_API_TOKEN = 'MF_API_TOKEN'
export const MF_ENV_AGENT_ID = 'MF_AGENT_ID'
export const MF_ENV_API_URL = 'MF_API_URL'
export const MF_ENV_DEPLOY_ENV = 'MF_DEPLOY_ENV'

// The per-agent Manyfold runtime identity. A surface either injects all four or
// declares why it injects none; see the exec env surface contract in the API.
export const MF_RUNTIME_IDENTITY_ENV_KEYS = [
    MF_ENV_API_TOKEN,
    MF_ENV_AGENT_ID,
    MF_ENV_API_URL,
    MF_ENV_DEPLOY_ENV
] as const

export type MfRuntimeIdentityEnvKey =
    (typeof MF_RUNTIME_IDENTITY_ENV_KEYS)[number]

// Framework binaries are activated by an atomic symlink here, so this directory
// must win over any image-baked global bin for a managed agent. Shells that skip
// the prepend resolve whatever the image installed instead (#611).
export const HOME_LOCAL_BIN = '$HOME/.local/bin'

export const PATH_PREPEND_LOCAL_BIN = `export PATH="${HOME_LOCAL_BIN}:$PATH"`

// `zz-` is load-bearing, not decoration: /etc/profile sources profile.d in glob
// (alphabetical) order, so a managed fragment named `mf.sh` runs BEFORE the
// image's own node fragment, which then re-prepends its global bin and puts the
// image-baked CLI back in front of the activation dir (#611). Sorting last is
// what makes the prepend authoritative rather than merely present.
const MANAGED_PATH_PROFILE_D_FILE = '/etc/profile.d/zz-manyfold-path.sh'

// Exported because the legacy-residue purge has to recognise the block it must
// NOT touch: the guarded prepend is the one `.local/bin` PATH statement that
// survives a cleanup pass (#650).
export const MANAGED_PATH_BLOCK_START = '# mf-path-start'
export const MANAGED_PATH_BLOCK_END = '# mf-path-end'

// Take the front of PATH only when the activation dir is not already there.
// A blind prepend grows PATH on every re-source (profile.d + rc file + the exec
// wrapper all run it) and asserts nothing about position; what the activation
// contract needs is "first", which is exactly what this states. POSIX `case`
// because /etc/profile.d fragments are also sourced by dash.
const ENSURE_LOCAL_BIN_FIRST = [
    `case "$PATH:" in`,
    `    "${HOME_LOCAL_BIN}:"*) ;;`,
    `    *) PATH="${HOME_LOCAL_BIN}:$PATH" ;;`,
    'esac',
    'export PATH'
].join('\n')

export const MANAGED_PATH_BLOCK = [
    MANAGED_PATH_BLOCK_START,
    ENSURE_LOCAL_BIN_FIRST,
    MANAGED_PATH_BLOCK_END
].join('\n')

// Shell that makes the activation dir authoritative on a sprite for every shape
// of shell it runs, not just the ones a call site remembered to prepend for:
//
//   - login shells (`bash -lc`, the sprite terminal, the sprite-side runner) get
//     it from the last-sorting profile.d fragment;
//   - interactive non-login shells get it from ~/.bashrc;
//   - non-interactive children of a framework CLI inherit it from the parent,
//     whose own PATH now comes from one of the two above.
//
// Best-effort by construction: /etc/profile.d is unwritable on some images and
// this runs inside `set -eu` installers, so every write is `|| true`. Emits no
// per-agent value, which is why an install/upgrade can re-run it without any
// config — that is how already-provisioned sprites get the fix.
export const buildManagedPathScript = (): string =>
    [
        // The block is emitted by a heredoc attached to `cat`, NOT captured into
        // a variable first: `var="$(cat <<'EOF' ...)"` ends the command
        // substitution at the first `)` in the body, which silently mangles the
        // `case` arms into half-expanded garbage.
        'mf_write_path_block() {',
        '  mf_target="$1"',
        '  [ -f "$mf_target" ] || return 0',
        `  sed -i.mf-bak '/${MANAGED_PATH_BLOCK_START}/,/${MANAGED_PATH_BLOCK_END}/d' "$mf_target" 2>/dev/null || true`,
        '  rm -f "$mf_target.mf-bak" 2>/dev/null || true',
        // Separator only when the file does not already end in one: deleting
        // the block above leaves the previous separator behind, so an
        // unconditional printf grows the file by a line on every reconcile.
        `  if [ -n "$(tail -n 1 "$mf_target" 2>/dev/null)" ]; then printf '\\n' >> "$mf_target" 2>/dev/null || true; fi`,
        `  cat >> "$mf_target" <<'MF_PATH_BLOCK_EOF' 2>/dev/null || true`,
        MANAGED_PATH_BLOCK,
        'MF_PATH_BLOCK_EOF',
        '  return 0',
        '}',
        'if [ -w /etc/profile.d ] || mkdir -p /etc/profile.d 2>/dev/null; then',
        `  if : > ${MANAGED_PATH_PROFILE_D_FILE} 2>/dev/null; then`,
        `    mf_write_path_block ${MANAGED_PATH_PROFILE_D_FILE}`,
        `    chmod 0644 ${MANAGED_PATH_PROFILE_D_FILE} 2>/dev/null || true`,
        '  fi',
        'fi',
        'for mf_init in "$HOME/.bashrc" "$HOME/.profile"; do',
        '  touch "$mf_init" 2>/dev/null || true',
        '  mf_write_path_block "$mf_init"',
        'done',
        // bash reads only the FIRST of ~/.bash_profile, ~/.bash_login,
        // ~/.profile on login — so an image that ships ~/.bash_profile makes the
        // ~/.profile write above dead code. Refresh those when they exist, and
        // never create one: creating ~/.bash_profile would itself stop
        // ~/.profile (and whatever the image put there) from being read at all.
        'for mf_init in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.zprofile" "$HOME/.zshrc"; do',
        '  mf_write_path_block "$mf_init"',
        'done'
    ].join('\n')
