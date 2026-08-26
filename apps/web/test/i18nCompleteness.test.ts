import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import {
    getLocale,
    languageOptions,
    loadLanguage,
    setLanguage,
    t
} from '@manyfold/i18n'
import type { Language } from '@manyfold/i18n'
import en from '../../../packages/i18n/src/langs/en'
import zh from '../../../packages/i18n/src/langs/zh'
import ar from '../../../packages/i18n/src/langs/generated/ar'
import de from '../../../packages/i18n/src/langs/generated/de'
import es from '../../../packages/i18n/src/langs/generated/es'
import fr from '../../../packages/i18n/src/langs/generated/fr'
import hi from '../../../packages/i18n/src/langs/generated/hi'
import ja from '../../../packages/i18n/src/langs/generated/ja'
import ko from '../../../packages/i18n/src/langs/generated/ko'
import pt from '../../../packages/i18n/src/langs/generated/pt'
import ru from '../../../packages/i18n/src/langs/generated/ru'
import { formatDate } from '../src/lib/dateFormat'
import {
    createLanguageRequestGuard,
    resolveBrowserLanguage,
    resolvePreferredLanguage
} from '../src/lib/i18n'
import { formatTableDateTime, utcDateLabel } from '../src/lib/usageFormat'

const testRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testRoot, '../../..')
const webRoot = join(testRoot, '..', 'src')

const flattenStrings = (
    value: unknown,
    prefix = '',
    result: Record<string, string> = {}
): Record<string, string> => {
    if (typeof value === 'string') {
        result[prefix] = value
        return result
    }
    if (!value || typeof value !== 'object') return result
    for (const [key, child] of Object.entries(value)) {
        flattenStrings(child, prefix ? `${prefix}.${key}` : key, result)
    }
    return result
}

const englishCatalog = flattenStrings({
    common: en.common,
    errors: en.errors,
    web: en.web
})
const chineseCatalog = flattenStrings({
    common: zh.common,
    errors: zh.errors,
    web: zh.web
})
const reviewedCatalogs = { ar, de, es, fr, hi, ja, ko, pt, ru } as const
type ReviewedLanguage = keyof typeof reviewedCatalogs

// The component renders Prefix + KEY=VALUE + Suffix. Japanese naturally uses
// `KEY=VALUE形式で…`, so the prefix is intentionally empty and the suffix owns
// the localizable copy.
const intentionalReviewedBlanks = new Set([
    'ja:web.agents.detail.environment.descriptionPrefix'
])

const declaredCatalogKeys = (language: ReviewedLanguage): string[] => {
    const source = readFileSync(
        join(repoRoot, 'packages/i18n/src/langs/generated', `${language}.ts`),
        'utf8'
    )
    return [...source.matchAll(/^ {4}['"]([^'"]+)['"]:/gm)].map(
        ([, key]) => key
    )
}

const placeholders = (value: string): string[] =>
    [...value.matchAll(/\{\{\w+\}\}/g)].map(([placeholder]) => placeholder)

const protectedLiterals = [
    'A2A',
    'API',
    'CLI',
    'MESSAGE_CONTENT',
    'NONE',
    'TTFT',
    '/model',
    '/sync',
    '/chat-messages',
    '/api/v1/run/{flow}',
    'https://api.example.com/v1',
    'anthropic/claude-sonnet-5',
    'references/notes.md',
    '-----BEGIN RSA PRIVATE KEY-----',
    'mf update',
    'mf daemon stop',
    'mf daemon start',
    'AGENTS.md',
    'IDENTITY.md',
    'SOUL.md',
    'USER.md',
    'TOOLS.md',
    'MEMORY.md',
    '[SILENT]',
    '$sentry',
    'Anthropic',
    'Docker',
    'Discord',
    'Fly.io',
    'GitHub',
    'Google',
    'Lark',
    'Linear',
    'Manyfold',
    'Matrix',
    'Netmind',
    'OpenAI',
    'PostHog',
    'Sentry',
    'Slack',
    'Tailscale',
    'Telegram',
    'Tencent',
    'Vercel',
    'WebSocket',
    'WeChat',
    'WhatsApp',
    'Claude Code',
    'Codex',
    'Dify',
    'Gemini CLI',
    'Hermes Agent',
    'Hermes',
    'Langflow',
    'NarraNexus',
    'OpenClaw'
] as const

