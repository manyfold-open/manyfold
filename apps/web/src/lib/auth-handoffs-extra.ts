import { narraNexusAuthHandoff } from '@/frameworks/narranexus/authHandoff'
import type { AuthHandoff } from '@/lib/auth'

/* Editions slot (§3.3): the sign-ins another product hands over in the URL
   fragment, each traded for a Manyfold session on arrival. A distribution
   shadows this module by path. */
export const extraAuthHandoffs: readonly AuthHandoff[] = [narraNexusAuthHandoff]
