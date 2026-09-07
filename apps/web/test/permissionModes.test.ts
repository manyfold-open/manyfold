import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentFramework } from '@manyfold/shared'
import {
    claudeCodePermissionModes,
    codexPermissionModes,
    hermesPermissionModes,
    openclawPermissionModes,
    DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
    DEFAULT_CODEX_PERMISSION_MODE,
    DEFAULT_HERMES_PERMISSION_MODE,
    DEFAULT_OPENCLAW_PERMISSION_MODE
} from '@manyfold/shared'
import en from '../../../packages/i18n/src/langs/en'
import {
    permissionModesByFramework,
    permissionModeEntryFor
} from '../src/lib/permissionModes'

// Pins the permission-mode table the composer renders from. Prove-red: reorder
// or drop an option, change a default, or rename a request field, and the
// matching assertion fails — the guard the per-framework arrays never had.

test('each framework entry offers exactly its shared modes, in the display order', () => {
    // The mode SET each framework offers must equal the shared contract; the
    // ORDER is the composer's display order (deliberately not the enum order),
    // pinned here as a snapshot.
    const sharedSet: Record<string, readonly string[]> = {
        'claude-code': claudeCodePermissionModes,
        codex: codexPermissionModes,
        hermes: hermesPermissionModes,
        openclaw: openclawPermissionModes
    }
    const displayOrder: Record<string, string[]> = {
        'claude-code': [
            'default',
            'acceptEdits',
            'plan',
            'auto',
            'dontAsk',
            'bypassPermissions'
        ],
        codex: ['default', 'auto-review', 'full-access'],
        hermes: ['default', 'acceptEdits', 'dontAsk'],
        openclaw: ['default', 'dontAsk']
    }
    for (const [framework, modes] of Object.entries(sharedSet)) {
        const entry = permissionModesByFramework[framework as AgentFramework]
        assert.ok(entry, `${framework} has a permission entry`)
        const values = entry.options.map((o) => o.value)
        assert.deepEqual(
            [...values].sort(),
            [...modes].sort(),
            `${framework} offers exactly its shared modes`
        )
        assert.deepEqual(
            values,
            displayOrder[framework],
            `${framework} display order`
        )
    }
})

test('defaults and request fields match the shared contract', () => {
    assert.equal(
        permissionModesByFramework['claude-code']?.defaultMode,
        DEFAULT_CLAUDE_CODE_PERMISSION_MODE
    )
    assert.equal(
        permissionModesByFramework.codex?.defaultMode,
        DEFAULT_CODEX_PERMISSION_MODE
    )
    assert.equal(
        permissionModesByFramework.hermes?.defaultMode,
        DEFAULT_HERMES_PERMISSION_MODE
    )
    assert.equal(
        permissionModesByFramework.openclaw?.defaultMode,
        DEFAULT_OPENCLAW_PERMISSION_MODE
    )
    assert.equal(
        permissionModesByFramework.openclaw?.requestField,
        'openclawPermissionMode'
    )
    assert.equal(
        permissionModesByFramework.hermes?.requestField,
        'hermesPermissionMode'
    )
})

test('storage prefixes are stable and per-framework distinct', () => {
    const prefixes = Object.values(permissionModesByFramework).map(
        (e) => e?.storagePrefix
    )
    assert.equal(new Set(prefixes).size, prefixes.length, 'prefixes distinct')
    assert.equal(
        permissionModesByFramework.openclaw?.storagePrefix,
        'nca.chat.openclawPermissionMode.'
    )
})

test('every i18n key an option names exists in the English catalog', () => {
    const catalog = en as unknown as Record<string, unknown>
    // en is nested; flatten the composer.permission subtree to dotted keys.
    const flat = new Set<string>()
    const walk = (obj: Record<string, unknown>, prefix: string): void => {
        for (const [k, v] of Object.entries(obj)) {
            const key = prefix ? `${prefix}.${k}` : k
            if (v && typeof v === 'object') walk(v as Record<string, unknown>, key)
            else flat.add(key)
        }
    }
    walk(catalog, '')
    for (const entry of Object.values(permissionModesByFramework)) {
        for (const option of entry?.options ?? []) {
            for (const key of [
                option.labelKey,
                option.titleKey,
                option.descriptionKey
            ])
                assert.ok(flat.has(key), `missing i18n key: ${key}`)
        }
    }
})

test('only the frameworks with a selector have an entry; the rest are null', () => {
    assert.equal(permissionModeEntryFor('gemini-cli'), null)
    assert.equal(permissionModeEntryFor('narranexus'), null)
    assert.equal(permissionModeEntryFor(null), null)
    assert.ok(permissionModeEntryFor('openclaw'))
})

test('dangerous options are flagged for the destructive modes', () => {
    const dangerous = (framework: string): string[] =>
        (permissionModesByFramework[framework as AgentFramework]?.options ?? [])
            .filter((o) => o.dangerous)
            .map((o) => o.value)
    assert.deepEqual(dangerous('claude-code'), ['bypassPermissions'])
    assert.deepEqual(dangerous('codex'), ['full-access'])
    assert.deepEqual(dangerous('hermes'), ['dontAsk'])
    assert.deepEqual(dangerous('openclaw'), ['dontAsk'])
})
