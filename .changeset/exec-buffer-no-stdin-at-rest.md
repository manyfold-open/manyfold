---
'@manyfold/cli': patch
---

The daemon no longer keeps a command's input on disk. A script sent as a command's input was saved with the command's record for up to a day; now it is only held until the command has read it.
