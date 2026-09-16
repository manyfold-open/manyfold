import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

test('both release channels verify packaged bytes before artifact upload on native Darwin runners', () => {
    for (const [file, channel] of [
        ['release-cli.yml', 'stable'],
        ['release-cli-dev.yml', 'dev']
    ]) {
        const workflow = source(`../../../.github/workflows/${file}`)
        assert.match(workflow, new RegExp(`MF_CLI_CHANNEL: ${channel}`))
        assert.match(
            workflow,
            /matrix\.target == 'bun-darwin-x64' && 'macos-15-intel'/
        )
        assert.match(
            workflow,
            /matrix\.target == 'bun-darwin-arm64' && 'macos-15'/
        )
        const build = workflow.indexOf('node apps/cli/scripts/build-binary.mjs')
        const verify = workflow.indexOf('scripts/verify-binary-artifact.ts')
        const upload = workflow.indexOf('uses: actions/upload-artifact')
        assert.ok(build > 0 && build < verify && verify < upload, file)
    }
    const build = source('../scripts/build-binary.mjs')
    assert.ok(
        build.indexOf('signDarwinBinary(exePath)') >
            build.indexOf("'--compile'")
    )
    assert.ok(
        build.indexOf('signDarwinBinary(exePath)') <
            build.indexOf('const packageAsset')
    )
    assert.ok(
        build.indexOf('verifyDarwinBinary(join(outDir, binName))') <
            build.indexOf("execFileSync('tar'")
    )
})
