import { Global, Module } from '@nestjs/common'
import { AppEventsService } from '@/common/events/app-events.service'

@Global()
@Module({
    providers: [AppEventsService],
    exports: [AppEventsService]
})
export class AppEventsModule {}
