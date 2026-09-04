import { Injectable } from '@nestjs/common'
import type { CandidateFileHead, CandidateIndexEntry } from './candidate-scan'

interface CachedFile {
    mtimeMs: number
    size: number
    value: unknown
}

interface AgentFiles {
    byPath: Map<string, CachedFile>
    touchedAt: number
}

const MAX_AGENTS = 256

// Per-process memory of what each agent's transcripts summarized to, keyed by
// the (mtime, size) the file had when it was read. A transcript that has not
// changed yields the same row, so a repeat scan only reads the files the
// index shows as new or grown — normally just the live session's.
//
// Deliberately not a table: nothing here outlives a re-read of the file, a
// cold process simply pays the fetch once per agent, and the API runs one
// machine by default (fly.api.toml min_machines_running = 1). Bounded by the
// index itself — retain() drops paths no longer on the runtime — plus an
// agent count cap for a long-lived process.
@Injectable()
export class CandidateScanCache {
    private readonly agents = new Map<string, AgentFiles>()
    private readonly inflight = new Map<string, Promise<unknown>>()

    // Entries whose file is byte-for-byte what was summarized before, with
    // that summary (null for a file that carried no session id).
    lookup<T>(
        agentId: string,
        entries: CandidateIndexEntry[]
    ): Map<string, T | null> {
        const hits = new Map<string, T | null>()
        const agent = this.agents.get(agentId)
        if (!agent) return hits
        agent.touchedAt = Date.now()
        for (const entry of entries) {
            const cached = agent.byPath.get(entry.path)
            if (
                cached &&
                cached.mtimeMs === entry.mtimeMs &&
                cached.size === entry.size
            )
                hits.set(entry.path, cached.value as T | null)
        }
        return hits
    }

    store(
        agentId: string,
        heads: CandidateFileHead[],
        values: (unknown | null)[]
    ): void {
        const agent = this.touch(agentId)
        heads.forEach((head, i) => {
            agent.byPath.set(head.path, {
                mtimeMs: head.mtimeMs,
                size: head.size,
                value: values[i] ?? null
            })
        })
    }

    retain(agentId: string, index: CandidateIndexEntry[]): void {
        const agent = this.agents.get(agentId)
        if (!agent) return
        const live = new Set(index.map((entry) => entry.path))
        for (const path of agent.byPath.keys())
            if (!live.has(path)) agent.byPath.delete(path)
    }

    // Two panels asking for the same list at once share one scan rather than
    // running two execs against the same runtime.
    singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const running = this.inflight.get(key)
        if (running) return running as Promise<T>
        const promise = fn().finally(() => {
            this.inflight.delete(key)
        })
        this.inflight.set(key, promise)
        return promise
    }

    private touch(agentId: string): AgentFiles {
        let agent = this.agents.get(agentId)
        if (!agent) {
            if (this.agents.size >= MAX_AGENTS) this.evictColdest()
            agent = { byPath: new Map(), touchedAt: 0 }
            this.agents.set(agentId, agent)
        }
        agent.touchedAt = Date.now()
        return agent
    }

    private evictColdest(): void {
        let coldest: string | null = null
        let coldestAt = Number.POSITIVE_INFINITY
        for (const [agentId, agent] of this.agents) {
            if (agent.touchedAt < coldestAt) {
                coldest = agentId
                coldestAt = agent.touchedAt
            }
        }
        if (coldest !== null) this.agents.delete(coldest)
    }
}
