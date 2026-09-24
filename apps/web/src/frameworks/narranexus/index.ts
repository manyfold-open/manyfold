import nexusLightIcon from '@/assets/agent-logos/nexus-light.svg'
import nexusDarkIcon from '@/assets/agent-logos/nexus-dark.svg'
import type { FrameworkPresentation } from '@/lib/frameworkPresentation'
import { narraNexusPresentation } from './presentation'

export const narraNexus: FrameworkPresentation = {
    ...narraNexusPresentation,
    icon: { light: nexusLightIcon, dark: nexusDarkIcon }
}
