import type { FC } from 'react'

/* Editions slot (§3.3): what a downstream composition mounts into the app
   shell. Both arrays are empty in the open-source build; a distribution
   shadows this module by path and fills them. Same convention as
   `apps/admin/src/nav-extra.ts` and `apps/admin/src/routes-extra.tsx`.

   Entries are grouped by REGION of the shell, never by what a composition
   puts there — so this app never learns the vocabulary of a distribution's
   product, and a new downstream surface in a region that already exists needs
   no change here at all.

   The split into two arrays is the shell's one non-obvious layout fact:
   `renderSidebar` runs twice — once for the desktop rail, once for the mobile
   drawer — so a rail entry mounts twice on purpose, each rail carrying its
   own, while anything that portals has to be a shell-root entry or it puts
   two copies of itself on the page.

   `id` is the React key: unique within its array, stable across renders,
   never shown to a user. */

// Chips in the rail's account resource row, beside the concurrency indicator.
// `collapsed` is the 58px rail: room for a glyph, not for a number.
export const extraSidebarMeters: Array<{
    id: string
    Component: FC<{ collapsed: boolean }>
}> = []

// Overlays mounted once at the shell root: modals and portals whose trigger is
// the workspace itself rather than a route.
export const extraShellOverlays: Array<{
    id: string
    Component: FC
}> = []
