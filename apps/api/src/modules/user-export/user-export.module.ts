import { Module } from '@nestjs/common'
import { AuthModule } from '@/modules/auth/auth.module'
import { EmailModule } from '@/modules/email/email.module'
import { ExportTokenService } from './export-token.service'
import { UserExportStorageService } from './export-storage.service'
import { UserExportService } from './user-export.service'
import { UserExportController } from './user-export.controller'
import { MeExportController } from './me-export.controller'

@Module({
    imports: [AuthModule, EmailModule],
    providers: [UserExportService, UserExportStorageService, ExportTokenService],
    controllers: [UserExportController, MeExportController]
})
export class UserExportModule {}
