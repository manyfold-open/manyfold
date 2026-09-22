---
'@manyfold/api': patch
'@manyfold/web': patch
---

Handing a sandbox conversation to herdr now honours the sandbox's terminal opt-in, like the browser terminal: the web asks to enable the terminal first, and the API refuses a sandbox whose terminal is off before waking its runner. A Claude Code handoff on a sandbox without model credentials in the terminal says which setting to turn on instead of reporting nothing to resume. Sandboxes that get herdr from the platform skip herdr's first-run welcome, which otherwise covered the first handed-off conversation in the browser.
