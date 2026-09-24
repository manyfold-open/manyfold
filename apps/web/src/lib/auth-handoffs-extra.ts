import type { AuthHandoff } from '@/lib/auth'

/* Editions slot (§3.3): the sign-ins another product hands over in the URL
   fragment, each traded for a Manyfold session on arrival. Empty in the
   open-source build; a distribution shadows this module by path. */
export const extraAuthHandoffs: readonly AuthHandoff[] = []
