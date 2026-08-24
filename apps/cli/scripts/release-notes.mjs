#!/usr/bin/env node
// Extracts one version's section out of apps/cli/CHANGELOG.md (written by
// changesets) for `gh release create --notes-file`.
//
// Exits 0 with an empty body when the section is missing so the release
// workflow can fall back to --generate-notes rather than failing a tag that is
// otherwise fine.
//
// Usage: node scripts/release-notes.mjs 0.24.0

import { readFileSync } from 'node:fs'

const version = process.argv[2]
if (!version) {
    console.error('release-notes: usage: release-notes.mjs <version>')
    process.exit(2)
}

const changelog = new URL('../CHANGELOG.md', import.meta.url)
let text
try {
    text = readFileSync(changelog, 'utf8')
} catch {
    process.exit(0)
}

const lines = text.split('\n')
const heading = `## ${version}`
const start = lines.findIndex((line) => line.trim() === heading)
if (start === -1) process.exit(0)

const rest = lines.slice(start + 1)
const nextHeading = rest.findIndex((line) => /^## /.test(line))
const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading))
    .join('\n')
    .trim()

if (body) process.stdout.write(`${body}\n`)
