import {
    AGY_MANAGED_HOST_ENV,
    AGY_PLATFORM_OUTRANKING_ENV,
    OFFICIAL_PROVIDER_BASE_URL
} from '@manyfold/shared'

export const AGY_PLATFORM_VIEW_ENV = 'MF_AGY_VIEW'
const AGY_PLATFORM_VIEW_PREPARE_ENV = 'MF_AGY_VIEW_PREPARE'

/* An agy process running on a platform credential reads its settings from a
   view of the machine's app data dir, never from the dir itself.

   agy takes a key only in its API-key mode, and only settings.json turns that
   mode on (`"modelProvider":"gemini"`); with the provider named and no key it
   refuses to start. Written into the machine's own settings it would break
   the user's own sign-in there, and every runtime-local agent sharing the
   host. So the key rides each exec, and the one file that decides the mode
   lives in a view (~/.manyfold/antigravity-cli/<runtime>/app) that agy is
   pointed at with `--app_data_dir` — measured on agy 1.2.11 [2026-09-26]: the
   env names its binary carries for this (ANTIGRAVITY_APP_DATA_DIR, the XDG
   dirs) are not read, and a flag it stops defining makes it exit 2, so a
   view it ignores cannot quietly bill the machine's own account.

   The view links every other entry back to the machine's dir — the
   transcripts under brain/, the conversation databases, the per-cwd cache —
   so a conversation lands exactly where the session reader and a later TUI
   find it, and one begun on either side resumes on the other. A sign-in token
   (`*-oauth-token`) is the exception: the view never holds one, so a platform
   exec cannot reach the machine's Google account whatever agy prefers —
   measured on agy 1.2.11 [2026-09-26], API-key mode used the key even with
   the machine's token beside it, but that is agy's choice to change. Those
   directories are created first so their links exist before agy writes;
   files agy creates in the view itself (a summaries cache) are dropped at
   the next rebuild. ~/.gemini/config (hooks, MCP servers, skills) is shared
   by agy either way. The rebuild is serialized per runtime by a mkdir lock
   beside the view, taken over after about five seconds.

   agy's TUI asks before it works in a folder, --dangerously-skip-permissions
   or not, and records the answer in settings.json, which the view rewrites
   at every start (measured on agy 1.2.11 [2026-09-26]). So the view's
   settings name the folder agy runs in as trusted, as a user would answer
   for their agent's workspace; a path that is not plain printable text is
   left to the prompt.

   `bash -c <script> agy <args…>`: $0 is agy, "$@" its arguments, and `exec`
   keeps the process, its signals, stdin and exit code exactly what running
   agy directly gave. */
export const AGY_PLATFORM_VIEW_SCRIPT = `set -u
[ -n "\${HOME:-}" ] || { echo 'agy platform view: HOME is not set' >&2; exit 64; }
case "\${MF_AGY_VIEW:-}" in
    ''|*[!A-Za-z0-9_-]*) echo 'agy platform view: invalid view id' >&2; exit 64 ;;
esac
native="$HOME/.gemini/antigravity-cli"
own="$HOME/.manyfold/antigravity-cli/$MF_AGY_VIEW"
view="$own/app"
for dir in brain conversations cache annotations presence implicit log; do
    mkdir -p "$native/$dir" || exit 70
done
mkdir -p "$view" || exit 70
chmod 700 "$own" 2>/dev/null
fail() { rmdir "$own/rebuild.lock" 2>/dev/null; exit 70; }
tries=0
until mkdir "$own/rebuild.lock" 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -lt 100 ] || break
    sleep 0.05
done
for entry in "$native"/* "$native"/.[!.]* "$native"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name="\${entry##*/}"
    case "$name" in
        settings.json|*.lock|*-oauth-token) continue ;;
    esac
    link="$view/$name"
    if [ -e "$link" ] || [ -L "$link" ]; then
        [ -L "$link" ] && [ "$(readlink "$link")" = "$entry" ] && continue
        rm -rf "$link"
    fi
    ln -sn "$entry" "$link" 2>/dev/null ||
        { [ -L "$link" ] && [ "$(readlink "$link")" = "$entry" ]; } || fail
done
for link in "$view"/* "$view"/.[!.]* "$view"/..?*; do
    [ -e "$link" ] || [ -L "$link" ] || continue
    name="\${link##*/}"
    case "$name" in
        settings.json|*.lock) continue ;;
        *-oauth-token) rm -rf "$link"; continue ;;
    esac
    [ -L "$link" ] && { [ -e "$native/$name" ] || [ -L "$native/$name" ]; } && continue
    rm -rf "$link"
done
want='{"modelProvider":"gemini"}'
case "$PWD" in
    *[![:print:]]*) ;;
    /*) want='{"modelProvider":"gemini","trustedWorkspaces":["'"$(printf '%s' "$PWD" | sed 's/[\\\\"]/\\\\&/g')"'"]}' ;;
esac
if [ -L "$view/settings.json" ] || [ "$(cat "$view/settings.json" 2>/dev/null)" != "$want" ]; then
    printf '%s' "$want" > "$own/settings.json.$$" &&
        mv -f "$own/settings.json.$$" "$view/settings.json" || fail
fi
rmdir "$own/rebuild.lock" 2>/dev/null
# relative to agy's ~/.gemini (an absolute one is refused)
arg="--app_data_dir=../.manyfold/antigravity-cli/$MF_AGY_VIEW/app"
unset MF_AGY_VIEW
[ -z "\${MF_AGY_VIEW_PREPARE:-}" ] || { printf '%s\\n' "$arg"; exit 0; }
exec agy "$arg" "$@"
`

