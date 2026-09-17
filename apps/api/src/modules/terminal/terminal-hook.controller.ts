import {
    TERMINAL_HOOK_EVENTS,
    TERMINAL_HOOK_FRAMEWORKS,
    TERMINAL_HOOK_SOURCES,
    type TerminalSessionHookRequest,
    type TerminalSessionHookResponse
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    HttpCode,
    Post,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { ShareRateLimitService } from '@/common/share-rate-limit.service'
import { TerminalHookService } from '@/modules/terminal/terminal-hook.service'
import { TerminalSessionsRepository } from '@/modules/terminal/terminal-sessions.repository'

// Framework session ids are UUIDs (claude) or `thr_…`-style ids (codex):
// bounded, no separators a path or a log line would misread.
const SESSION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,199}$/
const CWD_MAX_LENGTH = 4096
// A TUI starts and ends a handful of sessions an hour; anything faster is a
// loop, not a user.
const REPORTS_PER_MINUTE = 60

const oneOf = <T extends string>(
    values: readonly T[],
    value: unknown,
    field: string
): T => {
    if (
        typeof value === 'string' &&
        (values as readonly string[]).includes(value)
    )
        return value as T
    throw new BadRequestException({
        code: 'terminal_hook_invalid',
        message: `${field} must be one of ${values.join(', ')}`
    })
}

// Shape only. Nothing in the body names the terminal, and a transcript path
// is not accepted: the API reads transcripts through the runtime it has.
export const parseTerminalSessionHookRequest = (
    raw: unknown
): TerminalSessionHookRequest => {
    const body =
        raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {}
    const sessionRef =
        typeof body.sessionRef === 'string' ? body.sessionRef.trim() : ''
    if (!SESSION_REF_PATTERN.test(sessionRef))
        throw new BadRequestException({
            code: 'terminal_hook_invalid',
            message: 'sessionRef is not a framework session id'
        })
    const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
    if (
        cwd !== undefined &&
        (cwd.length > CWD_MAX_LENGTH || cwd.includes('\0'))
    )
        throw new BadRequestException({
            code: 'terminal_hook_invalid',
            message: 'cwd is not a path'
        })
    return {
        framework: oneOf(TERMINAL_HOOK_FRAMEWORKS, body.framework, 'framework'),
        event: oneOf(TERMINAL_HOOK_EVENTS, body.event, 'event'),
        source: oneOf(TERMINAL_HOOK_SOURCES, body.source, 'source'),
        sessionRef,
        ...(cwd ? { cwd } : {})
    }
}

// Where the CLI session hooks report (ADR-0029 §3). Only the token a
// terminal was opened with can reach the rules: the terminal is looked up
// from that token id, a user's own PAT or session and an agent-runtime
// token are refused, so the hook can never produce a hold, a session or a
// ref change on anyone's behalf but the terminal's own.
@Controller('terminal')
@UseGuards(AuthGuard)
export class TerminalHookController {
    constructor(
        private readonly terminals: TerminalSessionsRepository,
        private readonly hooks: TerminalHookService,
        private readonly rateLimit: ShareRateLimitService
    ) {}

    @Post('session-hooks')
    @HttpCode(200)
    async report(
        @CurrentUser() principal: AuthPrincipal,
        @Body() raw: unknown
    ): Promise<TerminalSessionHookResponse> {
        const terminal =
            principal.kind === 'human-api-token'
                ? await this.terminals.findLiveByTokenId(principal.tokenId)
                : null
        if (!terminal)
            throw new ForbiddenException({
                code: 'terminal_token_required',
                message:
                    'session hooks report only with the token of a live Manyfold terminal'
            })
        this.rateLimit.consume({
            key: `terminal-hook:${terminal.id}`,
            limit: REPORTS_PER_MINUTE,
            windowMs: 60_000
        })
        const body = parseTerminalSessionHookRequest(raw)
        return { outcome: await this.hooks.report(terminal, body) }
    }
}
