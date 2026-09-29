// The sprite-local /v1/tasks activity API, reachable only from inside the VM
// via /.sprite/api.sock: a listing's parser. The platform's holds are placed
// and renewed by the API (ADR-0038).

// One task in a `GET /v1/tasks` listing.
export interface SpriteTask {
    name: string
    startedAt: string | null
    expiresAt: string | null
}

// The listing `sprite-env curl -s /v1/tasks` prints, or null when the output
// is not one: `sprite-env curl` rejects `-f`, so a listing that parses is the
// only proof a task call went through.
export const parseTaskList = (stdout: string): SpriteTask[] | null => {
    let body: unknown
    try {
        body = JSON.parse(stdout.trim())
    } catch {
        return null
    }
    const tasks = (body as { tasks?: unknown } | null)?.tasks
    if (!Array.isArray(tasks)) return null
    return tasks.flatMap((task: Record<string, unknown> | null) =>
        typeof task?.name === 'string'
            ? [
                  {
                      name: task.name,
                      startedAt:
                          typeof task.started_at === 'string'
                              ? task.started_at
                              : null,
                      expiresAt:
                          typeof task.expires_at === 'string'
                              ? task.expires_at
                              : null
                  }
              ]
            : []
    )
}
