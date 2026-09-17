import { Module, UnauthorizedException } from '@nestjs/common'
import { PARAMTYPES_METADATA } from '@nestjs/common/constants'
import { NestFactory, Reflector } from '@nestjs/core'
import {
    FastifyAdapter,
    type NestFastifyApplication
} from '@nestjs/platform-fastify'
import type { Database } from '@manyfold/db'
import {
    AuthGuard,
    type AuthPrincipal
} from '../../src/common/guards/auth.guard'
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter'
import { DRIZZLE } from '../../src/db/tokens'
import { AuthService } from '../../src/modules/auth/auth.service'
import { BearerAuthService } from '../../src/modules/auth/bearer-auth.service'
import { AuthzService } from '../../src/modules/auth/authz.service'
import { RuntimeAccessService } from '../../src/modules/runtime-access/runtime-access.service'
import { RuntimeAccessController } from '../../src/modules/runtime-access/runtime-access.controller'
import { SpriteStatusBroadcaster } from '../../src/modules/agents/sprite-status/sprite-status-broadcaster'
import { SpriteStatusController } from '../../src/modules/agents/sprite-status/sprite-status.controller'

export const createQuotaHttpFixture = async (
    db: Database,
    runtimeAccess: RuntimeAccessService,
    broadcaster: SpriteStatusBroadcaster,
    principals: Record<string, AuthPrincipal>
) => {
    // tsx omits TypeScript's constructor metadata; restore the same DI tokens
    // emitted by the production build while retaining real route decorators.
    Reflect.defineMetadata(
        PARAMTYPES_METADATA,
        [BearerAuthService, Reflector, AuthzService],
        AuthGuard
    )
    Reflect.defineMetadata(
        PARAMTYPES_METADATA,
        [RuntimeAccessService, AuthService, BearerAuthService],
        RuntimeAccessController
    )
    Reflect.defineMetadata(
        PARAMTYPES_METADATA,
        [Object, SpriteStatusBroadcaster],
        SpriteStatusController
    )
    const reflector = new Reflector()
    const authz = new AuthzService(
        reflector,
        db,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )
    const failures: unknown[] = []
    @Module({
        controllers: [RuntimeAccessController, SpriteStatusController],
        providers: [
            AuthGuard,
            { provide: DRIZZLE, useValue: db },
            { provide: Reflector, useValue: reflector },
            { provide: RuntimeAccessService, useValue: runtimeAccess },
            { provide: SpriteStatusBroadcaster, useValue: broadcaster },
            { provide: AuthzService, useValue: authz },
            { provide: AuthService, useValue: {} },
            {
                provide: BearerAuthService,
                useValue: {
                    verifyBearerToken: async (token: string) => {
                        const principal = principals[token]
                        if (!principal)
                            throw new UnauthorizedException(
                                'unknown fixture identity'
                            )
                        return { ...principal }
                    }
                }
            }
        ]
    })
    class QuotaHttpModule {}
    const app = await NestFactory.create<NestFastifyApplication>(
        QuotaHttpModule,
        new FastifyAdapter({ logger: false }),
        { logger: false, abortOnError: false }
    )
    app.setGlobalPrefix('api')
    app.useGlobalFilters(
        new HttpExceptionFilter((error) => failures.push(error))
    )
    await app.listen(0, '127.0.0.1')
    return {
        baseUrl: `${await app.getUrl()}/api`,
        failures,
        close: async () => {
            app.getHttpServer().closeAllConnections()
            await app.close()
        }
    }
}
