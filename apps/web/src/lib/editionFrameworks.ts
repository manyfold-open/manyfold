import { extraFrameworks } from '@/frameworks-extra'
import { registerFrameworkPresentation } from '@/lib/frameworkPresentation'

// Imported by main.tsx ahead of the app: an edition's frameworks have to be
// in the registry before anything lists it, and listing seals it (ADR-0034).
for (const presentation of extraFrameworks)
    registerFrameworkPresentation(presentation)
