import { Injectable, Logger } from '@nestjs/common'

export type CapabilityProbe = () => boolean | Promise<boolean>

// Composition-root-derived feature discovery: a capability key exists because
// the module owning it was wired into this root (commercial modules register
// theirs, so an open-source root simply lacks them), and its value comes from
// a runtime probe when availability depends on configuration. Consumers get
// presence/absence only — never pricing or plan logic.
@Injectable()
export class CapabilitiesRegistry {
    private readonly log = new Logger(CapabilitiesRegistry.name)
    private readonly entries = new Map<string, CapabilityProbe>()

    register(key: string, probe: CapabilityProbe = () => true): void {
        if (this.entries.has(key))
            throw new Error(`capability '${key}' registered twice`)
        this.entries.set(key, probe)
    }

    has(key: string): boolean {
        return this.entries.has(key)
    }

    // Probe failures read as "unavailable": this feeds UI visibility, and a
    // broken integration should hide its feature, not break discovery.
    async snapshot(): Promise<Record<string, boolean>> {
        const out: Record<string, boolean> = {}
        for (const key of [...this.entries.keys()].sort()) {
            const probe = this.entries.get(key)
            if (!probe) continue
            try {
                out[key] = Boolean(await probe())
            } catch (err) {
                this.log.warn(
                    `capability probe '${key}' failed: ${(err as Error).message}`
                )
                out[key] = false
            }
        }
        return out
    }
}