// Prefix/suffix fragments render around a target name. Chinese and Korean
// move A2A into the suffix for natural word order, so validate the composed
// copy instead of requiring it in the English-side prefix.
const protectedLiteralCompanions = new Map([
    [
        'web.agents.detail.a2a.enableTargetPrefix:A2A',
        'web.agents.detail.a2a.enableTargetSuffix'
    ]
])

// The Simplified Chinese catalog uses WeChat's official Chinese product name.
// Keep this exception language- and brand-specific; every reviewed locale and
// every other product name must still preserve the English literal.
const localizedProtectedLiterals = new Map([['zh:WeChat', '微信']])

const preservesProtectedLiteral = (
    catalog: Readonly<Record<string, string>>,
    key: string,
    literal: string,
    language?: ReviewedLanguage | 'zh'
): boolean => {
    if (catalog[key].includes(literal)) return true
    const localized = localizedProtectedLiterals.get(`${language}:${literal}`)
    if (localized !== undefined && catalog[key].includes(localized)) return true
    const companion = protectedLiteralCompanions.get(`${key}:${literal}`)
    return companion !== undefined && catalog[companion].includes(literal)
}

const sourceUrls = (value: string): string[] =>
    [...value.matchAll(/https?:\/\/[^\s'"<>]+/g)].map(([url]) => url)

const technicalLiteralPatterns = [
    /-----BEGIN [A-Z ]+-----/g,
    /\[[A-Z][A-Z0-9_]+\]/g,
    /\b[A-Z][A-Z0-9_]{2,}\b/g,
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    /\b(?=[A-Za-z0-9_-]*\d)[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+\b/g,
    /(?<![A-Za-z0-9])\/[A-Za-z0-9][A-Za-z0-9._~:@$&+={}-]*(?:\/[A-Za-z0-9][A-Za-z0-9._~:@$&+={}-]*)+/g,
    /\b[A-Za-z0-9_-]+\.(?:cjs|crt|js|json|key|log|md|mjs|pem|py|sh|toml|ts|tsx|txt|ya?ml)\b/g,
    /\b(?:AGENTS|IDENTITY|SOUL|USER|TOOLS|MEMORY)(?:\.manyfold)?\.md\b/g,
    /(?:^|\s)\.env\b/g
] as const

const technicalLiterals = (value: string): string[] => {
    const literals = new Set<string>()
    for (const literal of protectedLiterals)
        if (value.includes(literal)) literals.add(literal)
    for (const url of sourceUrls(value)) literals.add(url)
    for (const [, inlineCode] of value.matchAll(/`([^`\n]+)`/g))
        literals.add(inlineCode)
    for (const pattern of technicalLiteralPatterns)
        for (const [match] of value.matchAll(pattern))
            literals.add(match.trim())
    return [...literals]
        .map((literal) => literal.replace(/[.,;:!?]+$/, ''))
        .filter((literal) => literal && literal !== 'FAQ')
        .sort((left, right) => right.length - left.length)
}

const localizableEnglishText = (value: string): string => {
    let localizable = value.replaceAll(/\{\{\w+\}\}/g, ' ')
    for (const literal of technicalLiterals(value))
        localizable = localizable.replaceAll(literal, ' ')
    return localizable
}

const localizableEnglishWords = (value: string): string[] =>
    localizableEnglishText(value).match(/[A-Za-z]{3,}/g) ?? []

const targetScripts: Partial<Record<ReviewedLanguage, RegExp>> = {
    ar: /\p{Script=Arabic}/u,
    hi: /\p{Script=Devanagari}/u,
    ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
    ko: /\p{Script=Hangul}/u,
    ru: /\p{Script=Cyrillic}/u
}

const minimumLengthRatios: Record<ReviewedLanguage, number> = {
    ar: 0.18,
    de: 0.3,
    es: 0.28,
    fr: 0.28,
    hi: 0.16,
    ja: 0.1,
    ko: 0.1,
    pt: 0.28,
    ru: 0.18
}

const fillerByLanguage: Record<ReviewedLanguage, readonly string[]> = {
    ar: ['الوصف', 'متاح'],
    de: ['Beschreibung'],
    es: ['Descripción'],
    fr: ['Description'],
    hi: ['विवरण', 'विवरण उपलब्ध है'],
    ja: ['説明'],
    ko: ['설명'],
    pt: ['Descrição'],
    ru: ['Описание']
}

// This is an example token name rather than prose. Keeping it in English does
// not indicate that the surrounding UI catalog leaked English copy.
const nonLocalizableExampleKeys = new Set(['web.apiTokens.namePlaceholder'])

const normalizedWords = (value: string): string[] =>
    value.toLowerCase().match(/[a-z]{2,}/g) ?? []

const longestEnglishWindow = (
    source: string,
    translated: string,
    size = 8
): string | undefined => {
    const sourceWords = localizableEnglishWords(source).map((word) =>
        word.toLowerCase()
    )
    if (sourceWords.length < size) return undefined
    const translatedWords = normalizedWords(translated).join(' ')
    for (let index = 0; index <= sourceWords.length - size; index += 1) {
        const window = sourceWords.slice(index, index + size).join(' ')
        if (translatedWords.includes(window)) return window
    }
    return undefined
}

test('reviewed Chinese catalog covers product copy without corrupting literals', () => {
    const englishKeys = Object.keys(englishCatalog).sort()
    const intentionalChineseBlanks = new Set([
        'web.challenge.req.h2a',
        'web.challenge.judge.h2a'
    ])
    assert.deepEqual(Object.keys(chineseCatalog).sort(), englishKeys)

    let translated = 0
    for (const key of englishKeys) {
        const value = chineseCatalog[key]
        if (englishCatalog[key].trim() && !intentionalChineseBlanks.has(key))
            assert.ok(value.trim(), `zh:${key} is blank`)
        assert.deepEqual(
            placeholders(value).sort(),
            placeholders(englishCatalog[key]).sort(),
            `zh:${key} changed placeholders`
        )
        assert.doesNotMatch(value, /__MF_[A-Z0-9_]+__/)
        assert.doesNotMatch(
            value,
            /(\p{L}{1,20})(?:\s+\1){3,}/u,
            `zh:${key} contains repeated model output`
        )
        for (const literal of protectedLiterals) {
            if (englishCatalog[key].includes(literal))
                assert.ok(
                    preservesProtectedLiteral(
                        chineseCatalog,
                        key,
                        literal,
                        'zh'
                    ),
                    `zh:${key} changed protected literal ${literal}`
                )
        }
        for (const url of sourceUrls(englishCatalog[key]))
            assert.ok(value.includes(url), `zh:${key} changed URL ${url}`)
        if (value !== englishCatalog[key]) translated += 1
    }
    assert.ok(
        translated / englishKeys.length > 0.9,
        'zh translates too little of the English catalog'
    )
})

test('reviewed catalog rejects semantic collapse signals', () => {
    const translationsByValue = new Map<string, string[]>()
    const genericOneWordLabels = new Set([
        '信息',
        '可用',
        '描述',
        '状态',
        '详情',
        '设置'
    ])

    for (const [key, source] of Object.entries(englishCatalog)) {
        const translated = chineseCatalog[key]
        if (source.length < 40 || source === translated || !translated.trim())
            continue
        const keys = translationsByValue.get(translated) ?? []
        keys.push(key)
        translationsByValue.set(translated, keys)
        assert.ok(
            !genericOneWordLabels.has(translated.trim()),
            `zh:${key} collapses long copy to ${translated}`
        )
    }

    for (const [value, keys] of translationsByValue)
        assert.ok(
            keys.length <= 3,
            `zh maps ${keys.length} long strings to ${value}: ${keys.join(', ')}`
        )
})

test('reviewed locale catalogs preserve structure and technical literals', () => {
    const englishKeys = Object.keys(englishCatalog).sort()

    for (const [language, catalog] of Object.entries(reviewedCatalogs) as Array<
        [ReviewedLanguage, Readonly<Record<string, string>>]
    >) {
        assert.deepEqual(Object.keys(catalog).sort(), englishKeys, language)
        const declaredKeys = declaredCatalogKeys(language)
        assert.equal(
            declaredKeys.length,
            englishKeys.length,
            `${language} has duplicate or malformed key declarations`
        )
        assert.deepEqual(declaredKeys.sort(), englishKeys, language)

        for (const key of englishKeys) {
            const source = englishCatalog[key]
            const translated = catalog[key]
            const intentionalBlank = intentionalReviewedBlanks.has(
                `${language}:${key}`
            )
            if (source.trim() && !intentionalBlank)
                assert.ok(translated.trim(), `${language}:${key} is blank`)
            else
                assert.equal(
                    translated,
                    '',
                    `${language}:${key} should stay blank`
                )
            assert.deepEqual(
                placeholders(translated).sort(),
                placeholders(source).sort(),
                `${language}:${key} changed placeholders`
            )
            assert.doesNotMatch(translated, /__MF_[A-Z0-9_]+__/)
            assert.doesNotMatch(
                translated,
                /(\p{L}{1,20})(?:\s+\1){3,}/u,
                `${language}:${key} contains repeated model output`
            )

            for (const literal of technicalLiterals(source))
                assert.ok(
                    preservesProtectedLiteral(catalog, key, literal, language),
                    `${language}:${key} changed technical literal ${literal}`
                )
        }
    }
})

test('reviewed locale catalogs reject semantic collapse and filler', () => {
    for (const [language, catalog] of Object.entries(reviewedCatalogs) as Array<
        [ReviewedLanguage, Readonly<Record<string, string>>]
    >) {
        const translationsByValue = new Map<string, string[]>()

        for (const [key, source] of Object.entries(englishCatalog)) {
            if (source.length < 40) continue
            const translated = catalog[key].trim()
            assert.ok(
                !fillerByLanguage[language].includes(translated),
                `${language}:${key} collapses long copy to ${translated}`
            )
            const keys = translationsByValue.get(translated) ?? []
            keys.push(key)
            translationsByValue.set(translated, keys)

            if (
                source.length >= 80 &&
                localizableEnglishWords(source).length >= 8
            )
                assert.ok(
                    translated.length >=
                        Math.max(
                            16,
                            Math.floor(
                                source.length * minimumLengthRatios[language]
                            )
                        ),
                    `${language}:${key} abnormally shortens ${source.length} characters to ${translated.length}`
                )
        }

        for (const [value, keys] of translationsByValue)
            assert.ok(
                keys.length <= 3,
                `${language} maps ${keys.length} long strings to ${value}: ${keys.join(', ')}`
            )
    }
})

test('reviewed locale catalogs reject high-signal English leakage', () => {
    for (const [language, catalog] of Object.entries(reviewedCatalogs) as Array<
        [ReviewedLanguage, Readonly<Record<string, string>>]
    >) {
        const targetScript = targetScripts[language]

        for (const [key, source] of Object.entries(englishCatalog)) {
            if (nonLocalizableExampleKeys.has(key)) continue
            const localizableWords = localizableEnglishWords(source)
            if (localizableWords.length < 2) continue
            const translated = catalog[key]

            if (targetScript)
                assert.match(
                    translated,
                    targetScript,
                    `${language}:${key} has no target-script text`
                )

            if (localizableWords.length >= 5)
                assert.notEqual(
                    translated.trim(),
                    source.trim(),
                    `${language}:${key} leaves localizable copy in English`
                )

            const leakedWindow = longestEnglishWindow(source, translated)
            assert.equal(
                leakedWindow,
                undefined,
                `${language}:${key} retains long English copy: ${leakedWindow}`
            )
        }
    }
})

test('generated catalogs load before selection and fall back safely', async () => {
    setLanguage('fr')
    assert.equal(t('common.cancel'), englishCatalog['common.cancel'])

    await Promise.all([loadLanguage('fr'), loadLanguage('fr')])
    setLanguage('fr')
    assert.equal(t('common.cancel'), fr['common.cancel'])
    assert.equal(t('web.missing.translation'), 'web.missing.translation')
    setLanguage('en')
})

test('language preferences cover stored values and regional browser locales', () => {
    assert.equal(resolveBrowserLanguage(['pt-BR']), 'pt')
    assert.equal(resolveBrowserLanguage(['ar-EG']), 'ar')
    assert.equal(resolveBrowserLanguage(['zh-Hant']), 'zh')
    assert.equal(resolveBrowserLanguage(['it-IT', 'fr-CA']), 'fr')
    assert.equal(resolveBrowserLanguage(['it-IT']), 'en')
    assert.equal(resolvePreferredLanguage('ja', ['de-DE']), 'ja')
    assert.equal(resolvePreferredLanguage('stale-locale', ['de-DE']), 'de')
})

test('rapid language switches only commit the newest catalog request', async () => {
    const guard = createLanguageRequestGuard()
    const committed: Language[] = []
    let releaseSlowLoad: (() => void) | undefined
    const slowLoad = new Promise<void>((resolve) => {
        releaseSlowLoad = resolve
    })
    const select = async (
        language: Language,
        load: Promise<void>
    ): Promise<void> => {
        const request = guard.begin()
        await load
        if (guard.isCurrent(request)) committed.push(language)
    }

    const slowSelection = select('ar', slowLoad)
    await select('de', Promise.resolve())
    releaseSlowLoad?.()
    await slowSelection
    assert.deepEqual(committed, ['de'])
})

test('web entry waits for the initial catalog before rendering', () => {
    const entry = readFileSync(join(webRoot, 'main.tsx'), 'utf8')
    assert.match(entry, /void i18nReady\.then\(renderApp, renderApp\)/)
})

const walkSource = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) return walkSource(path)
        return /\.tsx?$/.test(entry.name) ? [path] : []
    })

test('selected language controls every locale-sensitive date path', () => {
    const value = '2026-02-03T12:00:00.000Z'

    for (const option of languageOptions) {
        setLanguage(option.code)
        assert.equal(getLocale(), option.locale)
        assert.equal(
            formatDate(value),
            new Date(value).toLocaleDateString(option.locale)
        )
        assert.equal(
            utcDateLabel(value),
            new Date(value).toLocaleDateString(option.locale, {
                timeZone: 'UTC',
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            })
        )
        assert.equal(
            formatTableDateTime(value),
            new Date(value).toLocaleString(option.locale, {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            })
        )
    }

    assert.equal(
        languageOptions.filter((option) => option.direction === 'rtl')[0]?.code,
        'ar'
    )
    setLanguage('en')
})

test('web date formatting never falls back to the browser locale', () => {
    const offenders: string[] = []
    for (const path of walkSource(webRoot)) {
        const sourceFile = ts.createSourceFile(
            path,
            readFileSync(path, 'utf8'),
            ts.ScriptTarget.Latest,
            true,
            path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        )
        const visit = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                /^toLocale(?:Date|Time)?String$/.test(
                    node.expression.name.text
                ) &&
                (node.arguments.length === 0 ||
                    (ts.isIdentifier(node.arguments[0]) &&
                        node.arguments[0].text === 'undefined'))
            ) {
                const { line } = sourceFile.getLineAndCharacterOfPosition(
                    node.getStart(sourceFile)
                )
                offenders.push(`${path}:${line + 1}`)
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)
    }
    assert.deepEqual(offenders, [])
})

const displayAttributes = new Set(['alt', 'aria-label', 'placeholder', 'title'])
const displayProperties = new Set([
    'alt',
    'ariaLabel',
    'body',
    'caption',
    'cancelLabel',
    'confirmLabel',
    'description',
    'emptyMessage',
    'heading',
    'label',
    'message',
    'placeholder',
    'submitLabel',
    'title'
])

// These strings are identifiers, brands, commands, code samples, CSS tokens,
// protocol values, or demo names rather than localizable product copy. Keeping
// the allowlist exact and file-scoped makes every new English display string a
// deliberate review decision.
const allowedEnglishByFile: Record<string, readonly string[]> = {
    // Discriminated-union tags and a section id, not display copy — the
    // labels these describe come from `t()`.
    'lib/agentMenu.ts': ['danger', 'nav', 'quick'],
    'lib/agentSettingsSections.ts': ['overview'],
    'pages/AgentSettings/AgentSettings.tsx': ['/workspace'],
    'components/AppShell.tsx': [
        'Claude Code',
        'Codex',
        'Gemini CLI',
        'Hermes',
        'NarraNexus',
        'OpenClaw',
        'flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-2 text-left text-muted transition-colors group-hover/row:text-fg',
        'mb-1'
    ],
    'components/DaemonShared.tsx': [
        'curl -fsSL https://manyfold.ai/cli/install.sh | sh -s -- setup'
    ],
    'components/Loading.tsx': ['h-[18px] rounded-xs'],
    'components/NetmindSignIn.tsx': ['GitHub', 'Google', 'Microsoft'],
    'components/QuotaBanner.tsx': ['bg-info-bg text-fg'],
    'components/TerminalDock.tsx': [
        'bg-[#f59e0b]',
        'bg-placeholder',
        'bg-workflow-develop',
        'bg-workflow-ship'
    ],
    'components/chat/Composer.tsx': [
        '5.3 Codex',
        '5.3 Spark',
        '5.4 Mini',
        '5.6 Luna',
        '5.6 Sol',
        '5.6 Terra',
        'Claude',
        'Claude Code',
        'Codex',
        'GPT-5.2',
        'GPT-5.3-Codex',
        'GPT-5.3-Codex-Spark',
        'GPT-5.4',
        'GPT-5.4-Mini',
        'GPT-5.5',
        'GPT-5.6 Luna',
        'GPT-5.6 Sol',
        'GPT-5.6 Terra',
        'Gemini CLI',
        'Haiku',
        'Hermes',
        'NarraNexus',
        'OpenClaw',
        'Opus',
        'Sonnet'
    ],
    'components/chat/WorkspaceFiles.tsx': ['dockerfile'],
    'components/chat/preview/previewKinds.ts': [
        '#ERR',
        'docx',
        'sqlite',
        'xlsx'
    ],
    'components/chat/preview/sqliteWorker.ts': ['database is not open'],
    'components/chat/tools/ToolBlock.tsx': [
        'bg-[#0a8a3e]',
        'bg-divider',
        'bg-workflow-develop'
    ],
    'components/chat/utils/pairToolBlocks.ts': ['completed', 'denied', 'error'],
    'components/marketing/CobrandLockup.tsx': ['Manyfold'],
    'components/marketing/MarketingNav.tsx': ['Manyfold'],
    'lib/a2aTaskState.ts': ['error', 'idle', 'info', 'success', 'warning'],
    'lib/agentCreate/frameworkOptions.ts': [
        'Claude Code',
        'Codex',
        'Dify',
        'Gemini CLI',
        'Hermes Agent',
        'Langflow',
        'NarraNexus',
        'OpenClaw'
    ],
    'lib/agentSidebarView.ts': ['month', 'older', 'today', 'week', 'yesterday'],
    'lib/analyticsConsent.ts': ['unset'],
    'lib/challengeStage.ts': ['approved'],
    'lib/channelMeta.tsx': [
        'Discord',
        'Fake (test)',
        'GitHub',
        'LINE',
        'Lark',
        'Linear',
        'Matrix',
        'Slack',
        'Telegram',
        'WeChat',
        'WhatsApp'
    ],
    'lib/fontSize.tsx': ['default'],
    'lib/i18n.tsx': ['zh'],
    'lib/theme.tsx': ['light'],
    'pages/AgentNew/components/CreateProgress.tsx': [
        'active',
        'done',
        'failed',
        'pending'
    ],
    'pages/AgentNew/v1/AgentNewV1.tsx': ['Anthropic', 'OpenAI'],
    'pages/AgentNew/v2/AgentNewBInline.tsx': [
        'Anthropic',
        'OpenAI',
        'existing',
        'persistent',
        'sandbox'
    ],
    'pages/AgentNew/v3/AgentNewV3.tsx': ['openai'],
    'pages/AgentRuntimesList.tsx': ['bg-error', 'error'],
    'pages/Challenge.tsx': [
        'Article Lens',
        'Team Agents',
        'Travel Ticket',
        'closed',
        'judging',
        'pre-registration',
        'registration'
    ],
    'pages/Customize/CreateSkillDialog.tsx': ['https://github.com/owner/repo'],
    'pages/Customize/UserMcpServerDialog.tsx': [
        'context7',
        'https://mcp.example.com/mcp',
        'npx',
        '{ "Authorization": "Bearer …" }'
    ],
    'pages/Customize/librarySkillFileUtils.ts': ['dir', 'file'],
    'pages/Invite.tsx': ['Manyfold'],
    'pages/Landing.tsx': [
        'Claude Code',
        'Codex',
        'Discord',
        'Gemini CLI',
        'Hermes',
        'Lark',
        'Matrix',
        'Slack',
        'Telegram',
        'cc-refactor',
        'cc-review',
        'codex-review',
        'gemini-research',
        'github-mcp',
        'postgres-mcp',
        'slack-mcp'
    ],
    'pages/Settings/BuyContainer.tsx': ['GB', 'MB'],
    'pages/Settings/Channels/ChannelDetail.tsx': [
        '120363000000000000@g.us, ...',
        '!roomid:matrix.example.org, ...',
        '/new',
        '123456789:AAH...',
        '@alice:matrix.example.org, ...',
        '@operator:matrix.example.org, ...',
        'Discord',
        'Fake (test)',
        'Feishu',
        'Cxxxxxxxx, Rxxxxxxxx',
        'GitHub',
        'GitHub App',
        'LINE',
        'Lark',
        'Linear',
        'MTk...',
        'Matrix',
        'OWNER, MEMBER, COLLABORATOR',
        'Slack',
        'Telegram',
        'U01ABCDEF',
        'U01ABCDEF, U02GHIJKL',
        'U4af4980629..., ...',
        'WeChat',
        'WhatsApp',
        'https://matrix.example.org',
        'ou_xxxx',
        'ou_xxxx, ou_yyyy',
        'owner/repo, owner/other-repo',
        'wxid_xxx@im.wechat, ...',
        'xoxb-...'
    ],
    'pages/Settings/Channels/ChannelsList.tsx': [
        '!roomid:matrix.example.org, ...',
        '123456789:AAH...',
        '@alice:matrix.example.org, ...',
        'Discord',
        'Feishu',
        'GitHub',
        'LINE',
        'Lark',
        'Linear',
        'MTk...',
        'Matrix',
        'Slack',
        'Telegram',
        'U01ABCDEF',
        'U01ABCDEF, U02GHIJKL',
        'WeChat',
        'WhatsApp',
        'cli_xxxxx',
        'error',
        'https://ilinkai.weixin.qq.com',
        'https://matrix.example.org',
        'ou_xxxx',
        'ou_xxxx, ou_yyyy',
        'owner/repo, owner/other-repo',
        'wxid_xxx@im.wechat, ...',
        'xoxb-...'
    ],
    'pages/Settings/LocalDaemons.tsx': [
        'mf daemon stop && mf daemon start',
        'mf update'
    ],
    'pages/Settings/ModelProviders.tsx': [
        'bg-error',
        'bg-idle',
        'bg-success',
        'custom-new',
        'error',
        'idle',
        'managed',
        'success'
    ],
    'pages/Settings/PlanAndBilling.tsx': [
        'bg-workflow-develop',
        'bg-workflow-preview',
        'bg-workflow-ship'
    ],
    'pages/SharedChatSession.tsx': ['Manyfold'],
    'pages/SharedSkill.tsx': ['Manyfold'],
    'pages/UsageEvents.tsx': ['custom'],
    'pages/agents/AgentA2a.tsx': ['mf a2a'],
    'pages/agents/AgentContextDoc.tsx': ['AGENTS.manyfold.md'],
    'pages/agents/AgentEnvVars.tsx': ['.env'],
    'pages/agents/AgentPermissions.tsx': ['mf request-permission'],
    'seo/StaticChrome.tsx': ['Manyfold']
}

const normalizedDisplayValue = (value: string): string =>
    value.replace(/\s+/g, ' ').trim()

test('every static Web translation key exists in the English catalog', () => {
    const offenders: string[] = []
    for (const path of walkSource(webRoot)) {
        const sourceFile = ts.createSourceFile(
            path,
            readFileSync(path, 'utf8'),
            ts.ScriptTarget.Latest,
            true,
            path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        )
        const visit = (node: ts.Node): void => {
            if (
                (ts.isStringLiteral(node) ||
                    ts.isNoSubstitutionTemplateLiteral(node)) &&
                /^(?:common|errors|web)\.[A-Za-z0-9_.]+$/.test(node.text) &&
                !Object.hasOwn(englishCatalog, node.text)
            ) {
                const { line } = sourceFile.getLineAndCharacterOfPosition(
                    node.getStart(sourceFile)
                )
                offenders.push(
                    `${relative(webRoot, path)}:${line + 1}: ${node.text}`
                )
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)
    }
    assert.deepEqual(offenders, [])
})

test('web source does not reintroduce unapproved hardcoded English', () => {
    const offenders: string[] = []

    const record = (
        sourceFile: ts.SourceFile,
        node: ts.Node,
        value: string
    ): void => {
        const normalized = normalizedDisplayValue(value)
        if (
            !/[A-Za-z]{2}/.test(normalized) ||
            /^(?:common|errors|web)\.[A-Za-z0-9_.]+$/.test(normalized)
        )
            return
        const file = relative(webRoot, sourceFile.fileName)
        if (allowedEnglishByFile[file]?.includes(normalized)) return
        const { line } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile)
        )
        offenders.push(`${file}:${line + 1}: ${normalized}`)
    }

    for (const path of walkSource(webRoot)) {
        const sourceFile = ts.createSourceFile(
            path,
            readFileSync(path, 'utf8'),
            ts.ScriptTarget.Latest,
            true,
            path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        )

        const visit = (node: ts.Node): void => {
            if (ts.isJsxText(node)) record(sourceFile, node, node.text)
            if (
                ts.isJsxAttribute(node) &&
                displayAttributes.has(node.name.getText(sourceFile)) &&
                node.initializer &&
                ts.isStringLiteral(node.initializer)
            )
                record(sourceFile, node, node.initializer.text)
            if (
                ts.isJsxExpression(node) &&
                node.expression &&
                (ts.isStringLiteral(node.expression) ||
                    ts.isNoSubstitutionTemplateLiteral(node.expression))
            )
                record(sourceFile, node, node.expression.text)
            if (
                ts.isPropertyAssignment(node) &&
                displayProperties.has(node.name.getText(sourceFile)) &&
                (ts.isStringLiteral(node.initializer) ||
                    ts.isNoSubstitutionTemplateLiteral(node.initializer))
            )
                record(sourceFile, node, node.initializer.text)
            if (
                ts.isReturnStatement(node) &&
                node.expression &&
                (ts.isStringLiteral(node.expression) ||
                    ts.isNoSubstitutionTemplateLiteral(node.expression))
            )
                record(sourceFile, node, node.expression.text)
            if (
                ts.isArrowFunction(node) &&
                (ts.isStringLiteral(node.body) ||
                    ts.isNoSubstitutionTemplateLiteral(node.body))
            )
                record(sourceFile, node, node.body.text)
            if (
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                /(?:label|title|description|message|placeholder|heading|caption)$/i.test(
                    node.name.text
                ) &&
                node.initializer &&
                (ts.isStringLiteral(node.initializer) ||
                    ts.isNoSubstitutionTemplateLiteral(node.initializer))
            )
                record(sourceFile, node, node.initializer.text)
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)
    }

    assert.deepEqual(offenders, [])
})
