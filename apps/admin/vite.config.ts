import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
// One overlay mechanism for both SPAs — the plugin is generic and lives with
// its unit tests beside the web config.
import { overlayResolver } from '../web/vite-overlay'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { version } = createRequire(import.meta.url)('./package.json') as {
    version: string
}

// .dockerignore excludes .git, so the plugin cannot infer a release on the fly
// builder — CI passes the commit in as GIT_SHA instead.
const gitSha = (process.env.GIT_SHA ?? '').slice(0, 7)
const release = `admin@${version}${gitSha ? `+${gitSha}` : ''}`
const uploadSourcemaps = Boolean(
    process.env.SENTRY_AUTH_TOKEN &&
        process.env.SENTRY_ORG &&
        process.env.SENTRY_PROJECT
)

export default defineConfig({
    plugins: [
        // Editions same-path override (apps/web/vite-overlay.ts): inert unless
        // a cloud build sets MF_ADMIN_OVERLAY_DIR.
        overlayResolver(
            resolve(__dirname, 'src'),
            process.env.MF_ADMIN_OVERLAY_DIR
                ? resolve(__dirname, process.env.MF_ADMIN_OVERLAY_DIR)
                : undefined
        ),
        react(),
        sentryVitePlugin({
            disable: !uploadSourcemaps,
            telemetry: false,
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            authToken: process.env.SENTRY_AUTH_TOKEN,
            release: { name: release, inject: false },
            sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] }
        })
    ],
    define: {
        'import.meta.env.VITE_SENTRY_RELEASE': JSON.stringify(release)
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src'),
            '@manyfold/i18n': resolve(
                __dirname,
                '../../packages/i18n/src/index.ts'
            ),
            '@manyfold/shared': resolve(
                __dirname,
                '../../packages/shared/src/index.ts'
            ),
            '@manyfold/sdk': resolve(
                __dirname,
                '../../packages/sdk/src/index.ts'
            )
        }
    },
    optimizeDeps: {
        exclude: ['@manyfold/shared', '@manyfold/sdk', '@manyfold/i18n']
    },
    build: {
        // 'hidden' emits maps for the Sentry upload without leaving a
        // sourceMappingURL in the served bundles.
        sourcemap: 'hidden',
        commonjsOptions: {
            include: [/node_modules/]
        }
    },
    server: {
        // MF_DEV_HOST (just dev-host) binds 0.0.0.0; allow Tailscale magic-DNS names
        host: Boolean(process.env.MF_DEV_HOST || process.env.NCA_DEV_HOST),
        allowedHosts: ['.ts.net'],
        port: 3001,
        proxy: {
            '/api': {
                target: 'http://localhost:2222',
                changeOrigin: true,
                ws: true
            }
        }
    }
})
