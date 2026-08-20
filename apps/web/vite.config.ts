import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { overlayResolver } from './vite-overlay'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { version } = createRequire(import.meta.url)('./package.json') as {
    version: string
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '')
    const apiTarget =
        env.MF_DEV_API_TARGET ||
        env.NCA_DEV_API_TARGET ||
        'http://localhost:2222'

    // .dockerignore excludes .git, so the plugin cannot infer a release on the
    // fly builder — CI passes the commit in as GIT_SHA instead.
    const gitSha = (process.env.GIT_SHA ?? '').slice(0, 7)
    const release = `web@${version}${gitSha ? `+${gitSha}` : ''}`
    const uploadSourcemaps = Boolean(
        process.env.SENTRY_AUTH_TOKEN &&
            process.env.SENTRY_ORG &&
            process.env.SENTRY_PROJECT
    )

    return {
        plugins: [
            // Editions same-path override (see vite-overlay.ts): inert unless
            // a cloud build sets MF_WEB_OVERLAY_DIR.
            overlayResolver(
                resolve(__dirname, 'src'),
                env.MF_WEB_OVERLAY_DIR
                    ? resolve(__dirname, env.MF_WEB_OVERLAY_DIR)
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
        esbuild: {
            // xterm 6's ESM build contains a local runtime enum in requestMode().
            // Syntax minification drops its declaration but keeps the assignment,
            // so Vim's DECRQM probe throws and terminal rendering stops.
            minifySyntax: false
        },
        resolve: {
            alias: {
                '@': resolve(__dirname, 'src'),
                '@manyfold/shared': resolve(
                    __dirname,
                    '../../packages/shared/src/index.ts'
                ),
                '@manyfold/sdk': resolve(
                    __dirname,
                    '../../packages/sdk/src/index.ts'
                ),
                '@manyfold/i18n': resolve(
                    __dirname,
                    '../../packages/i18n/src/index.ts'
                )
            }
        },
        optimizeDeps: {
            exclude: ['@manyfold/shared', '@manyfold/sdk', '@manyfold/i18n']
        },
        build: {
            // 'hidden' emits maps for the Sentry upload without leaving a
            // sourceMappingURL in the served bundles.
            sourcemap: 'hidden' as const,
            commonjsOptions: {
                include: [/node_modules/]
            }
        },
        server: {
            // MF_DEV_HOST (just dev-host) binds 0.0.0.0; allow Tailscale magic-DNS names
            host: Boolean(process.env.MF_DEV_HOST || process.env.NCA_DEV_HOST),
            allowedHosts: ['.ts.net'],
            port: 3002,
            proxy: {
                '/api': {
                    target: apiTarget,
                    changeOrigin: true,
                    ws: true,
                    secure: true
                }
            }
        }
    }
})
