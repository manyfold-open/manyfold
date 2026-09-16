import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

// pnpm supplies the resolved graph, including peer contexts. This checker
// only follows those edges through Node's actual package lookup locations.
export function checkRuntimeDependencies(
    projects,
    name,
    directory,
    workspaceDirectory = directory,
    packageMetadata = {}
) {
    const platform = {
        os: process.platform,
        cpu: process.arch,
        libc:
            process.platform === 'linux'
                ? process.report.getReport().header.glibcVersionRuntime
                    ? 'glibc'
                    : 'musl'
                : undefined
    }
    const exclusions = (metadata) =>
        Object.entries(platform).flatMap(([field, current]) => {
            const allowed = metadata?.[field]
            if (!allowed?.length || allowed.includes('any')) return []
            const positive = allowed.filter((value) => !value.startsWith('!'))
            const incompatible =
                allowed.includes(`!${current}`) ||
                (positive.length > 0 && !positive.includes(current))
            return incompatible
                ? [
                      `${field}=${current ?? 'none'} excluded by ${allowed.join(',')}`
                  ]
                : []
        })
    const runtimeRoot = fs.realpathSync(workspaceDirectory)
    const nodes = new Map()
    const collect = (node) => {
        if (!nodes.has(node.path) || node.dependencies)
            nodes.set(node.path, node)
        for (const child of Object.values(node.dependencies ?? {}))
            collect(child)
        for (const child of Object.values(node.optionalDependencies ?? {}))
            collect(child)
    }
    projects.forEach(collect)
    const root = projects.find((project) => project.name === name)
    assert.ok(root, `locked graph does not contain ${name}`)
    const visited = new Set()
    const graph = []
    const missingOptional = []
    const locate = (parent, dependency) => {
        const require = createRequire(path.join(parent, 'package.json'))
        for (const modules of require.resolve.paths(
            `${dependency}/package.json`
        ) ?? []) {
            const candidate = path.join(modules, dependency, 'package.json')
            if (fs.existsSync(candidate))
                return fs.realpathSync(path.dirname(candidate))
        }
        return null
    }
    const visit = (expected, actualDir) => {
        expected = nodes.get(expected.path)
        actualDir = fs.realpathSync(actualDir)
        const relative = path.relative(runtimeRoot, actualDir)
        assert.ok(
            relative !== '..' && !relative.startsWith(`..${path.sep}`),
            `${actualDir}: dependency resolves outside the runtime`
        )
        const key = `${expected.path}\0${actualDir}`
        if (visited.has(key)) return
        visited.add(key)
        const actual = readJson(path.join(actualDir, 'package.json'))
        const workspace = projects.find(
            (project) => project.path === expected.path
        )
        const expectedName = workspace?.name ?? expected.from
        const expectedVersion = workspace?.version ?? expected.version
        assert.equal(
            actual.name,
            expectedName,
            `${actualDir}: package identity drift`
        )
        assert.equal(
            actual.version,
            expectedVersion,
            `${actual.name}: version drift`
        )
        const dependencies = {
            ...expected.dependencies,
            ...expected.optionalDependencies
        }
        const optional = (dependency) =>
            Object.hasOwn(actual.optionalDependencies ?? {}, dependency) ||
            actual.peerDependenciesMeta?.[dependency]?.optional === true
        const edges = {}
        for (const [dependency, child] of Object.entries(dependencies)) {
            const childDir = locate(actualDir, dependency)
            if (!childDir && optional(dependency)) {
                const reasons = exclusions(
                    packageMetadata[`${child.from}@${child.version}`]
                )
                assert.ok(
                    reasons.length > 0,
                    `${actual.name}: missing platform-compatible optional dependency ${dependency}`
                )
                missingOptional.push({
                    from: `${actual.name}@${actual.version}`,
                    dependency,
                    version: child.version,
                    reasons
                })
                continue
            }
            assert.ok(
                childDir,
                `${actual.name}: missing production dependency ${dependency}`
            )
            const childManifest = readJson(path.join(childDir, 'package.json'))
            edges[dependency] = `${childManifest.name}@${childManifest.version}`
            visit(child, childDir)
        }
        // Check every declared production edge, not just the ones that happen
        // to survive in the deployed lockfile or share a version with any lock entry.
        for (const dependency of Object.keys({
            ...actual.dependencies,
            ...actual.optionalDependencies,
            ...actual.peerDependencies
        })) {
            if (Object.hasOwn(dependencies, dependency)) continue
            if (
                actual.peerDependenciesMeta?.[dependency]?.optional &&
                !locate(actualDir, dependency)
            )
                continue
            assert.fail(
                `${actual.name}: unlocked production edge ${dependency}`
            )
        }
        graph.push({
            name: actual.name,
            version: actual.version,
            dependencies: edges
        })
    }
    visit(root, directory)
    return { root: name, platform, graph, missingOptional }
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    const [graphFile, name, directory, workspaceDirectory] =
        process.argv.slice(2)
    assert.ok(
        graphFile && name && directory,
        'usage: check-runtime-deps.mjs <pnpm-list-lockfile.json> <package> <runtime-dir>'
    )
    const result = checkRuntimeDependencies(
        readJson(graphFile),
        name,
        directory,
        workspaceDirectory,
        parse(fs.readFileSync('pnpm-lock.yaml', 'utf8')).packages
    )
    console.log(
        `runtime-deps: ${result.graph.length} resolved package contexts match the locked production graph (${result.missingOptional.length} absent optional edges)`
    )
    fs.writeFileSync(
        path.join(directory, 'runtime-deps.json'),
        JSON.stringify(result, null, 2) + '\n'
    )
}
