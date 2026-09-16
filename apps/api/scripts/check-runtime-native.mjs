import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(path.join(process.cwd(), 'package.json'))
const graph = JSON.parse(fs.readFileSync('runtime-deps.json', 'utf8'))
assert.equal(graph.platform.os, process.platform)
assert.equal(graph.platform.cpu, process.arch)

const Database = require('better-sqlite3')
const database = new Database(':memory:')
try {
    assert.equal(database.prepare('SELECT 1 AS value').get().value, 1)
} finally {
    database.close()
}
const argon = require('@node-rs/argon2')
assert.ok(
    argon.verifySync(argon.hashSync('runtime-fixture'), 'runtime-fixture')
)
const sharp = createRequire(require.resolve('baileys'))('sharp')
const png = await sharp({
    create: { width: 1, height: 1, channels: 3, background: 'red' }
})
    .png()
    .toBuffer()
assert.ok(png.length > 0)

const manifest = require('./package.json')
for (const dependency of Object.keys(manifest.dependencies).filter((name) =>
    name.startsWith('@manyfold/')
))
    await import(pathToFileURL(require.resolve(dependency)).href)
console.log(
    `runtime-native: SQLite, Argon2, Sharp and workspace exports passed on ${process.platform}/${process.arch}; Sentry ${require('@sentry/node/package.json').version}`
)
