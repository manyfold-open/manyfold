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
        // Dev-channel endpoints are deployment-private; the release workflows
        // that operate one bake them in, a bare build has no dev channel.
        __MF_CLI_STAGING_API_URL__: JSON.stringify(
            process.env.MF_CLI_STAGING_API_URL ?? ''
        ),
        __MF_CLI_STAGING_CDN_BASE__: JSON.stringify(
            process.env.MF_CLI_STAGING_CDN_BASE ?? ''
        )
    }
})
