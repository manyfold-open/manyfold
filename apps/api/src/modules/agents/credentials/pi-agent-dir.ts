import {
    PI_API_KEY_ENV,
    PI_OUTRANKING_KEY_ENV,
    isOfficialPiBaseUrl,
    piProviderBaseUrl,
    type PiProvider
} from '@manyfold/shared'

// pi reaches a non-official endpoint only through <agent-dir>/models.json
// (`providers.<id>.baseUrl` overrides the built-in provider; every other field
// keeps its built-in value). Null means no override: the file must not exist.
export const buildPiModelsJson = (
    provider: PiProvider,
    baseUrl: string | null | undefined
): string | null => {
    if (!baseUrl || isOfficialPiBaseUrl(provider, baseUrl)) return null
    return `${JSON.stringify(
        {
            providers: {
                [provider]: { baseUrl: piProviderBaseUrl(provider, baseUrl) }
            }
        },
        null,
        2
    )}\n`
}

// Written once, never overwritten: the only setting Manyfold needs is the quiet
// startup banner, and a user who edits the file on the runtime keeps their edits.
export const buildPiSettingsJson = (): string =>
    `${JSON.stringify({ quietStartup: true }, null, 2)}\n`

// A sandbox's or pod's own ~/.pi/agent, as one `bash -lc` body. Nothing a
// credential decides is written here: the key rides each exec and the endpoint
// lives in the platform view (PI_PLATFORM_VIEW_SCRIPT), so this directory is
// what a sign-in on the machine itself would use.
export const piAgentDirSetupScript = (): string =>
    [
        'set -eu',
        'mkdir -p "$HOME/.pi/agent"',
        `[ -f "$HOME/.pi/agent/settings.json" ] || cat > "$HOME/.pi/agent/settings.json" <<'MF_PI_EOF'\n${buildPiSettingsJson()}MF_PI_EOF`
    ].join('\n')

export const PI_PLATFORM_VIEW_ENV = 'MF_PI_VIEW'
export const PI_PLATFORM_MODELS_ENV = 'MF_PI_MODELS_JSON'

/* A pi process running on a platform credential reads its configuration from
   a view of the machine's agent directory, never from the directory itself.

   pi resolves a key as --api-key > <agent-dir>/auth.json > a models.json
   apiKey > the vendor env var, so the machine's own sign-in, or a key its
   models.json names, would win over the key the turn injects — on a daemon
   that is the user's own pi login billing the turn instead of the credential
   they bound. And a gateway endpoint can only reach pi through models.json,
   which on the user's machine is theirs, not ours to rewrite.

   The view (~/.manyfold/pi/<runtime>/agent) links every other entry back to
   the real directory — settings, skills, prompts, themes, trust decisions and
   the session store, so a transcript lands exactly where the session reader
   and a later TUI find it — and holds the two files that decide credentials
   itself: an auth.json that is always empty when pi starts (which also keeps
   pi's startup migration from moving legacy settings.json keys into it), and
   models.json only when the credential names a gateway. It is rebuilt at every
   start, so a sign-in made through it, or an entry the machine no longer has,
   does not survive to the next exec. Starts of the same runtime rebuild it
   one at a time (a mkdir lock beside the view; one left by a start killed
   mid-rebuild is taken over after about five seconds, the rebuild itself
   being milliseconds); a link is never made through one already there, which
   would write into the machine's own directory; and pi's own lock files are
   never touched, since a live pi holds them.

   `bash -c <script> pi <args…>`: $0 is pi, "$@" its arguments, and `exec`
   keeps the process, its signals, stdin and exit code exactly what running pi
   directly gave. */
export const PI_PLATFORM_VIEW_SCRIPT = `set -u
[ -n "\${HOME:-}" ] || { echo 'pi platform view: HOME is not set' >&2; exit 64; }
case "\${MF_PI_VIEW:-}" in
    ''|*[!A-Za-z0-9_-]*) echo 'pi platform view: invalid view id' >&2; exit 64 ;;
esac
native="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
case "$native" in
    '~') native="$HOME" ;;
    '~/'*) native="$HOME/\${native#'~/'}" ;;
esac
own="$HOME/.manyfold/pi/$MF_PI_VIEW"
view="$own/agent"
mkdir -p "$native/sessions" "$view" || exit 70
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
        auth.json|oauth.json|models.json|*.lock) continue ;;
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
        auth.json|models.json|*.lock) continue ;;
    esac
    [ -L "$link" ] && { [ -e "$native/$name" ] || [ -L "$native/$name" ]; } && continue
    rm -rf "$link"
done
if [ "$(cat "$view/auth.json" 2>/dev/null)" != '{}' ]; then
    printf '{}' > "$own/auth.json.$$" && chmod 600 "$own/auth.json.$$" &&
        mv -f "$own/auth.json.$$" "$view/auth.json" || fail
fi
if [ -n "\${MF_PI_MODELS_JSON:-}" ]; then
    printf '%s' "$MF_PI_MODELS_JSON" > "$own/models.json.$$" &&
        mv -f "$own/models.json.$$" "$view/models.json" || fail
else
    rm -f "$view/models.json"
fi
rmdir "$own/rebuild.lock" 2>/dev/null
unset MF_PI_VIEW MF_PI_MODELS_JSON
export PI_CODING_AGENT_DIR="$view"
exec pi "$@"
`

// The argv and env that run `pi <args…>` on a platform credential: against
// this runtime's platform view, with the key in the vendor's env var and the
// variables pi would read ahead of it blanked (PI_OUTRANKING_KEY_ENV) — the
// daemon hands every exec the environment it was started with. PI_OFFLINE
// keeps the process off pi.dev (update check, telemetry). The one place a chat
// turn and a resumed TUI get this from, so the two cannot disagree about which
// account a session bills.
export const piPlatformExec = (args: {
    piArgs: string[]
    runtimeId: string
    provider: PiProvider
    apiKey: string
    baseUrl?: string | null
}): { cmd: string[]; env: Record<string, string> } => {
    const modelsJson = buildPiModelsJson(args.provider, args.baseUrl)
    const env: Record<string, string> = {
        PI_OFFLINE: '1',
        [PI_PLATFORM_VIEW_ENV]: args.runtimeId,
        ...(modelsJson ? { [PI_PLATFORM_MODELS_ENV]: modelsJson } : {})
    }
    for (const outranking of PI_OUTRANKING_KEY_ENV[args.provider])
        env[outranking] = ''
    env[PI_API_KEY_ENV[args.provider]] = args.apiKey
    return {
        cmd: ['bash', '-c', PI_PLATFORM_VIEW_SCRIPT, 'pi', ...args.piArgs],
        env
    }
}
