export const appUrl = (
    import.meta.env.PUBLIC_APP_URL ?? 'https://manyfold.ai'
).replace(/\/$/, '')

/* Duplicated from apps/web's `lib/socialLinks.ts` rather than shared: this
   package depends only on @manyfold/i18n, and pulling in @manyfold/shared for
   three string constants costs more than keeping the set in sync. Change one,
   change the other. */
export const socialXUrl = 'https://x.com/manyfold_ai'
export const socialDiscordUrl = 'https://discord.gg/65vqpUe3mJ'
export const socialGithubUrl = 'https://github.com/manyfold-open/manyfold'
