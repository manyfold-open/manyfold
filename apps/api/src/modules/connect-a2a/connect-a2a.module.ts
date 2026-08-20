import { Module } from '@nestjs/common'
import { A2aModule } from '../a2a/a2a.module'
import { AuthModule } from '../auth/auth.module'
import { ConnectA2aController } from './connect-a2a.controller'
import { ConnectA2aService } from './connect-a2a.service'

@Module({
    imports: [AuthModule, A2aModule],
    controllers: [ConnectA2aController],
    providers: [ConnectA2aService]
})
export class ConnectA2aModule {}
