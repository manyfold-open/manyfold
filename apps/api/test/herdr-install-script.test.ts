import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    buildHerdrInstallScript,
    HERDR_INSTALL_MARKER
} from '../src/modules/agent-self/sprite-shell-env.service'

// The script a sandbox runs to get herdr (ADR-0031), executed for real in a
// throwaway HOME: `curl` is a stub that serves an installer writing a fake
// herdr into HERDR_INSTALL_DIR, the way herdr's own installer does.
const CURL_STUB = `#!/bin/sh
cat <<'INSTALLER'
mkdir -p "$HERDR_INSTALL_DIR"
printf '#!/bin/sh\\necho "herdr 0.9.1"\\n' > "$HERDR_INSTALL_DIR/herdr"
chmod +x "$HERDR_INSTALL_DIR/herdr"
INSTALLER
`

const runInstall = (home: string): string => {
    const bin = join(home, 'stub-bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'curl'), CURL_STUB, { mode: 0o755 })
    return execFileSync('bash', ['-c', buildHerdrInstallScript()], {
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
        encoding: 'utf8'
    })
}

const withHome = (fn: (home: string) => void): void => {
    const home = mkdtempSync(join(tmpdir(), 'mf-herdr-install-'))
    try {
        fn(home)
    } finally {
        rmSync(home, { recursive: true, force: true })
    }
}

test('a fresh sandbox gets herdr, its version line, and the welcome marked seen', () => {
    withHome((home) => {
        const out = runInstall(home)
        assert.match(out, /herdr-installed=herdr 0\.9\.1/)
        assert.ok(out.includes(HERDR_INSTALL_MARKER))
        assert.equal(
            readFileSync(join(home, '.config/herdr/config.toml'), 'utf8'),
            'onboarding = false\n'
        )
    })
})

test('a sandbox whose herdr already has a config keeps it untouched', () => {
    withHome((home) => {
        mkdirSync(join(home, '.config/herdr'), { recursive: true })
        const mine = 'onboarding = true\n\n[ui.toast]\ndelivery = "herdr"\n'
        writeFileSync(join(home, '.config/herdr/config.toml'), mine)
        runInstall(home)
        assert.equal(
            readFileSync(join(home, '.config/herdr/config.toml'), 'utf8'),
            mine
        )
    })
})
