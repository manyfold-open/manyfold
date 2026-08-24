// The navigation tree, which is the documentation tree plus the API reference.
//
// The API reference used to be reachable only from the top menu: 85 pages
// linked it, and on 76 of them that header link was the only one. Its endpoints
// lived in a second sidebar that replaced this one whenever a reader stood on
// the API surface. Both facts came from the same root: the reference was a
// separate surface rather than a branch of the tree. It is a branch now, under
// the group that already holds the two API guides.
//
// This composes on top of groupDocs() rather than living inside it, for two
// reasons. groupDocs() reads a static list of collection slugs and cannot
// import api-reference.ts without a cycle, since that module imports i18n for
// localePath. And groupDocs() also feeds llms.txt and llms-full.txt, which
// carry the API reference their own way; expanding it there would have listed
// the landing twice in one file.
import {
    apiReferenceFor,
    endpointPath,
    methodClass,
    methodLabel
} from '@/lib/api-reference'
import type { CollectionEntry } from 'astro:content'
import {
    getUi,
    groupDocs,
    groupKeyForTitle,
    localePath,
    type DocsNavNode,
    type Locale
} from '@/lib/i18n'

// Which section the reference belongs to, by the locale-independent key rather
// than by the word, which is '参考' in the Chinese tree. Reference, not Connect:
// the endpoint pages are generated from a typed structure, and that section is
// the one that holds what nobody hand-writes.
const REFERENCE_GROUP = 'group-reference'
// The docs home had no row in the tree at all. It is the first thing in Start
// rather than a row of its own above the sections, because a reader opening
// Start is at the beginning of the documentation and this is the page that says
// what the documentation is.
//
// Injected here rather than written into the group data because llms.txt reads
// that data directly and already carries the page in its opening lines; adding
// it there would list the entry page twice in the same file.
const START_GROUP = 'group-start'

export const docsNavGroups = (
    entries: CollectionEntry<'docs'>[],
    locale: Locale
) => {
    const { grouped, remaining } = groupDocs(entries, locale)
    const reference = apiReferenceFor(locale)
    // The landing, then one row per endpoint, indented under it. Titles come
    // from apiReferenceFor() so the rail, the page bodies and the cards all
    // read the same strings.
    const rows: DocsNavNode[] = [
        {
            kind: 'page',
            title: reference.title,
            href: localePath(locale, '/api-reference'),
            nested: false,
            // The three endpoint rows below it are its children.
            ancestor: true
        },
        ...reference.endpoints.map(
            (endpoint): DocsNavNode => ({
                kind: 'page',
                title: endpoint.title,
                href: endpointPath(locale, endpoint.id),
                nested: true,
                badge: {
                    label: methodLabel(endpoint.method),
                    className: methodClass(endpoint.method)
                }
            })
        )
    ]

    const overview: DocsNavNode = {
        kind: 'page',
        title: getUi(locale).overview,
        href: localePath(locale, '/docs/'),
        nested: false
    }

    return {
        grouped: grouped.map((group) => {
            const key = groupKeyForTitle(group.title, locale)
            if (key === START_GROUP) {
                return { ...group, nodes: [overview, ...group.nodes] }
            }
            if (key === REFERENCE_GROUP) {
                return { ...group, nodes: [...group.nodes, ...rows] }
            }
            return group
        }),
        remaining
    }
}
