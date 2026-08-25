// Navigational trailer sections: an h2 whose whole body is a bullet list of
// links out of the page, always the last section. "See also" is the common
// name; there are ten across the corpus and both locales.
//
// They are not sections in the sense the rest of the machinery means. Measured
// across the build before this file existed: 54 of them carried a heading
// anchor, 41 appeared in an inline table of contents, and **0 were linked from
// any other page**. An anchor exists so a reader can cite one section, and the
// body here is nothing but links leaving the page, so there is nothing to cite;
// if you wanted to share what is in one you would share its target. The inline
// TOC is worse than merely useless: its entire justification is that the
// section list lands in extracted text and tells an answer engine what the page
// covers, and this is the one entry in that list that describes no content.
//
// So the anchor and the TOC entry are dropped. The right rail used to keep
// them, on the grounds that jumping to the end of a page is a real thing a
// reader does; there is no right rail now — the inline list is the only
// section list — so a trailer is listed nowhere. That follows the same
// argument rather than reversing it: the list exists to tell a reader and an
// extractor what the page covers, and a section of outbound links covers
// nothing. The heading keeps its id, so a link someone has already written to
// one still resolves.
//
// A name list rather than structural detection, deliberately, because the two
// consumers cannot both do the same thing: the rehype plugin walks the whole
// tree and could detect this by shape, but DocArticle only receives Astro's
// headings array (depth, slug, text) and never sees a section's body. One
// fragile-but-shared list beats two different detectors that can disagree.
//
// The fragility is real: rename a heading and this silently stops matching,
// with nothing failing. That is covered rather than accepted. check-seo.mjs
// re-detects trailers **structurally** from the built HTML and asserts none is
// anchored and none is in a TOC, so a rename turns into a build failure instead
// of a silent regression. Add a name here and the gate agrees again.
//
// Eight names for one thing is still untidy, and after this file the names cost
// nothing functionally, so unifying the rest is editorial rather than required.
// Channel guides / 渠道指南, Learn next / 继续了解 and Next steps / 下一步 are
// deliberate and consistent across locales; leave them.
//
// Two names have already gone. channels/session-switching and channels/weixin
// said "See also" in English while their zh twins said 相关链接 and 参见, which
// was a translation slip rather than a choice; both now say 另请参阅 like the
// other twenty-two. The gate below re-detects trailers by shape, so it would
// have caught the rename either way.
export const TRAILER_HEADINGS: readonly string[] = [
    'See also',
    'Learn next',
    'Next steps',
    'Channel guides',
    '另请参阅',
    '继续了解',
    '下一步',
    '渠道指南'
]

const normalized = new Set(TRAILER_HEADINGS.map((t) => t.trim().toLowerCase()))

// Matches on the heading's visible text. Callers pass whatever they have:
// rehype passes the text it collects from the heading's children, DocArticle
// passes Astro's `heading.text`.
export const isTrailerHeading = (text: string | undefined): boolean =>
    typeof text === 'string' && normalized.has(text.trim().toLowerCase())
