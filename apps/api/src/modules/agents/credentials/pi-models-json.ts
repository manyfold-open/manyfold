import { isOfficialPiBaseUrl, type PiProvider } from '@manyfold/shared'

// pi reaches a non-official endpoint only through ~/.pi/agent/models.json
// (`providers.<id>.baseUrl` overrides the built-in provider; every other field
// keeps its built-in value). Null means the file must NOT exist: a stale
// override left behind after switching back to the vendor endpoint would keep
// routing every turn through the old gateway.
export const buildPiModelsJson = (
    provider: PiProvider,
    baseUrl: string | null | undefined
): string | null => {
    if (isOfficialPiBaseUrl(provider, baseUrl)) return null
    return `${JSON.stringify(
        { providers: { [provider]: { baseUrl: baseUrl!.trim() } } },
        null,
        2
    )}\n`
}

// Written once, never overwritten: the only setting Manyfold needs is the quiet
// startup banner, and a user who edits the file on the runtime keeps their edits.
export const buildPiSettingsJson = (): string =>
    `${JSON.stringify({ quietStartup: true }, null, 2)}\n`

// The whole `~/.pi/agent` reconcile as one `bash -lc` body: the config dir,
// the settings file if absent, and the models.json override written or
// removed. Shared by the sprite bootstrap and the credential re-apply so the
// two can never disagree about what lives on disk.
export const piAgentDirReconcileScript = (
    provider: PiProvider,
    baseUrl: string | null | undefined
): string => {
    const modelsJson = buildPiModelsJson(provider, baseUrl)
    return [
        'set -eu',
        'mkdir -p "$HOME/.pi/agent"',
        `[ -f "$HOME/.pi/agent/settings.json" ] || cat > "$HOME/.pi/agent/settings.json" <<'MF_PI_EOF'\n${buildPiSettingsJson()}MF_PI_EOF`,
        modelsJson
            ? `cat > "$HOME/.pi/agent/models.json" <<'MF_PI_EOF'\n${modelsJson}MF_PI_EOF`
            : 'rm -f "$HOME/.pi/agent/models.json"'
    ].join('\n')
}
