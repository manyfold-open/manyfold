import { registerFramework } from '@manyfold/shared'
import { extraFrameworks } from '@/frameworks-extra'

// Imported by main.tsx ahead of the app: an edition's frameworks have to be
// in the registry before anything lists it, and listing seals it (ADR-0034).
for (const definition of extraFrameworks) registerFramework(definition)
