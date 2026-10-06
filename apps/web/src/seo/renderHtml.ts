import type { ReactNode } from 'react'
import { renderToPipeableStream } from 'react-dom/server'
import { Writable } from 'node:stream'

// A tree's HTML once every Suspense boundary has resolved (onAllReady, not
// the shell), so a lazy marketing route is in the page rather than its
// fallback. Any render error rejects, which fails the build.
//
// The bytes are decoded once and cleared of the NUL bytes react-dom 18
// leaves in them: its Node stream flushes the whole 2 KB view when a string
// overflows it, so a character too wide for the bytes still free leaves
// those bytes in the output as zeros. Seen on a local build [2026-10-06]:
// NUL bytes inside /zh/'s Chinese copy. Markup has none of its own.
export const renderHtml = (tree: ReactNode): Promise<string> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        const sink = new Writable({
            write(chunk: Buffer, _encoding, done) {
                chunks.push(chunk)
                done()
            }
        })
        sink.on('finish', () =>
            resolve(
                Buffer.concat(chunks).toString('utf8').replaceAll('\u0000', '')
            )
        )
        const { pipe } = renderToPipeableStream(tree, {
            onAllReady: () => pipe(sink),
            onShellError: reject,
            onError: reject
        })
    })
