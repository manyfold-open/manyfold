import { execFileSync } from 'node:child_process'

export const DARWIN_IDENTIFIER = 'ai.manyfold.mf'

export const verifyDarwinBinary = (binary) => {
    // -R checks the actual identifier without parsing diagnostic output.
    execFileSync(
        'codesign',
        [
            '--verify',
            '--strict',
            '-R',
            `=identifier "${DARWIN_IDENTIFIER}"`,
            binary
        ],
        {
            stdio: 'pipe'
        }
    )
}

export const signDarwinBinary = (binary) => {
    if (process.platform !== 'darwin')
        throw new Error(
            'Darwin release artifacts require a macOS codesign runner'
        )
    execFileSync(
        'codesign',
        [
            '--force',
            '--sign',
            '-',
            '--identifier',
            DARWIN_IDENTIFIER,
            '--preserve-metadata=entitlements',
            binary
        ],
        {
            stdio: 'inherit'
        }
    )
    verifyDarwinBinary(binary)
}
