---
'@manyfold/web': patch
'@manyfold/admin': patch
---

Signing in returns you to the link you opened.

Opening a page that needs an account while signed out sent you to the sign-in
form and then dropped you on the workspace, so a shared link like
`/agents/new?framework=narranexus` was only useful to someone already signed
in — the path and everything after the `?` were discarded before the page ever
loaded. The attempted address now travels with you and is restored once you are
in, whichever way you sign in: password, a new account plus its verification
code, Google, SSO or NetMind. That covers every page behind sign-in, so a link
to a specific chat, a filtered list, or the connection you just authorised
survives the detour, and a session that expires mid-visit resumes where it
left off instead of at the top.

The admin console does the same. Its sign-in page previously ignored a return
address entirely, and its Google/SSO round trip only remembered which app you
came from, not which page.

Only in-app paths are honoured, unchanged from before: an absolute URL in the
return address is refused rather than followed.
