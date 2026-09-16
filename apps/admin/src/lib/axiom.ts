import { Axiom } from '@axiomhq/js'
import { AxiomJSTransport, ConsoleTransport, Logger } from '@axiomhq/logging'
import { useReportWebVitals } from '@axiomhq/react'
import { useRef } from 'react'
import { createBrowserTelemetry, reportBrowserWebVital } from '@manyfold/shared'

const token = import.meta.env.VITE_AXIOM_TOKEN as string | undefined
const dataset =
    (import.meta.env.VITE_AXIOM_DATASET as string | undefined) ?? 'nca-frontend'

const transports = token
    ? [
          new AxiomJSTransport({ axiom: new Axiom({ token }), dataset }),
          new ConsoleTransport({ prettyPrint: import.meta.env.DEV })
      ]
    : [new ConsoleTransport({ prettyPrint: true })]

export const logger = new Logger({
    args: {
        app: 'admin',
        env:
            (import.meta.env.VITE_MF_ENV as string | undefined) ||
            (import.meta.env.DEV ? 'local' : 'production')
    },
    transports: transports as [
        (typeof transports)[number],
        ...(typeof transports)[number][]
    ]
})

export const browserTelemetry: ReturnType<typeof createBrowserTelemetry> = createBrowserTelemetry(logger, {
    origin: window.location.origin
})

export const WebVitals = (): null => {
    const pathname = useRef(window.location.pathname)
    useReportWebVitals(
        metric => reportBrowserWebVital(logger, metric, pathname.current),
        () => { void browserTelemetry.flush() }
    )
    return null
}
