import type { AgentFramework } from './constants'

/* How a framework's own CLI is pointed at an existing session, as its docs
   write it. Shared because two surfaces need the same answer: the API builds
   the terminal's TUI-resume argv from it, and the web session list offers it
   as a command to copy and run elsewhere.

     claude --resume <id>   resumes a conversation by session id
     codex resume <id>      "Resume a previous interactive session"

   gemini-cli is absent on purpose: its --resume takes a session INDEX or the
   literal "latest", not the UUID stored in framework_session_ref, so there is
   nothing to point it at. openclaw and hermes expose no resume-by-id form.

   Deliberately WITHOUT the permission-bypass flags. The API appends its own
   (terminal-resume-command.ts) because it is dropping the user into a runtime
   that is already the trust boundary. A copied command has no such context —
   it runs wherever it is pasted — so it must not silently disable the
   approval prompts on that machine. */
const RESUME_ARGV_BY_FRAMEWORK: Partial<
    Record<AgentFramework, (sessionRef: string) => string[]>
> = {
    'claude-code': (ref) => ['claude', '--resume', ref],
    codex: (ref) => ['codex', 'resume', ref]
}

export const frameworkResumeArgv = (
    framework: AgentFramework,
    sessionRef: string
): string[] | null => {
    const ref = sessionRef.trim()
    if (!ref) return null
    return RESUME_ARGV_BY_FRAMEWORK[framework]?.(ref) ?? null
}

// The same command as one shell line. Session refs are UUIDs or opaque ids
// from the framework's own files, so a ref carrying whitespace or a quote is
// malformed rather than expected — quote it anyway so a copied line can never
// turn into two commands.
export const frameworkResumeCommandLine = (
    framework: AgentFramework,
    sessionRef: string
): string | null => {
    const argv = frameworkResumeArgv(framework, sessionRef)
    if (!argv) return null
    return argv.map(shellQuote).join(' ')
}

const SAFE_ARG = /^[A-Za-z0-9._:@/-]+$/

const shellQuote = (value: string): string =>
    SAFE_ARG.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
