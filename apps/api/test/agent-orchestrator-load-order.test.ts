import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const SRC = join(__dirname, '../src')
const ORCHESTRATOR = join(
    SRC,
    'modules/agents/orchestration/agent-orchestrator.service.ts'
)

// What a module loads when it runs: the require() calls its compiled output
// makes. Transpiled one file at a time with the API's decorator settings, as
// Nest's build does, so imports used only as types are dropped and the
// classes named in constructor metadata are kept.
const loads = new Map<string, string[]>()
const loadsOf = (file: string): string[] => {
    const cached = loads.get(file)
    if (cached) return cached
    const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            isolatedModules: true
        },
        fileName: file
    })
    const found: string[] = []
    for (const [, spec] of outputText.matchAll(/require\("([^"]+)"\)/g)) {
        const base = spec.startsWith('@/')
            ? join(SRC, spec.slice(2))
            : spec.startsWith('.')
              ? resolve(dirname(file), spec)
              : null
        if (base === null) continue
        const target = [`${base}.ts`, join(base, 'index.ts')].find(existsSync)
        if (target) found.push(target)
    }
    loads.set(file, found)
    return found
}

// Nest reads the orchestrator's constructor parameters from metadata written
// while its module first runs. A module it loads that loads the orchestrator
// back leaves some module on that path half-run at that moment, so a
// parameter reads undefined and the API refuses to boot, which no unit test
// sees: tsx writes no decorator metadata. Seen on the local cloud stack
// [2026-09-29]: an adapter took a helper from create-stream, which imports
// the orchestrator, and AgentsService came out undefined.
test('nothing the agent orchestrator loads loads it back', () => {
    const cycles: string[] = []
    for (const start of loadsOf(ORCHESTRATOR)) {
        const seen = new Set<string>([start])
        const queue: string[][] = [[start]]
        while (queue.length > 0) {
            const path = queue.shift() as string[]
            for (const next of loadsOf(path[path.length - 1])) {
                if (next === ORCHESTRATOR) {
                    cycles.push(
                        [ORCHESTRATOR, ...path, ORCHESTRATOR]
                            .map((file) => relative(SRC, file))
                            .join(' → ')
                    )
                    continue
                }
                if (seen.has(next)) continue
                seen.add(next)
                queue.push([...path, next])
            }
        }
    }
    assert.deepEqual(cycles, [])
})
