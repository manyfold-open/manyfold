---
'@manyfold/web': patch
---

The chat page no longer crashes on a model config view the browser cached before agents had runtime-auth bindings. Such an entry is discarded (the cache version is bumped and a cached view must carry its runtime-auth binding), and the page waits for the fresh view instead; before, the runtime sign-in card read the missing binding and the error boundary replaced the page on every reload.
