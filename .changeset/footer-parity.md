---
'@manyfold/web': patch
---

One footer across both sites, and "Cookie settings" stops being the one entry
in the row that looks different.

The landing's footer and the docs' had drifted apart in wording and in metrics
alike. The docs side called the same destination "Documentation" where the
landing calls it "Docs" — the one long label in a row of short nouns — carried
an "Ask AI" entry with no counterpart on the landing, was missing Agent
Challenge, and credited "Netmind" where the landing credits the brand, which is
also the name the white-label substitution knows how to rewrite. Underneath the
copy: 13px links with no tracking against the landing's 14px at -0.005em, a
brand mark that skipped the step down the landing applies in the footer (28px
against 24px), a copyright line and a social pair each set a tone paler than
the links beside them, and the hairline before that pair sitting 10px closer to
them. All of it now matches, and the row folds at the same two widths, which it
had not been doing at all — it kept its desktop metrics down to 375px, leaving
that hairline hanging at the start of a line once the links wrapped, with
nothing before it to divide.

"Cookie settings" is a button rather than a link, because it re-opens the
consent banner instead of going anywhere, and the footer's type rule only ever
named `a`. Preflight left the button at the body's size and full ink, so the
one control in that row read a step larger and darker than the six links around
it. It shares the rule now.

Two differences are deliberate and stay. "Cookie settings" is not on the docs
footer: that site loads no analytics and sets no cookies, so the entry would
open nothing — the consent banner it belongs to lives on the app. The support
chat is not there either, since every docs page already carries it as a bubble.

The privacy policy told the reader to find that control "in the site footer",
which was true of no footer that reader could be looking at: the policy is
served only from the docs site, including from the landing's own Privacy link,
so every reading of the sentence happened on the one footer without the
control. It now names the web app and its host. The other half of the sentence,
Settings -> Account, was and remains true.
