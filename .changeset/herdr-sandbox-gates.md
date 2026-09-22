---
'@manyfold/api': patch
'@manyfold/web': patch
'@manyfold/cli': patch
---

herdr handoff follow-ups. Handing a sandbox conversation to herdr now honours the sandbox's terminal opt-in, like the browser terminal: the web asks to enable the terminal first, and the API refuses a sandbox whose terminal is off before waking its runner. A Claude Code handoff on a sandbox without model credentials in the terminal says which setting to turn on. Sandboxes that get herdr from the platform skip herdr's first-run welcome. In the web, right-clicks inside the embedded herdr go to herdr's own menu instead of the browser's; a conversation left in herdr comes back in herdr when you return to it or reload, and moving between conversations herdr holds keeps the same view and only moves herdr's focus; the notes that sat above the composer about herdr and the Chat UI move behind a "?" after the header's view switch (a stuck import keeps its banner, with retry and abandon). The daemon no longer raises a herdr notification each time the web moves focus. Handing the same conversation to herdr again takes over its existing tab instead of adding another, and a daemon that restarts (an upgrade, a sandbox runner brought back after a suspension) adopts the herdr panes it opened, so their conversations stay handed off and their tabs still close.
