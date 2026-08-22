import { Zip, ZipDeflate, strToU8 } from 'fflate'
import type { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'

// How many NDJSON lines an entry buffers inside fflate before the compressed
// output is drained to the sink. Keeps memory bounded for large domains
// (chat history) without paying a backpressure wait per row.
const FLUSH_EVERY = 64

export interface ExportEntryWriter {
    write(value: unknown): Promise<void>
    end(): Promise<void>
}

// Streams a zip to any Writable via fflate's incremental Zip — the api
// already depends on fflate (library-skills archives), so the takeout bundle
// is a real .zip with zero new dependencies. Entries are written strictly
// one at a time; compressed chunks queue in the ondata callback and flush()
// drains them honouring the sink's backpressure, so neither a whole domain
// nor the whole archive ever materialises in memory.
export class ExportBundleWriter {
    private readonly zip: Zip
    private readonly queued: Uint8Array[] = []
    private failure: Error | null = null
    readonly entryNames: string[] = []

    constructor(private readonly out: Writable) {
        this.zip = new Zip((err, chunk, _final) => {
            if (err) {
                this.failure = this.failure ?? err
                return
            }
            if (chunk.length > 0) this.queued.push(chunk)
        })
        this.out.once('error', (err) => {
            this.failure = this.failure ?? err
        })
    }

    // NDJSON entry: one JSON document per line.
    entry(name: string): ExportEntryWriter {
        const file = this.open(name)
        let sinceFlush = 0
        return {
            write: async (value) => {
                file.push(strToU8(`${JSON.stringify(value)}\n`))
                sinceFlush += 1
                if (sinceFlush >= FLUSH_EVERY) {
                    sinceFlush = 0
                    await this.flush()
                }
            },
            end: async () => {
                file.push(new Uint8Array(0), true)
                await this.flush()
            }
        }
    }

    async json(name: string, value: unknown): Promise<void> {
        const file = this.open(name)
        file.push(strToU8(JSON.stringify(value, null, 2)), true)
        await this.flush()
    }

    async finish(): Promise<void> {
        this.zip.end()
        await this.flush()
        this.out.end()
        await finished(this.out)
    }

    private open(name: string): ZipDeflate {
        this.entryNames.push(name)
        const file = new ZipDeflate(name, { level: 6 })
        this.zip.add(file)
        return file
    }

    private async flush(): Promise<void> {
        while (this.queued.length > 0) {
            if (this.failure) throw this.failure
            const chunk = this.queued.shift()!
            if (!this.out.write(chunk)) await this.drained()
        }
        if (this.failure) throw this.failure
    }

    private drained(): Promise<void> {
        return new Promise((resolve, reject) => {
            const onDrain = (): void => {
                this.out.off('error', onError)
                resolve()
            }
            const onError = (err: Error): void => {
                this.out.off('drain', onDrain)
                reject(err)
            }
            this.out.once('drain', onDrain)
            this.out.once('error', onError)
        })
    }
}
