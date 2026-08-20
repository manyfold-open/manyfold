// Parses untrusted .docx bytes off the main thread; the owning component
// terminates this worker if conversion exceeds PREVIEW_PARSE_TIMEOUT_MS.
// Imports are static: the iife worker bundle must stay a single chunk
import mammoth from 'mammoth'

export type DocxWorkerResponse =
    | { ok: true; html: string }
    | { ok: false; message: string }

self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
    let response: DocxWorkerResponse
    try {
        const result = await mammoth.convertToHtml({ arrayBuffer: event.data })
        response = { ok: true, html: result.value }
    } catch (err) {
        response = {
            ok: false,
            message: err instanceof Error ? err.message : String(err)
        }
    }
    self.postMessage(response)
}