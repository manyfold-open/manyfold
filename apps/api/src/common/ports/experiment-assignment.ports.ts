import type {
    ExperimentAssignment,
    ExperimentAssignments
} from '@manyfold/shared'

export const EXPERIMENT_ASSIGNMENT_PORT = Symbol('EXPERIMENT_ASSIGNMENT_PORT')

// A/B assignment is cloud-scale operations tooling; core surfaces only read
// assignments. The empty default means "no experiments exist" — consumers
// already treat missing assignments as the control experience.
export interface ExperimentAssignmentPort {
    assignAllFor(userId: string): Promise<ExperimentAssignments>
    assignFor(
        userId: string,
        key: string
    ): Promise<ExperimentAssignment | null>
}

export const noExperimentsPort: ExperimentAssignmentPort = {
    assignAllFor: async () => ({}),
    assignFor: async () => null
}
