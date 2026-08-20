import {
    CreateUserMcpServerBody,
    UpdateUserMcpServerBody,
    UserMcpServer,
    createObjectId
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    NotFoundException
} from '@nestjs/common'
import { and, asc, eq } from 'drizzle-orm'
import {
    userMcpServers,
    type Database,
    type UserMcpServerRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'

const rowToSummary = (row: UserMcpServerRow): UserMcpServer => ({
    id: row.id,
    serverKey: row.serverKey,
    name: row.name,
    description: row.description,
    transport: row.transport,
    ...(row.url !== null ? { url: row.url } : {}),
    ...(row.headers !== null ? { headers: row.headers } : {}),
    ...(row.command !== null ? { command: row.command } : {}),
    ...(row.args !== null ? { args: row.args } : {}),
    ...(row.env !== null ? { env: row.env } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

const stringRecord = (
    value: Record<string, string> | null | undefined,
    field: string
): Record<string, string> | null => {
    if (!value || Object.keys(value).length === 0) return null
    for (const [key, entry] of Object.entries(value)) {
        if (!key.trim() || typeof entry !== 'string')
            throw new BadRequestException(
                `${field} must contain non-empty string keys and string values`
            )
    }
    return value
}

const transportFields = (entry: {
    transport: 'http' | 'stdio'
    url?: string | null
    headers?: Record<string, string> | null
    command?: string | null
    args?: string[] | null
    env?: Record<string, string> | null
}): Pick<UserMcpServerRow, 'url' | 'headers' | 'command' | 'args' | 'env'> => {
    if (entry.transport === 'http') {
        const url = entry.url?.trim()
        if (!url || !/^https?:\/\//.test(url))
            throw new BadRequestException(
                'http transport requires a url starting with http(s)://'
            )
        return {
            url,
            headers: stringRecord(entry.headers, 'headers'),
            command: null,
            args: null,
            env: null
        }
    }
    const command = entry.command?.trim()
    if (!command)
        throw new BadRequestException('stdio transport requires a command')
    return {
        url: null,
        headers: null,
        command,
        args: entry.args?.map((arg) => arg.trim()).filter(Boolean) ?? null,
        env: stringRecord(entry.env, 'env')
    }
}

const translateKeyConflict = (err: unknown, key: string): unknown => {
    if (
        err instanceof Error &&
        err.message.includes('user_mcp_servers_user_server_key_unique')
    )
        return new ConflictException(`MCP server key "${key}" already exists`)
    return err
}

@Injectable()
export class UserMcpServersService {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async list(userId: string): Promise<UserMcpServer[]> {
        const rows = await this.db
            .select()
            .from(userMcpServers)
            .where(eq(userMcpServers.userId, userId))
            .orderBy(asc(userMcpServers.name), asc(userMcpServers.serverKey))
        return rows.map(rowToSummary)
    }

    async get(userId: string, id: string): Promise<UserMcpServer> {
        return rowToSummary(await this.requireRow(userId, id))
    }

    async create(
        userId: string,
        body: CreateUserMcpServerBody
    ): Promise<UserMcpServer> {
        const name = body.name.trim()
        if (!name) throw new BadRequestException('name is required')
        const fields = transportFields(body)
        try {
            const [row] = await this.db
                .insert(userMcpServers)
                .values({
                    id: createObjectId('userMcpServer'),
                    userId,
                    serverKey: body.serverKey,
                    name,
                    description: body.description?.trim() || null,
                    transport: body.transport,
                    ...fields
                })
                .returning()
            return rowToSummary(row)
        } catch (err) {
            throw translateKeyConflict(err, body.serverKey)
        }
    }

    async update(
        userId: string,
        id: string,
        body: UpdateUserMcpServerBody
    ): Promise<UserMcpServer> {
        const existing = await this.requireRow(userId, id)
        const name = body.name === undefined ? existing.name : body.name.trim()
        if (!name) throw new BadRequestException('name is required')
        const transport = body.transport ?? existing.transport
        const fields = transportFields({
            transport,
            url: body.url === undefined ? existing.url : body.url,
            headers:
                body.headers === undefined ? existing.headers : body.headers,
            command:
                body.command === undefined ? existing.command : body.command,
            args: body.args === undefined ? existing.args : body.args,
            env: body.env === undefined ? existing.env : body.env
        })
        const serverKey = body.serverKey ?? existing.serverKey
        try {
            const [row] = await this.db
                .update(userMcpServers)
                .set({
                    serverKey,
                    name,
                    description:
                        body.description === undefined
                            ? existing.description
                            : body.description?.trim() || null,
                    transport,
                    ...fields,
                    updatedAt: new Date()
                })
                .where(
                    and(
                        eq(userMcpServers.id, id),
                        eq(userMcpServers.userId, userId)
                    )
                )
                .returning()
            return rowToSummary(row)
        } catch (err) {
            throw translateKeyConflict(err, serverKey)
        }
    }

    async delete(userId: string, id: string): Promise<void> {
        const rows = await this.db
            .delete(userMcpServers)
            .where(
                and(
                    eq(userMcpServers.id, id),
                    eq(userMcpServers.userId, userId)
                )
            )
            .returning({ id: userMcpServers.id })
        if (rows.length === 0)
            throw new NotFoundException('user MCP server not found')
    }

    private async requireRow(
        userId: string,
        id: string
    ): Promise<UserMcpServerRow> {
        const [row] = await this.db
            .select()
            .from(userMcpServers)
            .where(
                and(
                    eq(userMcpServers.id, id),
                    eq(userMcpServers.userId, userId)
                )
            )
            .limit(1)
        if (!row) throw new NotFoundException('user MCP server not found')
        return row
    }
}
