// Editions slot (§3.3): managed-channel picker ranking. Open source has no
// managed channels, so every row ranks equal; the cloud overlay re-exports
// the real ranking.
export const managedChannelRank = (_brand: string | null): number => 0
