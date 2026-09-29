import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

// A real child process running `mf` from source: for stdin, exit codes and
// signals, which an in-process run cannot show.

const cliDir = resolve(import.meta.dirname, '../..')

export const spawnMf = (args: string[], env: Record<string, string>) =>
    spawn(
        process.execPath,
        [
            '--import',
            'tsx',
            '--import',
            './test/md-text-loader.mjs',
            'src/index.ts',
            ...args
        ],
        {
            cwd: cliDir,
            env: {
                PATH: process.env.PATH ?? '',
                TSX_TSCONFIG_PATH: join(cliDir, 'tsconfig.json'),
                ...env
            },
            stdio: ['pipe', 'pipe', 'pipe']
        }
    )
