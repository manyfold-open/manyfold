import type { WorksWithChip } from '@/seo/landingContent'

/* Editions slot (§3.3): framework chips this build adds to the landing's
   "works with" row, after the core frameworks that run on a machine. Empty in
   the open-source build; a distribution shadows this module by path. */
export const worksWithEditionFrameworks: readonly WorksWithChip[] = []
