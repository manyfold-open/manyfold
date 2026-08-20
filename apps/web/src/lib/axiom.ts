import { Axiom } from '@axiomhq/js'
import { AxiomJSTransport, ConsoleTransport, Logger } from '@axiomhq/logging'
import { createWebVitalsComponent } from '@axiomhq/react'

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
        app: 'web',
        env:
            (import.meta.env.VITE_MF_ENV as string | undefined) ||
            (import.meta.env.VITE_NCA_ENV as string | undefined) ||
            (import.meta.env.DEV ? 'local' : 'production')
    },
    transports: transports as [
        (typeof transports)[number],
        ...(typeof transports)[number][]
    ]
})

export const WebVitals = createWebVitalsComponent(logger)
