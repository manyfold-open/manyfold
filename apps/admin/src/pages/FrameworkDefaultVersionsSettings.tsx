import { frameworkRepoCandidates } from '@manyfold/shared'
import type {
    AgentFramework,
    FrameworkDefaultVersionsSettings
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Button, Card, Heading } from '@/ui'

const FRAMEWORKS: { key: AgentFramework; label: string }[] = [
    { key: 'claude-code', label: 'Claude Code' },
    { key: 'codex', label: 'Codex' },
    { key: 'gemini-cli', label: 'Gemini CLI' },
    { key: 'openclaw', label: 'OpenClaw' },
    { key: 'narranexus', label: 'NarraNexus' },
    { key: 'hermes', label: 'Hermes' }
]

// Only frameworks published to more than one repository get a picker; a
// single-candidate framework has nothing to choose, and one whose installer
// clones a repo of its own choosing must not appear to offer one.
const SOURCE_FRAMEWORKS = FRAMEWORKS.filter(
    ({ key }) => frameworkRepoCandidates(key).length > 1
)

const FrameworkDefaultVersionsSettingsPage: FC = (): ReactNode => {
    const client = useApiClient()
    const [draft, setDraft] = useState<Partial<Record<AgentFramework, string>>>(
        {}
    )
    const [minDraft, setMinDraft] = useState<
        Partial<Record<AgentFramework, string>>
    >({})
    const [downgradeDraft, setDowngradeDraft] = useState<
        Partial<Record<AgentFramework, boolean>>
    >({})
    const [prereleaseDraft, setPrereleaseDraft] = useState<
        Partial<Record<AgentFramework, boolean>>
    >({})
    const [savedPrerelease, setSavedPrerelease] = useState<
        Partial<Record<AgentFramework, boolean>>
    >({})
    const [sourceDraft, setSourceDraft] = useState<
        Partial<Record<AgentFramework, string>>
    >({})
    const [savedSources, setSavedSources] = useState<
        Partial<Record<AgentFramework, string>>
    >({})
    const [versions, setVersions] = useState<
        Partial<Record<AgentFramework, string[]>>
    >({})
    const [loaded, setLoaded] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const applySettings = (
        settings: FrameworkDefaultVersionsSettings
    ): void => {
        const nextDefault: Partial<Record<AgentFramework, string>> = {}
        const nextMin: Partial<Record<AgentFramework, string>> = {}
        const nextDowngrade: Partial<Record<AgentFramework, boolean>> = {}
        const nextPrerelease: Partial<Record<AgentFramework, boolean>> = {}
        const nextSource: Partial<Record<AgentFramework, string>> = {}
        for (const { key } of FRAMEWORKS) {
            nextDefault[key] = settings.defaults[key] ?? ''
            nextMin[key] = settings.minVersions[key] ?? ''
            nextDowngrade[key] = settings.allowDowngrade[key] !== false
            nextPrerelease[key] = settings.allowPrerelease[key] === true
        }
        for (const { key } of SOURCE_FRAMEWORKS)
            nextSource[key] =
                settings.sourceRepos[key] ?? frameworkRepoCandidates(key)[0].repo
        setDraft(nextDefault)
        setMinDraft(nextMin)
        setDowngradeDraft(nextDowngrade)
        setPrereleaseDraft(nextPrerelease)
        setSavedPrerelease(nextPrerelease)
        setSourceDraft(nextSource)
        setSavedSources(nextSource)
    }

    const load = useCallback((): void => {
        setError(null)
        Promise.all([
            client.admin.settings.getFrameworkDefaultVersions(),
            client.frameworkVersions.list()
        ])
            .then(([settings, catalog]) => {
                applySettings(settings)
                const byFramework: Partial<Record<AgentFramework, string[]>> = {}
                for (const entry of catalog)
                    byFramework[entry.framework] = entry.versions
                setVersions(byFramework)
                setLoaded(true)
            })
            .catch((err: Error) => setError(err.message))
    }, [client])

    useEffect(load, [load])

    const save = async (): Promise<void> => {
        setBusy(true)
        setError(null)
        setStatus(null)
        const defaults: Partial<Record<AgentFramework, string>> = {}
        const minVersions: Partial<Record<AgentFramework, string>> = {}
        const allowDowngrade: Partial<Record<AgentFramework, boolean>> = {}
        const allowPrerelease: Partial<Record<AgentFramework, boolean>> = {}
        const sourceRepos: Partial<Record<AgentFramework, string>> = {}
        for (const { key } of FRAMEWORKS) {
            const v = draft[key]
            if (v) defaults[key] = v
            const min = minDraft[key]
            if (min) minVersions[key] = min
            allowDowngrade[key] = downgradeDraft[key] !== false
            allowPrerelease[key] = prereleaseDraft[key] === true
        }
        for (const { key } of SOURCE_FRAMEWORKS) {
            const repo = sourceDraft[key]
            if (repo) sourceRepos[key] = repo
        }
        const sourceChanged = SOURCE_FRAMEWORKS.some(
            ({ key }) => sourceDraft[key] !== savedSources[key]
        )
        const prereleaseChanged = FRAMEWORKS.some(
            ({ key }) => prereleaseDraft[key] !== savedPrerelease[key]
        )
        try {
            const settings =
                await client.admin.settings.updateFrameworkDefaultVersions({
                    defaults,
                    minVersions,
                    allowDowngrade,
                    allowPrerelease,
                    sourceRepos
                })
            applySettings(settings)
            // The catalog serves nothing for a framework whose stored tags came
            // from the repository we just moved off, so without this the version
            // dropdowns would silently empty and look like the pins were lost.
            // Enabling pre-releases needs the same re-fetch for a different
            // reason: a catalog row written before the opt-in existed has no
            // pre-release list at all, so the dropdowns would look unchanged.
            if (sourceChanged || prereleaseChanged) {
                setStatus('Saved. Fetching versions from the new repository…')
                try {
                    await client.admin.frameworkVersions.refresh()
                    setStatus('Saved. Version list refreshed.')
                } catch {
                    setStatus(
                        'Saved, but the version list could not be refreshed. Use "Refresh versions" on the Models tab.'
                    )
                }
                load()
                return
            }
            setStatus('Saved')
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className='mx-auto max-w-3xl'>
            <div className='mb-3'>
                <Heading level={2} className='mb-2'>
                    Framework default versions
                </Heading>
                <p className='admin-page-description'>
                    Pin the version each framework installs when a new agent is
                    provisioned (sprite runtime), set the minimum supported
                    version, and choose whether users may downgrade. Leave a row
                    at "Default" and new agents install the newest release from
                    the catalog — pin one only to hold a framework back. The
                    minimum version is a floor the upgrade flow enforces for
                    everyone, and a pinned default must sit at or above it.
                    Turning off "Allow downgrade" stops users from moving below
                    their installed version; admins stay exempt. Turning on
                    "Allow pre-release" adds that framework&apos;s semver
                    pre-releases (1.2.3-rc.1, -test.2, -dev) to every picker and
                    lets them be pinned; "Default" still resolves to the newest
                    stable release, so reaching a pre-release is always
                    deliberate. Versions come from the catalog, fetched from each
                    framework&apos;s version source; refresh it on the Framework
                    Model Catalog page if a row is empty.
                </p>
            </div>

            {error && (
                <Card
                    elevation='flat'
                    className='border-accent-ruby/30 bg-accent-ruby/5 mb-2 p-2'
                >
                    <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                        {error}
                    </pre>
                </Card>
            )}

            {!loaded && !error && (
                <p className='text-caption text-body'>Loading…</p>
            )}

            {loaded && SOURCE_FRAMEWORKS.length > 0 && (
                <Card elevation='ambient' className='mb-2 p-3'>
                    <Heading level={3} className='mb-1'>
                        Version source
                    </Heading>
                    <p className='admin-page-description mb-2'>
                        Choose which repository a framework&apos;s versions come
                        from. The same repository drives the version list below
                        and the checkout performed at install and upgrade, so
                        the two can never disagree. Different repositories
                        publish different sets of tags, so switching changes
                        which versions exist — not just where they are fetched
                        from. Saving a change re-fetches the version list. Only
                        repositories on the platform&apos;s allowlist can be
                        selected.
                    </p>
                    <div className='space-y-2'>
                        {SOURCE_FRAMEWORKS.map(({ key, label }) => {
                            const candidates = frameworkRepoCandidates(key)
                            const selected = candidates.find(
                                (c) => c.repo === sourceDraft[key]
                            )
                            return (
                                <div key={key}>
                                    <div className='flex items-center gap-3'>
                                        <label
                                            htmlFor={`fwsource-${key}`}
                                            className='text-body min-w-[140px]'
                                        >
                                            {label}
                                        </label>
                                        <select
                                            id={`fwsource-${key}`}
                                            className='border-divider bg-canvas text-body flex-1 rounded border px-2 py-1 font-mono'
                                            value={sourceDraft[key] ?? ''}
                                            onChange={(e) =>
                                                setSourceDraft((d) => ({
                                                    ...d,
                                                    [key]: e.target.value
                                                }))
                                            }
                                        >
                                            {candidates.map((c) => (
                                                <option
                                                    key={c.repo}
                                                    value={c.repo}
                                                >
                                                    {c.repo}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    {selected?.note && (
                                        <p className='text-caption-sm text-body ml-[152px] opacity-70'>
                                            {selected.note}
                                        </p>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                </Card>
            )}

            {loaded && (
                <Card elevation='ambient' className='p-3'>
                    <div className='space-y-2'>
                        <div className='text-caption-sm text-body flex items-center gap-3 px-1 opacity-70'>
                            <span className='min-w-[140px]'>Framework</span>
                            <span className='flex-1'>Default version</span>
                            <span className='flex-1'>Minimum version</span>
                            <span className='w-[120px] text-center'>
                                Allow downgrade
                            </span>
                            <span className='w-[120px] text-center'>
                                Allow pre-release
                            </span>
                        </div>
                        {FRAMEWORKS.map(({ key, label }) => (
                            <div key={key} className='flex items-center gap-3'>
                                <label
                                    htmlFor={`fwversion-${key}`}
                                    className='text-body min-w-[140px]'
                                >
                                    {label}
                                </label>
                                <select
                                    id={`fwversion-${key}`}
                                    className='border-divider bg-canvas text-body flex-1 rounded border px-2 py-1 font-mono'
                                    value={draft[key] ?? ''}
                                    onChange={(e) =>
                                        setDraft((d) => ({
                                            ...d,
                                            [key]: e.target.value
                                        }))
                                    }
                                >
                                    <option value=''>Default (latest)</option>
                                    {/* A pin the current repository does not
                                    carry stays selectable rather than being
                                    silently dropped — losing an operator's pin
                                    as a side effect of changing the source
                                    would be worse than showing it unavailable. */}
                                    {draft[key] &&
                                        !(versions[key] ?? []).includes(
                                            draft[key]
                                        ) && (
                                            <option value={draft[key]}>
                                                {draft[key]} (not in this
                                                repository)
                                            </option>
                                        )}
                                    {(versions[key] ?? []).map((v) => (
                                        <option key={v} value={v}>
                                            {v}
                                        </option>
                                    ))}
                                </select>
                                <select
                                    id={`fwmin-${key}`}
                                    aria-label={`${label} minimum version`}
                                    className='border-divider bg-canvas text-body flex-1 rounded border px-2 py-1 font-mono'
                                    value={minDraft[key] ?? ''}
                                    onChange={(e) =>
                                        setMinDraft((d) => ({
                                            ...d,
                                            [key]: e.target.value
                                        }))
                                    }
                                >
                                    <option value=''>No minimum</option>
                                    {(versions[key] ?? []).map((v) => (
                                        <option key={v} value={v}>
                                            {v}
                                        </option>
                                    ))}
                                </select>
                                <div className='flex w-[120px] justify-center'>
                                    <input
                                        type='checkbox'
                                        aria-label={`${label} allow downgrade`}
                                        checked={downgradeDraft[key] !== false}
                                        onChange={(e) =>
                                            setDowngradeDraft((d) => ({
                                                ...d,
                                                [key]: e.target.checked
                                            }))
                                        }
                                    />
                                </div>
                                <div className='flex w-[120px] justify-center'>
                                    <input
                                        type='checkbox'
                                        aria-label={`${label} allow pre-release`}
                                        checked={prereleaseDraft[key] === true}
                                        onChange={(e) =>
                                            setPrereleaseDraft((d) => ({
                                                ...d,
                                                [key]: e.target.checked
                                            }))
                                        }
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className='mt-3 flex items-center justify-end gap-2'>
                        {status && (
                            <span className='text-caption-sm text-brand'>
                                {status}
                            </span>
                        )}
                        <Button variant='ghost' onClick={load} disabled={busy}>
                            Reset
                        </Button>
                        <Button
                            variant='primary'
                            disabled={busy}
                            onClick={() => void save()}
                        >
                            Save
                        </Button>
                    </div>
                </Card>
            )}
        </div>
    )
}

export default FrameworkDefaultVersionsSettingsPage
