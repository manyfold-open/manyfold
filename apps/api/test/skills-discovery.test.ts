import assert from 'node:assert/strict'
import test from 'node:test'
import {
    parseSkillMarkdown,
    readmeContent
} from '../src/modules/skills/skill-discovery.service'
import {
    installDirBase,
    installDirWithSuffix,
    parseSkillId,
    skillIdFor
} from '../src/modules/skills/skill-utils'

test('parseSkillMarkdown reads YAML frontmatter name and description', () => {
    const parsed = parseSkillMarkdown(`---
name: PDF Toolkit
description: Work with PDF files
---

# Ignored fallback
`)

    assert.equal(parsed.name, 'PDF Toolkit')
    assert.equal(parsed.description, 'Work with PDF files')
})

test('parseSkillMarkdown falls back to heading and first paragraph', () => {
    const parsed = parseSkillMarkdown(`# Browser Tools

Use browser automation for local web apps.
`)

    assert.equal(parsed.name, 'Browser Tools')
    assert.equal(
        parsed.description,
        'Use browser automation for local web apps.'
    )
})

test('parseSkillMarkdown extracts author, license, platforms and secrets', () => {
    const parsed = parseSkillMarkdown(`---
name: 1password
description: Manage secrets through 1Password
version: 1.0.0
author: arceus77-7
license: MIT
platforms: [linux, macos, windows]
setup:
  collect_secrets:
    - env_var: OP_SERVICE_ACCOUNT_TOKEN
      prompt: 1Password Service Account Token
      provider_url: https://developer.1password.com/docs/service-accounts/
      secret: true
---

# 1Password CLI

Body text.
`)

    assert.equal(parsed.author, 'arceus77-7')
    assert.equal(parsed.license, 'MIT')
    assert.equal(parsed.version, '1.0.0')
    assert.deepEqual(parsed.platforms, ['linux', 'macos', 'windows'])
    assert.equal(parsed.secrets.length, 1)
    assert.deepEqual(parsed.secrets[0], {
        envVar: 'OP_SERVICE_ACCOUNT_TOKEN',
        prompt: '1Password Service Account Token',
        providerUrl: 'https://developer.1password.com/docs/service-accounts/'
    })
    assert.equal(parsed.body, '# 1Password CLI\n\nBody text.')
})

test('readmeContent strips frontmatter and returns typed meta', () => {
    const { body, meta } = readmeContent(`---
name: pdf
license: Apache-2.0
---

Just the body.
`)

    assert.equal(body, 'Just the body.')
    assert.equal(meta.license, 'Apache-2.0')
    assert.deepEqual(meta.platforms, [])
    assert.deepEqual(meta.secrets, [])
})

test('parseSkillMarkdown tolerates missing frontmatter fields', () => {
    const parsed = parseSkillMarkdown(`# Plain Skill

No frontmatter here.
`)

    assert.equal(parsed.author, null)
    assert.equal(parsed.license, null)
    assert.deepEqual(parsed.platforms, [])
    assert.deepEqual(parsed.secrets, [])
    assert.equal(parsed.body, '# Plain Skill\n\nNo frontmatter here.')
})

test('skill ids round-trip safe GitHub coordinates', () => {
    const id = skillIdFor({
        owner: 'anthropics',
        repo: 'skills',
        branch: 'main',
        sourcePath: 'skills/pdf'
    })

    assert.equal(id, 'github:anthropics/skills@main:skills/pdf')
    assert.deepEqual(parseSkillId(id), {
        owner: 'anthropics',
        repo: 'skills',
        branch: 'main',
        sourcePath: 'skills/pdf'
    })
})

test('install dir suffix is deterministic and length bounded', () => {
    const base = installDirBase('PDF Toolkit!')
    const first = installDirWithSuffix(
        base,
        'github:anthropics/skills@main:pdf'
    )
    const second = installDirWithSuffix(
        base,
        'github:anthropics/skills@main:pdf'
    )

    assert.equal(base, 'pdf-toolkit')
    assert.equal(first, second)
    assert.match(first, /^pdf-toolkit-[a-f0-9]{8}$/)
    assert.ok(first.length <= 64)
})
