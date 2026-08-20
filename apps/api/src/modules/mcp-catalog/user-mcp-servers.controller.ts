import type { UserMcpServer } from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    UseGuards
} from '@nestjs/common'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import { DenyBoundToken } from '@/common/decorators/subject-agent.decorator'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import {
    CreateUserMcpServerDto,
    UpdateUserMcpServerDto
} from './dto/user-mcp-server.dto'
import { UserMcpServersService } from './user-mcp-servers.service'

@Controller('mcp/library')
@UseGuards(AuthGuard)
export class UserMcpServersController {
    constructor(private readonly servers: UserMcpServersService) {}

    @Get()
    @RequireApiTokenScope('agents:read')
    @DenyBoundToken()
    list(@CurrentUser() user: AuthPrincipal): Promise<UserMcpServer[]> {
        return this.servers.list(user.userId)
    }

    @Get(':id')
    @RequireApiTokenScope('agents:read')
    @DenyBoundToken()
    get(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<UserMcpServer> {
        return this.servers.get(user.userId, id)
    }

    @Post()
    @HttpCode(201)
    @RequireApiTokenScope('agents:edit')
    @DenyBoundToken()
    create(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: CreateUserMcpServerDto
    ): Promise<UserMcpServer> {
        return this.servers.create(user.userId, body)
    }

    @Patch(':id')
    @RequireApiTokenScope('agents:edit')
    @DenyBoundToken()
    update(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: UpdateUserMcpServerDto
    ): Promise<UserMcpServer> {
        return this.servers.update(user.userId, id, body)
    }

    @Delete(':id')
    @HttpCode(204)
    @RequireApiTokenScope('agents:edit')
    @DenyBoundToken()
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        await this.servers.delete(user.userId, id)
    }
}
