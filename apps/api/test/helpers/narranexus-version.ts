import { registerFrameworkVersionDescriptor } from '../../src/modules/framework-versions/framework-version-registry'
import { narraNexusVersion } from '../../src/modules/narranexus/version/narranexus-version'

// NarraNexus's module registers its version descriptor when the app boots; a
// unit test that drives the descriptor without the app imports this instead.
registerFrameworkVersionDescriptor(narraNexusVersion().descriptor)
