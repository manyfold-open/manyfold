/* The product's two permanent public addresses.

   Deliberately not `CHALLENGE_DISCORD_URL`: that invite lands in a shared
   server's campaign channel and belongs to one round, so it carries the
   channel and category names with it. These are the front doors — they answer
   "where do I follow this" and "where do I ask people", with no campaign
   context attached, and they outlive any single edition. */
export const SOCIAL_X_URL = 'https://x.com/manyfold_ai'

/* Lands on #manyfold-start-here inside the NetMind.AI server. The server is
   not named Manyfold, which is why copy that renders as text says "Discord"
   rather than "our Discord". */
export const SOCIAL_DISCORD_URL = 'https://discord.gg/65vqpUe3mJ'
