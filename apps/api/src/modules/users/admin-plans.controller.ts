import type { Plan } from '@manyfold/shared'
import { Controller, Get, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { UsersService } from '@/modules/users/users.service'

// Separate controller rather than a route on UsersController: '/admin/users'
// already owns ':id', and 'plans' would be indistinguishable from a user id.
@Controller('admin/plans')
@UseGuards(AuthGuard, AdminGuard)
export class AdminPlansController {
    constructor(private readonly usersService: UsersService) {}

    @Get()
    list(): Promise<Plan[]> {
        return this.usersService.listPlans()
    }
}
