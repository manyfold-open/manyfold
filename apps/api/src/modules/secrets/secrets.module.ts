import { Global, Module } from '@nestjs/common'
import { CryptoService } from '@/modules/secrets/crypto.service'

@Global()
@Module({
    providers: [CryptoService],
    exports: [CryptoService]
})
export class SecretsModule {}
