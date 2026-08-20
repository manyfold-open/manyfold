// Shell-side file-root containment (ADR-0013). The API already rejects paths
// that escape a root lexically, but every remote transport follows symlinks, so a
// symlink planted inside a root used to reach outside it. This prelude resolves
// the target in the same command that acts on it, which is as tight as a remote
// shell allows — the residual race (the agent owns the filesystem and can swap a
// path component mid-command) is accepted and recorded in the ADR.

export const CONTAINMENT_EXIT_CODE = 77

const shellEscape = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`

// Resolves the root too: a root that itself sits behind a symlink (a daemon home
// under /var on macOS, for instance) would otherwise make every child look like
// an escape.
export const containmentPrelude = (
    rootPath: string,
    targets: string[]
): string => {
    const qRoot = shellEscape(rootPath)
    const checks = targets.map((t) => `__mf_check ${shellEscape(t)}`).join('\n')
    return [
        `__mf_root=$(readlink -f -- ${qRoot} 2>/dev/null || printf %s ${qRoot})`,
        '__mf_check() {',
        '  __mf_p="$1"',
        '  __mf_r=$(readlink -f -- "$__mf_p" 2>/dev/null || true)',
        // a path that does not exist yet is fine as long as its parent resolves
        // inside the root, which is what a fresh upload looks like
        '  if [ -z "$__mf_r" ]; then',
        '    __mf_r=$(readlink -f -- "$(dirname -- "$__mf_p")" 2>/dev/null || true)',
        '  fi',
        // nothing resolvable (a brand new nested path): the lexical check the API
        // already ran is all we have
        '  [ -n "$__mf_r" ] || return 0',
        '  case "$__mf_r" in',
        '    "$__mf_root"|"$__mf_root"/*) return 0 ;;',
        '  esac',
        '  printf "mf: path escapes file root: %s\\n" "$__mf_p" >&2',
        `  exit ${CONTAINMENT_EXIT_CODE}`,
        '}',
        checks
    ].join('\n')
}

export const isContainmentExit = (exitCode: number): boolean =>
    exitCode === CONTAINMENT_EXIT_CODE
