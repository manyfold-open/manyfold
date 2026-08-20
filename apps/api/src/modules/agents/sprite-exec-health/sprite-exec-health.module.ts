import { Module } from '@nestjs/common'
import { SpriteExecHealthService } from './sprite-exec-health.service'

// Deliberately imports nothing. The breaker needs the drizzle handle and the
// telemetry service, both of them @Global, so every consumer — chat's turn path,
// the storage measurement, whatever asks next — can import this module without
// pulling that consumer's dependency graph along with it. A breaker whose
// registration created a cycle would be a breaker nobody could adopt.
@Module({
    providers: [SpriteExecHealthService],
    exports: [SpriteExecHealthService]
})
export class SpriteExecHealthModule {}
