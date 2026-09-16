import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function prepareRuntimeWorkspace(projects, name, source, destination) {
    source = fs.realpathSync(source)
    assert.ok(
        !fs.existsSync(destination),
        'runtime workspace must be a new directory'
    )
    assert.ok(
        projects.some((project) => project.name === name),
        `missing ${name}`
    )
    fs.mkdirSync(destination, { recursive: true })
    for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'])
        fs.copyFileSync(path.join(source, file), path.join(destination, file))
    const manifest = JSON.parse(
        fs.readFileSync(path.join(source, 'package.json'), 'utf8')
    )
    // Root lifecycle hooks configure development tools (husky), which are not
    // installed in a production workspace. Dependency declarations stay exact.
    delete manifest.scripts
    fs.writeFileSync(
        path.join(destination, 'package.json'),
        JSON.stringify(manifest)
    )
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-pack-'))
    try {
        for (const project of projects) {
            const relative = path.relative(source, project.path)
            assert.ok(
                relative &&
                    !relative.startsWith('..') &&
                    !path.isAbsolute(relative),
                `workspace package outside source: ${project.path}`
            )
            const target = path.join(destination, relative)
            fs.mkdirSync(target, { recursive: true })
            if (project.name !== name) {
                const archive = path.join(temporary, 'package.tgz')
                const packed = spawnSync(
                    'pnpm',
                    ['--config.ignore-scripts=true', 'pack', '--out', archive],
                    { cwd: project.path, encoding: 'utf8' }
                )
                assert.equal(packed.status, 0, packed.stderr + packed.stdout)
                const extracted = spawnSync(
                    'tar',
                    ['-xzf', archive, '--strip-components=1', '-C', target],
                    { encoding: 'utf8' }
                )
                assert.equal(extracted.status, 0, extracted.stderr)
            }
            // Packing selects the published files, but rewrites workspace:*
            // specifiers. Frozen installation needs the original declaration.
            fs.copyFileSync(
                path.join(project.path, 'package.json'),
                path.join(target, 'package.json')
            )
        }
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true })
    }
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    const [graphFile, name, destination] = process.argv.slice(2)
    assert.ok(
        graphFile && name && destination,
        'usage: prepare-runtime-workspace.mjs <pnpm-list-lockfile.json> <package> <destination>'
    )
    prepareRuntimeWorkspace(
        JSON.parse(fs.readFileSync(graphFile, 'utf8')),
        name,
        process.cwd(),
        destination
    )
}
