import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node20',
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    // noExternal bundles @manyfold/* (compiled CommonJS) into this ESM output;
    // their require('node:net')/require('undici') need a real require or
    // esbuild's shim throws "Dynamic require not supported" at runtime.
    banner: {
        js: [
            '#!/usr/bin/env node',
            "import { createRequire as __mfCreateRequire } from 'node:module'",
            'const require = __mfCreateRequire(import.meta.url)'
        ].join('\n')
    },
    shims: false,
    dts: false,
    noExternal: [/^@manyfold\//, 'undici'],
    external: ['node-pty'],
    loader: {
        '.md': 'text'
    },
    define: {
        __MF_CLI_VERSION__: JSON.stringify(
            process.env.MF_CLI_VERSION ?? pkg.version
        ),
        __MF_CLI_CHANNEL__: JSON.stringify(
            process.env.MF_CLI_CHANNEL ?? 'stable'
        ),
        // The source commit is the canonical build identity: consecutive dev
        // builds share a base version, so this is what orders the dev channel.
        // A local build carries neither and reports itself as a source build.
        __MF_CLI_COMMIT__: JSON.stringify(process.env.MF_CLI_COMMIT ?? ''),
        __MF_CLI_BUILD_TIME__: JSON.stringify(
            process.env.MF_CLI_BUILD_TIME ?? ''
        )
    }
})
