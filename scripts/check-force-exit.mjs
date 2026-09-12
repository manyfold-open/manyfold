#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FLAG = '--test-force-exit'
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage'])
const CHECK_FILES = new Set([
    'scripts/check-force-exit.mjs',
    'scripts/check-force-exit.test.mjs'
])
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json|sh|ya?ml)$/

const sourceFiles = (root, relative) => {
    const absolute = path.join(root, relative)
    if (!fs.existsSync(absolute)) return []
    const stat = fs.statSync(absolute)
    if (stat.isFile()) return [relative]
    return fs
        .readdirSync(absolute, { withFileTypes: true })
        .flatMap((entry) => {
            if (entry.isSymbolicLink() || EXCLUDED_DIRS.has(entry.name))
                return []
            const child = path.join(relative, entry.name)
            if (entry.isDirectory()) return sourceFiles(root, child)
            return SOURCE_FILE.test(entry.name) ? [child] : []
        })
}

// Scan runners and whole-suite workflow commands too: a glob or an argv
// literal can hide a new leaked handle just as easily as a named test.
export function forceExitFailures(root = process.cwd()) {
    const files = ['', 'oss'].flatMap((edition) =>
        [
            'apps',
            'packages',
            'scripts',
            '.github/workflows',
            'package.json',
            'justfile'
        ].flatMap((relative) => sourceFiles(root, path.join(edition, relative)))
    )
    return files.sort().flatMap((file) => {
        if (CHECK_FILES.has(file.replace(/^oss\//, ''))) return []
        return fs
            .readFileSync(path.join(root, file), 'utf8')
            .split('\n')
            .flatMap((line, index) =>
                line.includes(FLAG)
                    ? [
                          `${file}:${index + 1}: ${FLAG} is forbidden; release the test's resources so its process exits naturally`
                      ]
                    : []
            )
    })
}

const isCli =
    process.argv[1] &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isCli) {
    const failures = forceExitFailures()
    if (failures.length) {
        for (const failure of failures) console.error(failure)
        process.exitCode = 1
    } else console.log('No forced test exits.')
}
