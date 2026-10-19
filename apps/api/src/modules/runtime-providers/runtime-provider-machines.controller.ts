import type {
    ProviderMachineAction,
    ProviderMachineList,
    ProviderMachineRestartResult,
    ProviderMachineSummary,
    ProviderMachineUpgradeEvent
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpException,
    Param,
    Post,
    Query,
    Res,
    UseGuards
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { corsHeadersForOrigin } from '@/common/cors-headers'
import { describeHttpException } from '@/common/filters/http-exception.filter'
import { RuntimeProviderMachinesService } from './runtime-provider-machines.service'
import { UpgradeProviderMachineDto } from './dto/runtime-provider-machine.dto'

// A provider's own machine names (sprites: `sbx-…`, or whatever was made by
// hand); anything else never reaches the provider.
const MACHINE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const machineName = (name: string): string => {
    if (!MACHINE_NAME.test(name))
        throw new BadRequestException({
            message: 'not a machine name',
            code: 'PROVIDER_MACHINE_NAME_INVALID'
        })
    return name
}

// An upgrade that copies a disk sends nothing for minutes; a blank line keeps
// proxies and the client's idle timer from cutting the stream. NDJSON
// readers skip it.
const KEEPALIVE_MS = 15_000

@Controller('admin/runtime-providers')
@UseGuards(AuthGuard, AdminGuard)
export class RuntimeProviderMachinesController {
    constructor(private readonly machines: RuntimeProviderMachinesService) {}

    @Get(':id/machines')
    list(
        @Param('id') id: string,
        @Query('refresh') refresh?: string
    ): Promise<ProviderMachineList> {
        return this.machines.list(id, { refresh: refresh === '1' })
    }

    @Get(':id/machines/:name')
    get(
        @Param('id') id: string,
        @Param('name') name: string
    ): Promise<ProviderMachineSummary> {
        return this.machines.get(id, machineName(name))
    }

    @Get(':id/machines/:name/actions')
    actions(
        @Param('id') id: string,
        @Param('name') name: string
    ): Promise<ProviderMachineAction[]> {
        return this.machines.actions(id, machineName(name))
    }

    @Post(':id/machines/:name/restart')
    @HttpCode(200)
    restart(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('name') name: string
    ): Promise<ProviderMachineRestartResult> {
        return this.machines.restart(user.userId, id, machineName(name))
    }

    // NDJSON from the moment the provider accepts; a refusal before that is a
    // plain HTTP error.
    @Post(':id/machines/:name/upgrade')
    async upgrade(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('name') name: string,
        @Body() dto: UpgradeProviderMachineDto,
        @Res() res: FastifyReply
    ): Promise<void> {
        let keepalive: NodeJS.Timeout | undefined
        const write = (event: ProviderMachineUpgradeEvent): void => {
            // The admin may have gone; the upgrade is watched to its end anyway.
            if (res.raw.destroyed || res.raw.writableEnded) return
            res.raw.write(JSON.stringify(event) + '\n')
        }
        const start = (): void => {
            res.hijack()
            res.raw.writeHead(200, {
                ...corsHeadersForOrigin(res.request.headers),
                'content-type': 'application/x-ndjson',
                'cache-control': 'no-cache',
                'x-accel-buffering': 'no'
            })
            keepalive = setInterval(() => {
                if (!res.raw.destroyed && !res.raw.writableEnded)
                    res.raw.write('\n')
            }, KEEPALIVE_MS)
            keepalive.unref?.()
        }
        try {
            const result = await this.machines.upgrade(
                user.userId,
                id,
                machineName(name),
                dto,
                {
                    onAccepted: (fromVersion) => {
                        start()
                        write({ type: 'accepted', fromVersion })
                    },
                    onStep: (step) => write({ type: 'step', step })
                }
            )
            write({ type: 'complete', result })
        } catch (err) {
            if (!keepalive) throw err
            const described =
                err instanceof HttpException
                    ? describeHttpException(err)
                    : {
                          status: 500,
                          code: 'internal_error',
                          message: 'the upgrade watch failed'
                      }
            write({
                type: 'error',
                code: described.code,
                status: described.status,
                message: described.message
            })
        } finally {
            if (keepalive) {
                clearInterval(keepalive)
                if (!res.raw.writableEnded) res.raw.end()
            }
        }
    }

    // A machine with a host here is deleted as its sandbox: refused while
    // agents remain on it.
    @Delete(':id/machines/:name')
    @HttpCode(204)
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('name') name: string
    ): Promise<void> {
        await this.machines.delete(user.userId, id, machineName(name))
    }
}
