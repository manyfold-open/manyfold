import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

// A provider is an adapter (ADR-0037): its SDK, its clients and its own
// helpers live in hosts/providers (and the Kubernetes plumbing in modules/k8s),
// and everything else reaches a machine through the adapter contract or the
// machine's daemon. Two rules:
//   - a provider SDK or client is imported only inside the zone;
//   - outside it, only the contract files of hosts/providers are imported —
//     plus the hosts module, which registers the adapters.
const ZONE = ['modules/hosts/providers/', 'modules/k8s/']

const SDKS = [
    '@manyfold/sprites',
    '@manyfold/k8s-exec-core',
    '@kubernetes/client-node',
    'modules/k8s/pod-exec',
    'modules/k8s/kubernetes.service',
    'modules/k8s/gateway-exec.client'
]

const CONTRACT = new Set([
    'modules/hosts/providers/sandbox-provider',
    'modules/hosts/providers/host-provider-resolver.service',
    'modules/hosts/providers/host-placement.service',
    'modules/hosts/providers/generation'
])

const COMPOSITION: Record<string, string> = {
    'modules/hosts/hosts.module.ts':
        'registers the adapters and keeps their clients inside the module'
}

const SRC = join(__dirname, '../src')

const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return sources(path)
        return path.endsWith('.ts') ? [path] : []
    })

// Every module a file imports, type-only included: `@/x` and relative
// specifiers become paths under src, packages stay as named.
const importsOf = (path: string, rel: string): string[] => {
    const file = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        false
    )
    const specifiers: string[] = []
    const visit = (node: ts.Node): void => {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
        )
            specifiers.push(node.moduleSpecifier.text)
        if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0])
        )
            specifiers.push(node.arguments[0].text)
        ts.forEachChild(node, visit)
    }
    visit(file)
    return specifiers.map((spec) => {
        if (spec.startsWith('@/')) return spec.slice(2)
        if (spec.startsWith('.'))
            return normalize(join(dirname(rel), spec)).split('\\').join('/')
        return spec
    })
}

const inZone = (rel: string): boolean =>
    ZONE.some((prefix) => rel.startsWith(prefix))

test('provider SDKs and adapter internals stay inside the adapter zone', () => {
    const violations: string[] = []
    for (const path of sources(SRC)) {
        const rel = relative(SRC, path).split('\\').join('/')
        if (inZone(rel) || COMPOSITION[rel]) continue
        for (const target of importsOf(path, rel)) {
            if (SDKS.includes(target))
                violations.push(`${rel} imports ${target}`)
            else if (
                target.startsWith('modules/hosts/providers/') &&
                !CONTRACT.has(target)
            )
                violations.push(`${rel} imports adapter internals ${target}`)
        }
    }
    assert.deepEqual(violations, [])
})

test('the composition allowance is still needed', () => {
    for (const rel of Object.keys(COMPOSITION)) {
        const imports = importsOf(join(SRC, rel), rel)
        assert.ok(
            imports.some(
                (target) =>
                    target.startsWith('modules/hosts/providers/') &&
                    !CONTRACT.has(target)
            ),
            `${rel} no longer imports adapter internals; drop it from COMPOSITION`
        )
    }
})
