import { narraNexus } from '@/frameworks/narranexus'
import type { FrameworkPresentation } from '@/lib/frameworkPresentation'

/* Editions slot (§3.3): the frameworks this build adds on top of the core
   table (ADR-0034), each with how the app presents it. A distribution
   shadows this module by path. lib/editionFrameworks registers them before
   anything can list the framework registry. */
export const extraFrameworks: readonly FrameworkPresentation[] = [narraNexus]