// The argv and env that run `agy <args…>` on a platform credential: against
// this runtime's platform view, with the key in GEMINI_API_KEY, the endpoint
// in GOOGLE_GEMINI_BASE_URL (agy appends the API version itself, as Gemini
// CLI does), and the variables that could steer it elsewhere blanked — the
// daemon hands every exec the environment it was started with. The one place
// a chat turn and a resumed TUI get this from, so the two cannot disagree
// about which account a session bills.
export const antigravityPlatformExec = (args: {
    agyArgs: string[]
    runtimeId: string
    apiKey: string
    baseUrl?: string | null
    managedHost: boolean
}): { cmd: string[]; env: Record<string, string> } => {
    const env: Record<string, string> = {
        ...(args.managedHost ? AGY_MANAGED_HOST_ENV : {}),
        [AGY_PLATFORM_VIEW_ENV]: args.runtimeId
    }
    for (const outranking of AGY_PLATFORM_OUTRANKING_ENV) env[outranking] = ''
    env.GEMINI_API_KEY = args.apiKey
    env.GOOGLE_GEMINI_BASE_URL =
        args.baseUrl?.trim() || OFFICIAL_PROVIDER_BASE_URL.google
    return {
        cmd: ['bash', '-c', AGY_PLATFORM_VIEW_SCRIPT, 'agy', ...args.agyArgs],
        env
    }
}

// herdr starts agy itself — its `agy` agent kind runs the binary by name — so
// the view cannot wrap it as it wraps a turn or a browser TUI. The same script
// builds the view first and, asked to prepare only, prints the flag that
// points agy at it; herdr's agy then gets that flag and the resume's env. It
// runs in the folder herdr starts agy in, the one the view's settings trust.
export const antigravityPlatformViewPrepare = (
    env: Record<string, string>
): { cmd: string[]; env: Record<string, string> } => ({
    cmd: ['bash', '-c', AGY_PLATFORM_VIEW_SCRIPT, 'agy'],
    env: {
        [AGY_PLATFORM_VIEW_ENV]: env[AGY_PLATFORM_VIEW_ENV] ?? '',
        [AGY_PLATFORM_VIEW_PREPARE_ENV]: '1'
    }
})

// herdr's agy on the view: the flag the prepare step printed ahead of the
// resume's own arguments, under the resume's env without the view marker.
export const antigravityPlatformDirect = (
    resume: { command: string[]; env: Record<string, string> },
    appDataDirFlag: string
): { command: string[]; env: Record<string, string> } => {
    const env: Record<string, string> = { ...resume.env }
    delete env[AGY_PLATFORM_VIEW_ENV]
    // antigravityPlatformExec's argv: bash -c <script> agy <agy args…>
    return {
        command: ['agy', appDataDirFlag, ...resume.command.slice(4)],
        env
    }
}
