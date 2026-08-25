import type { CollectionEntry } from 'astro:content'

type Entry = CollectionEntry<'changelog'>

// The changelog entries carry only `version` and `date` in frontmatter. The
// headline lives as the first h2 of the body, which is why the index used to
// render the body and let that h2 stand in for a title, and why the one entry
// whose body has no h2 (the 0.23.1 maintenance release) appeared as a bare
// paragraph with no heading at all.
//
// Every surface that needs a title now reads it from here: the index, the entry
// page, that page's markdown twin and its social card. They cannot disagree,
// and none of them needs a `title` field added to the collection, which
// matters because those 37 files are a fixture copied from the deploy repo and
// are deliberately excluded from this package's patches. A change that needs
// their frontmatter is a change that cannot ship.

// The slug is rebuilt from the version rather than taken from the file id,
// because the loader slugifies the filename and eats the dots: cli-v0.22.5.md
// arrives as the id `cli-v0225`, which reads as no version at all. Rebuilt, it
// matches the filename, the #v0.22.5 anchor the index publishes and the tag:
// URI in the feed.
const changelogPrefix = (entry: Entry): string => entry.id.split('-v')[0]

export const changelogSlug = (entry: Entry): string =>
    `${changelogPrefix(entry)}-v${entry.data.version}`

export const changelogHref = (entry: Entry): string =>
    `/changelog/${changelogSlug(entry)}/`

// 36 of the 37 entries are CLI releases and one is a platform release. Read
// from the id rather than hardcoded, so a second product line names itself.
export const changelogProduct = (entry: Entry): string => {
    const prefix = changelogPrefix(entry)
    return prefix === 'cli' ? 'CLI' : prefix === 'manyfold' ? 'Manyfold' : prefix
}

const stripInline = (markdown: string): string =>
    markdown
        .replace(/`/g, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\[(.+?)\]\([^)]*\)/g, '$1')
        .trim()

export const changelogTitle = (entry: Entry): string => {
    const heading = (entry.body ?? '').match(/^##\s+(.+?)\s*$/m)?.[1]
    return heading
        ? stripInline(heading)
        : `${changelogProduct(entry)} ${entry.data.version}`
}

// The lead paragraph, for <meta description> and the card. The body's first
// block after the headline is written as one, which is what makes this
// worth reading out rather than generating a sentence.
// A release note's first paragraph is written to be read on the page, and for
// twelve entries that paragraph ran past 250 characters -- as the meta
// description, which a search result cuts near 160, and as the headline baked
// into the social card. Cut on a word boundary so the tail is a word and not a
// syllable, and only when there is something to cut.
const DESCRIPTION_LIMIT = 155

const clamp = (text: string): string => {
    if (text.length <= DESCRIPTION_LIMIT) return text
    const cut = text.slice(0, DESCRIPTION_LIMIT)
    const boundary = cut.lastIndexOf(' ')
    return `${(boundary > 80 ? cut.slice(0, boundary) : cut).replace(/[,;:.\s]+$/, '')}…`
}

export const changelogLead = (entry: Entry): string | undefined => {
    const blocks = (entry.body ?? '')
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean)
    const paragraph = blocks.find(
        (block) => !/^(#{1,6}\s|[-*+]\s|\d+\.\s|>|```|\|)/.test(block)
    )
    if (!paragraph) return undefined
    return clamp(stripInline(paragraph.replace(/\n/g, ' ')))
}


// The body with its headline removed, matching what the page renders: the
// rehype plugin drops that h2 from the HTML, and the twin prints it as the h1
// instead, so neither shows the same line twice.
export const changelogBody = (entry: Entry): string =>
    (entry.body ?? '').replace(/^##\s+.+?$/m, '').trim()

const versionParts = (version: string): number[] =>
    version.split('.').map((part) => Number.parseInt(part, 10) || 0)

const compareVersions = (a: string, b: string): number => {
    const aParts = versionParts(a)
    const bParts = versionParts(b)
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
        const diff = (bParts[i] ?? 0) - (aParts[i] ?? 0)
        if (diff !== 0) return diff
    }
    return 0
}

// Newest first. Lives here rather than in the timeline because the entry pages
// derive their newer/older links from the same order: two copies of this
// comparison is two chances for the index and a release page to disagree about
// which release came next.
export const sortChangelog = (entries: Entry[]): Entry[] =>
    [...entries].sort(
        (a, b) =>
            b.data.date.localeCompare(a.data.date) ||
            compareVersions(a.data.version, b.data.version)
    )
