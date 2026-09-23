import { narraNexusFrameworkDefinition } from '@manyfold/shared'
import type { FrameworkDefinition } from '@manyfold/shared'

/* Editions slot (§3.4): the frameworks this build adds on top of the core
   table (ADR-0034), mirroring apps/web/src/frameworks-extra.ts; the admin
   needs only their definitions. A distribution shadows this module by path.
   lib/editionFrameworks registers them before anything can list the
   framework registry. */
export const extraFrameworks: readonly FrameworkDefinition[] = [
    narraNexusFrameworkDefinition
]
