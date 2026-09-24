import {
    narraNexusFrameworkDefinition,
    registerFramework
} from '@manyfold/shared'

// NarraNexus's module registers its definition when it loads; a unit test
// that drives NarraNexus code without that module imports this first.
registerFramework(narraNexusFrameworkDefinition)
