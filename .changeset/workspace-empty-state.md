---
'@manyfold/web': patch
---

The workspace answers for itself when there are no agents yet.

`/workspace` was a route that could not be visited. With no agent to open it
forwarded straight to the create form, which made every "back to workspace"
affordance a loop and forced that form to hide its own close button — there was
nowhere to close back to. A first-time account therefore met the product as a
form with a single button, having never seen the page that form belongs to.

It renders a first-use empty state now, and only redirects when there is an
agent to open. The state follows §10.7 rather than inventing its own: the
object's own glyph, a title that names the fact, a body saying what having an
agent gets you — its own sandbox, chat, skills, a schedule — and exactly one
creation action inside the dashed frame that means "your action fills this".
Because creating is something you navigate to rather than something you are
sent to, the browser's back button now returns you to the workspace.
