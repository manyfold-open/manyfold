import type { A2aStreamEvent, Part } from './types'

const textOf = (parts: Part[]): string =>
    parts.map((part) => (part.kind === 'text' ? part.text : '')).join('')

// Snapshots replace only their own artifact; another task/artifact keeps its text.
export class A2aTextAccumulator {
    private readonly entries = new Map<string, string>()

    apply(event: A2aStreamEvent): string {
        if (event.kind === 'artifact-update') {
            const key = JSON.stringify([
                'artifact',
                event.taskId,
                event.artifact.artifactId
            ])
            const text = textOf(event.artifact.parts)
            this.entries.set(
                key,
                event.append ? (this.entries.get(key) ?? '') + text : text
            )
        } else if (event.kind === 'task') {
            for (const artifact of event.artifacts ?? [])
                this.entries.set(
                    JSON.stringify(['artifact', event.id, artifact.artifactId]),
                    textOf(artifact.parts)
                )
        } else if (event.kind === 'message') {
            this.entries.set(
                JSON.stringify(['message', event.messageId]),
                textOf(event.parts)
            )
        }
        if (
            (event.kind === 'task' || event.kind === 'status-update') &&
            (event.status.state === 'input-required' ||
                event.status.state === 'auth-required') &&
            event.status.message
        ) {
            const message = event.status.message
            this.entries.set(
                JSON.stringify(['message', message.messageId]),
                textOf(message.parts)
            )
        }
        return this.text()
    }

    text(): string {
        return [...this.entries.values()].filter(Boolean).join('\n')
    }
}
