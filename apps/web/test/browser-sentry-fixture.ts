import { resolve } from 'node:path'
import { build, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { overlayResolver } from '../vite-overlay'

interface FixtureOptions {
    coreRoot: string
    surface: 'web' | 'admin'
    dsn: string
    queryParam: string
    capture: 'app' | 'history'
    overlayRoot?: string
    sourceOverrides?: Record<string, string>
}

export const buildSentryBrowserFixture = async (
    options: FixtureOptions
): Promise<string> => {
    const appRoot = resolve(options.coreRoot, 'apps', options.surface)
    const src = resolve(appRoot, 'src')
    const entry = 'virtual:browser-sentry-fixture'
    const capture = 'virtual:browser-sentry-capture'
    const attributionImport =
        options.surface === 'web'
            ? "import { attributionTokens } from '@/lib/attribution'"
            : ''
    const gaImport =
        options.surface === 'web'
            ? "import { gaPageLocation } from '@/lib/googleAnalyticsUrl'"
            : ''
    const virtual: Plugin = {
        name: 'browser-sentry-fixture',
        enforce: 'pre',
        resolveId(id) {
            if (id === entry || id === capture) return '\0' + id
        },
        load(id) {
            if (options.sourceOverrides?.[id])
                return options.sourceOverrides[id]
            if (id === '\0' + capture)
                return `
                ${options.surface === 'web' ? "import '@/lib/attribution'" : ''}
                ${
                    options.capture === 'history'
                        ? `
                    const url = new URL(location.href)
                    url.searchParams.delete(${JSON.stringify(options.queryParam)})
                    history.replaceState(history.state, '', url.pathname + url.search + url.hash)
                `
                        : ''
                }
            `
            if (id !== '\0' + entry) return
            return `
                import '${capture}'
                import { Sentry } from '@/lib/sentry'
                ${attributionImport}
                ${gaImport}
                const navigation = performance.getEntriesByType('navigation')[0]
                const pageLoad = Sentry.getActiveSpan()
                if (!pageLoad) throw new Error('No Sentry pageload span')
                const original = new URL(navigation.name)
                const marker = original.searchParams.get(${JSON.stringify(options.queryParam)})
                const callbacks = { span: 0, event: 0, transaction: 0, spanLeak: false, finalLeak: false, internalMetadataMarker: false, markerFields: [] }
                const clientOptions = Sentry.getClient().getOptions()
                for (const [name, counter] of [['beforeSendSpan', 'span'], ['beforeSend', 'event'], ['beforeSendTransaction', 'transaction']]) {
                    const callback = clientOptions[name]
                    if (!callback) continue
                    clientOptions[name] = (...args) => {
                        const result = callback(...args)
                        callbacks[counter]++
                        // The SDK removes this private field when it creates the envelope.
                        // The receiver still checks every transmitted byte, including headers.
                        const exported = { ...result }
                        if (counter !== 'span') {
                            if (JSON.stringify(exported.sdkProcessingMetadata)?.includes(marker)) callbacks.internalMetadataMarker = true
                            delete exported.sdkProcessingMetadata
                        }
                        if (JSON.stringify(exported).includes(marker)) {
                            callbacks[counter === 'span' ? 'spanLeak' : 'finalLeak'] = true
                            for (const [field, value] of Object.entries(exported))
                                if (JSON.stringify(value)?.includes(marker)) callbacks.markerFields.push(counter + '.' + field)
                        }
                        return result
                    }
                }
                Sentry.setUser({ id: 'browser-privacy-fixture' })
                pageLoad.setAttribute('url.full', navigation.name)
                pageLoad.setAttribute('http.query', original.search.slice(1))
                Sentry.addBreadcrumb({ category: 'navigation', message: 'GET ' + navigation.name,
                    data: { from: navigation.name, to: navigation.name, 'http.query': original.search.slice(1) } })
                Sentry.startSpan({ name: navigation.name, op: 'fixture.child',
                    attributes: { 'url.full': navigation.name, 'http.query': original.search.slice(1) } }, () => {})
                Sentry.captureException(new Error('Browser privacy fixture'))
                window.__privacySnapshot = {
                    sdkVersion: Sentry.SDK_VERSION,
                    callbacks,
                    navigationName: navigation.name,
                    location: location.href,
                    tokens: ${options.surface === 'web' ? 'attributionTokens()' : 'null'},
                    gaLocation: ${options.surface === 'web' ? 'gaPageLocation(original.origin, original.pathname, original.search)' : 'null'}
                }
                window.__privacyFinish = async () => {
                    pageLoad.end()
                    return Sentry.flush(10000)
                }
            `
        }
    }
    const output = await build({
        configFile: false,
        envDir: false,
        root: appRoot,
        logLevel: 'error',
        plugins: [
            virtual,
            overlayResolver(
                src,
                options.overlayRoot
                    ? resolve(
                          options.overlayRoot,
                          'apps',
                          options.surface + '-cloud',
                          'src'
                      )
                    : undefined
            ),
            react()
        ],
        define: {
            'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(options.dsn),
            'import.meta.env.VITE_MF_ENV': JSON.stringify('local'),
            'import.meta.env.VITE_SENTRY_RELEASE': JSON.stringify(
                'browser-privacy-fixture'
            )
        },
        resolve: {
            alias: {
                '@': src,
                '@manyfold/shared': resolve(
                    options.coreRoot,
                    'packages/shared/src/index.ts'
                ),
                '@manyfold/sdk': resolve(
                    options.coreRoot,
                    'packages/sdk/src/index.ts'
                ),
                '@manyfold/i18n': resolve(
                    options.coreRoot,
                    'packages/i18n/src/index.ts'
                )
            }
        },
        build: {
            write: false,
            minify: false,
            sourcemap: false,
            rollupOptions: {
                input: entry,
                output: {
                    inlineDynamicImports: true,
                    entryFileNames: 'entry.js'
                }
            }
        }
    })
    if ('on' in output) throw new Error('Unexpected watch build')
    const outputs = Array.isArray(output) ? output : [output]
    const chunk = outputs
        .flatMap((result) => result.output)
        .find((item) => item.type === 'chunk' && item.isEntry)
    if (!chunk || chunk.type !== 'chunk')
        throw new Error('Missing fixture entry')
    return chunk.code
}
