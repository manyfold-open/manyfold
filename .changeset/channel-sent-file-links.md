---
'@manyfold/api': patch
---

When a channel sends a workspace file the agent linked in its reply, the link no longer shows in the text: it reads as its label, an image with no alt text disappears, and a line left empty is dropped. Chat apps that do not render Markdown (Narra Messenger shows `![](cards/the-tower.jpg)` as written) now show the reply and then the file, without a workspace path no one outside Manyfold can open. A reply that is nothing but the link keeps it, and channels with **Attach files the agent links** off are unchanged.
