---
---

Comment and release-note wording only: six comments and two paragraphs of an
already-published web release note now say "marketing page" instead of a term
the editions vocabulary scan bans from the public tree, because that term names
a commercial module the cloud edition owns. Nothing rendered, no behaviour, no
user-visible change — so no release note is owed.

The banned term is deliberately not spelled here: `changeset version` copies a
changeset body verbatim into an append-only CHANGELOG, and the scan reads that
file too, so explaining the word by writing it is how the previous attempt
failed the gate it was fixing.
