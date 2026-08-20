import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { CloudflareService } from '@/modules/connections/cloudflare.service'
import { ComposioService } from '@/modules/connections/composio.service'
import { ConnectionsController } from '@/modules/connections/connections.controller'
import { ConnectionsService } from '@/modules/connections/connections.service'
import { GithubAppService } from '@/modules/connections/github-app.service'
import { GithubCallbackController } from '@/modules/connections/github-callback.controller'

@Module({
    imports: [AuthModule],
    controllers: [ConnectionsController, GithubCallbackController],
    providers: [
        ConnectionsService,
        CloudflareService,
        ComposioService,
        GithubAppService
    ],
    exports: [ConnectionsService]
})
export class ConnectionsModule {}
