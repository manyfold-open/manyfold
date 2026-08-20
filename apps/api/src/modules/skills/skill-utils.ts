import {
    LIBRARY_SKILL_CONTENT_FILENAME,
    validateLibraryFilePath
} from '@manyfold/shared'
import { createHash } from 'node:crypto'

export const DEFAULT_SKILL_FRAMEWORK = 'claude-code' as const
export const SKILL_FRAMEWORKS = [
    'claude-code',
    'codex',
    'gemini-cli',
    'hermes'
] as const

export type SupportedSkillFramework = (typeof SKILL_FRAMEWORKS)[number]

export const assertSkillFramework = (
    value: string
): SupportedSkillFramework => {
    if ((SKILL_FRAMEWORKS as readonly string[]).includes(value))
        return value as SupportedSkillFramework
    throw new Error(`invalid skills framework: ${value}`)
}

export const skillStateDirName = (
    framework: SupportedSkillFramework
): string => {
    switch (framework) {
        case 'claude-code':
            return 'claude'
        case 'codex':
        case 'gemini-cli':
            // Codex and Gemini CLI both discover skills from the cross-tool
            // `.agents/skills` convention (`$HOME/.agents/skills`), not their
            // own `~/.codex` / `~/.gemini` dirs — materialize into `.agents`
            // so installed skills actually load.
            return 'agents'
        case 'hermes':
            return 'hermes'
    }
}

// The platform's own first-party skills repo, published from this monorepo
// (apps/cli/src/agent-help via `build:skills`). Always a builtin source — see
// SkillDiscoveryService.builtinRepos — and the home of the default-installed
// manyfold-cli-usage skill.
export const PLATFORM_SKILL_REPO = {
    id: 'builtin:protagolabs/manyfold-skills@main',
    owner: 'protagolabs',
    name: 'manyfold-skills',
    branch: 'main'
} as const

// Skill ids auto-installed on every new agent by default (admin-overridable via
// the `default_agent_skills` setting). One merged skill covering platform
// operations + A2A, published under skills/ in the first-party repo. The single
// source of truth lives in @manyfold/shared so the web app can consume it too.
export { PLATFORM_DEFAULT_SKILL_IDS } from '@manyfold/shared'

export const DEFAULT_SKILL_REPOS = [
    PLATFORM_SKILL_REPO,
    {
        id: 'builtin:anthropics/skills@main',
        owner: 'anthropics',
        name: 'skills',
        branch: 'main'
    },
    {
        id: 'builtin:ComposioHQ/awesome-claude-skills@master',
        owner: 'ComposioHQ',
        name: 'awesome-claude-skills',
        branch: 'master'
    },
    {
        id: 'builtin:cexll/myclaude@master',
        owner: 'cexll',
        name: 'myclaude',
        branch: 'master'
    },
    {
        id: 'builtin:JimLiu/baoyu-skills@main',
        owner: 'JimLiu',
        name: 'baoyu-skills',
        branch: 'main'
    },
    {
        id: 'builtin:NousResearch/hermes-agent@main',
        owner: 'NousResearch',
        name: 'hermes-agent',
        branch: 'main'
    }
] as const

const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/
const PATH_RE = /^\.|[A-Za-z0-9._/-]{1,512}$/
const INSTALL_DIR_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

export const assertSafeGitHubOwner = (value: string): string => {
    const v = value.trim()
    if (!OWNER_RE.test(v)) throw new Error(`invalid GitHub owner: ${value}`)
    return v
}

export const assertSafeGitHubRepo = (value: string): string => {
    const v = value.trim()
    if (!REPO_RE.test(v)) throw new Error(`invalid GitHub repo: ${value}`)
    return v
}

export const assertSafeGitRef = (value: string): string => {
    const v = value.trim()
    if (!BRANCH_RE.test(v) || v.includes('..') || v.startsWith('/'))
        throw new Error(`invalid Git ref: ${value}`)
    return v
}

export const assertSafeSourcePath = (value: string): string => {
    const v = value.trim() || '.'
    if (!PATH_RE.test(v) || v.includes('..') || v.startsWith('/'))
        throw new Error(`invalid skill source path: ${value}`)
    return v.replace(/\/+$/g, '') || '.'
}

export const assertSafeInstallDir = (value: string): string => {
    const v = value.trim()
    if (!INSTALL_DIR_RE.test(v) || v.includes('..'))
        throw new Error(`invalid skill install dir: ${value}`)
    return v
}

export const skillIdFor = (input: {
    owner: string
    repo: string
    branch: string
    sourcePath: string
}): string =>
    `github:${assertSafeGitHubOwner(input.owner)}/${assertSafeGitHubRepo(
        input.repo
    )}@${assertSafeGitRef(input.branch)}:${assertSafeSourcePath(
        input.sourcePath
    )}`

export const parseSkillId = (
    skillId: string
): { owner: string; repo: string; branch: string; sourcePath: string } => {
    const match = skillId.match(/^github:([^/]+)\/([^@]+)@([^:]+):(.+)$/)
    if (!match) throw new Error(`invalid skill id: ${skillId}`)
    return {
        owner: assertSafeGitHubOwner(match[1]),
        repo: assertSafeGitHubRepo(match[2]),
        branch: assertSafeGitRef(match[3]),
        sourcePath: assertSafeSourcePath(match[4])
    }
}

