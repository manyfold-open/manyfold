import {
    BadGatewayException,
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { DaemonRpcResponseError } from '@/modules/daemon/daemon-registry.service'
import { HostDaemonOfflineError } from '@/modules/agents/adapters/host-daemon-access'

// A failure on the machine's side is not an HttpException, so unmapped it
// reaches the caller as a 500 internal_error that hides what went wrong.
// Mapped at the files boundary: what the daemon refused about a path is the
// caller's to fix; a machine that cannot be reached, or whose CLI is too old,
// is the runtime being unavailable to us.
export const daemonFilesError = (err: unknown): never => {
    if (err instanceof HttpException) throw err
    if (err instanceof HostDaemonOfflineError)
        throw new ServiceUnavailableException({
            code: 'runtime_unavailable',
            message: err.message
        })
    const message = (err as Error)?.message ?? String(err)
    if (err instanceof DaemonRpcResponseError) {
        if (/\bENOENT\b/.test(message))
            throw new NotFoundException({ code: 'not_found', message })
        if (/\bEEXIST\b|\bENOTEMPTY\b/.test(message))
            throw new ConflictException({ code: 'conflict', message })
        if (/refusing|\bEACCES\b|\bEPERM\b/.test(message))
            throw new ForbiddenException({ code: 'forbidden', message })
        if (/\bEISDIR\b|\bENOTDIR\b|is a directory|^upload_/.test(message))
            throw new BadRequestException({ code: 'bad_request', message })
    }
    throw new BadGatewayException({
        code: 'runtime_unavailable',
        message: `agent runtime unavailable: ${message}`
    })
}
