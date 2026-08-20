import type { AgentFramework } from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import { ClaudeCodeSessionReader } from './claude-code-reader'
import { CodexSessionReader } from './codex-reader'
import { GeminiCliSessionReader } from './gemini-reader'
import { HermesSessionReader } from './hermes-reader'
import { OpenclawSessionReader } from './openclaw-reader'
import type { SessionReader } from './types'

export type {
    CandidateContext,
    CandidateSession,
    ReaderContext,
    ReaderResult,
    RecoveredMessage,
    RecoveredRawSource,
    RecoveryParentLink,
    RecoverySummary,
    SessionReader
} from './types'

@Injectable()
export class SessionReaderRegistry {
    private readonly readers: Partial<Record<AgentFramework, SessionReader>> = {
        'claude-code': new ClaudeCodeSessionReader(),
        codex: new CodexSessionReader(),
        'gemini-cli': new GeminiCliSessionReader(),
        openclaw: new OpenclawSessionReader(),
        hermes: new HermesSessionReader()
    }

    get(framework: AgentFramework): SessionReader | null {
        return this.readers[framework] ?? null
    }
}