// Library (platform-owned content) skills: SKILL.md is the primary content
// column, so a supporting file may never claim that name — the materializer
// writes the primary content to SKILL.md itself. Limits and path rules live in
// @manyfold/shared so the web editor validates with the same source of truth.
export {
    LIBRARY_SKILL_CONTENT_FILENAME as SKILL_CONTENT_FILENAME,
    MAX_LIBRARY_SKILL_FILE_BYTES,
    MAX_LIBRARY_SKILL_TOTAL_BYTES,
    MAX_LIBRARY_SKILL_FILE_COUNT
} from '@manyfold/shared'
export const MAX_LIBRARY_SKILL_ARCHIVE_BYTES = 16 * 1024 * 1024

export const assertSafeLibraryFilePath = (value: string): string => {
    const result = validateLibraryFilePath(value)
    if (result.valid) return result.value
    if (result.code === 'reserved')
        throw new Error(
            `${LIBRARY_SKILL_CONTENT_FILENAME} is reserved for the primary skill content`
        )
    throw new Error(`invalid skill file path: ${value}`)
}

export const installDirBase = (value: string): string => {
    const normalized = value
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
    return normalized || 'skill'
}

export const deterministicSuffix = (value: string, length = 8): string =>
    createHash('sha256').update(value).digest('hex').slice(0, length)

export const installDirWithSuffix = (
    base: string,
    seed: string,
    suffixLength = 8
): string => {
    const suffix = deterministicSuffix(seed, suffixLength)
    const prefix = base.slice(0, Math.max(1, 63 - suffix.length - 1))
    return assertSafeInstallDir(`${prefix}-${suffix}`)
}

// Frameworks whose sprite/daemon skills materialize via the host store +
// per-agent workspace activation (claude-code/codex/gemini-cli). Hermes is
// k8s-profile-scoped and stays on the legacy home-clone path.
export const STORE_ACTIVATION_FRAMEWORKS = [
    'claude-code',
    'codex',
    'gemini-cli'
] as const

export type StoreActivationFramework =
    (typeof STORE_ACTIVATION_FRAMEWORKS)[number]

export const isStoreActivationFramework = (
    framework: string
): framework is StoreActivationFramework =>
    (STORE_ACTIVATION_FRAMEWORKS as readonly string[]).includes(framework)

// The host-level canonical store dir (one copy per host, deduped across all
// agents on it), beside `${home}/.manyfold/workspaces`.
export const skillStoreDir = (homeDir: string): string =>
    `${homeDir}/.manyfold/skills`

// Identity+revision-keyed store dir name. installDirBase(skillId) gives a
// greppable prefix; the 16-hex digest of identity@revision makes updates
// copy-on-write (a new revision → a new key → a fresh download). Budgeted so
// the whole key passes assertSafeInstallDir's 64-char cap.
export const skillStoreKey = (input: {
    skillId: string
    repoOwner: string
    repoName: string
    repoBranch: string
    sourcePath: string
    revision: string
}): string => {
    const seed = `${input.repoOwner}/${input.repoName}@${input.repoBranch}:${input.sourcePath}@${input.revision}`
    return installDirWithSuffix(installDirBase(input.skillId), seed, 16)
}

// Library-skill counterpart of skillStoreKey: same single-segment shape, keyed
// on the library row id + content hash so every content edit is copy-on-write.
export const libraryStoreKey = (input: {
    name: string
    librarySkillId: string
    contentHash: string
}): string =>
    installDirWithSuffix(
        installDirBase(input.name),
        `library:${input.librarySkillId}@${input.contentHash}`,
        16
    )

// Where the agent's per-agent activation entries live inside its workspace.
// claude-code discovers `<cwd>/.claude/skills`; codex/gemini discover the
// cross-tool `.agents/skills` (codex via USER scope under HOME=<workspace>).
export const skillActivationSubdir = (
    framework: StoreActivationFramework
): string => (framework === 'claude-code' ? '.claude/skills' : '.agents/skills')

// claude-code & gemini-cli follow symlinks into the store; codex ignores a
// symlinked skills dir (openai/codex#11314), so it gets real-dir copies.
export const skillActivationMode = (
    framework: StoreActivationFramework
): 'symlink' | 'copy' => (framework === 'codex' ? 'copy' : 'symlink')

// Only platform-managed workspace dirs get activation symlinks/copies — never
// a user-supplied custom workspace (writing `.claude/skills` into the user's
// own repo would surface in their git status). Managed shapes:
// `~/.{manyfold,nca}/workspaces/<agentId>` (sandbox hosts, legacy daemons) and
// `~/.manyfold/profiles/<profile>/workspaces/<agentId>` (ADR-0014 daemons).
export const isManagedSkillWorkspace = (workspacePath: string): boolean =>
    /\/\.(manyfold|nca)\/(?:profiles\/[a-z0-9][a-z0-9_-]{0,31}\/)?workspaces\/[^/]+\/?$/.test(
        workspacePath
    )

export const encodePath = (path: string): string =>
    path
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/')

export const shellEscape = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`
