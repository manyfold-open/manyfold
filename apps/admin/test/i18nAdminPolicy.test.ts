import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
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

// Admin ships English and Chinese only. The nine reviewed catalogs are a Web
// surface: `admin.*` deliberately never enters them, and Admin has no locale
// selection (module-level language stays 'en'), so zh.admin is forward
// provisioning for a switcher that does not exist yet. That policy was prose
// until this file (docs/engineering/conventions.md "admin.* 不进入这九份
// catalog", docs/product/domain/localization.md Boundaries); an omission a
// test does not state reads like an accident — legacy-inventory §7 carried it
// as one for a round.
//
// Deliberately NOT here: web's "no unapproved hardcoded English" walk. Admin
// mixes catalog copy with intentional inline English (an en-only surface, so
// inline English is not a translation defect); a hardcoded-copy gate would be
// a large allowlist asserting nothing.

// Small local copies of web/test/i18nCompleteness.test.ts helpers: that file
// keeps its helpers private, and admin's policy pin should not couple to
// another app's test internals.
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

const placeholders = (value: string): string[] =>
    [...value.matchAll(/\{\{\w+\}\}/g)].map(([placeholder]) => placeholder)

const enAdmin = flattenStrings(en.admin, 'admin')
const zhAdmin = flattenStrings(zh.admin, 'admin')

test('zh mirrors en key-for-key under admin.', () => {
    assert.deepEqual(
        Object.keys(zhAdmin).sort(),
        Object.keys(enAdmin).sort(),
        'admin key sets must stay identical between en and zh'
    )
    for (const [key, value] of Object.entries(enAdmin)) {
        assert.ok(
            zhAdmin[key].trim().length > 0 || value.trim().length === 0,
            `${key} is blank in zh`
        )
        assert.deepEqual(
            placeholders(zhAdmin[key]).sort(),
            placeholders(value).sort(),
            `${key} placeholder mismatch`
        )
    }
})

// Brand and technical tokens that appear in en.admin copy today; a
// translation may reword prose but must carry these through verbatim.
const protectedLiterals = [
    'Manyfold',
    'MCP',
    'Claude Code',
    'Codex',
    'Gemini',
    'Hermes',
    'OpenClaw',
    'NarraNexus',
    'API',
    'CLI',
    'Anthropic',
    'Dify',
    'Langflow',
    'Slack',
    'Telegram',
    'SMTP'
]

test('zh preserves the protected literals of en.admin values', () => {
    const offenders: string[] = []
    for (const [key, value] of Object.entries(enAdmin))
        for (const literal of protectedLiterals)
            if (value.includes(literal) && !zhAdmin[key].includes(literal))
                offenders.push(`${key}: ${literal}`)
    assert.deepEqual(offenders, [])
})

test('the nine generated catalogs carry no admin keys', () => {
    // Structurally web's parity loop would also catch a leak (its key set is
    // web-only), but this states the policy in its own words and survives if
    // that hand-list ever drifts.
    const generated: Record<string, Record<string, string>> = {
        ar,
        de,
        es,
        fr,
        hi,
        ja,
        ko,
        pt,
        ru
    }
    for (const [language, catalog] of Object.entries(generated))
        assert.deepEqual(
            Object.keys(catalog).filter((key) => key.startsWith('admin.')),
            [],
            `${language} must not carry admin.* keys (admin is en/zh only)`
        )
})

const adminRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'src'
)

const walkSource = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) return walkSource(path)
        return /\.tsx?$/.test(entry.name) ? [path] : []
    })

test('every static admin translation key exists in the English catalog', () => {
    const offenders: string[] = []
    for (const path of walkSource(adminRoot)) {
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
                /^admin\.[A-Za-z0-9_.]+$/.test(node.text) &&
                !Object.hasOwn(enAdmin, node.text)
            ) {
                const { line } = sourceFile.getLineAndCharacterOfPosition(
                    node.getStart(sourceFile)
                )
                offenders.push(
                    `${relative(adminRoot, path)}:${line + 1}: ${node.text}`
                )
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)
    }
    assert.deepEqual(offenders, [])
})
