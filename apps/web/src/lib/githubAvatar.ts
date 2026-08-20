export const githubAvatarUrl = (owner: string): string =>
    `https://github.com/${encodeURIComponent(owner)}.png?size=64`

export const githubAvatarUrlFromRepositoryUrl = (
    repositoryUrl: string
): string | null => {
    let url: URL
    try {
        url = new URL(repositoryUrl)
    } catch {
        return null
    }
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com')
        return null
    const owner = url.pathname.split('/').filter(Boolean)[0]
    return owner ? githubAvatarUrl(owner) : null
}
