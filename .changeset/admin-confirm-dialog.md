---
'@manyfold/admin': patch
---

Deleting a self-owned computer in Admin now confirms in a dialog that keeps keyboard focus inside it and returns focus to the Delete button when it closes. A delete that fails now shows its error inside the dialog; before, the error appeared on the page behind it, where it could not be seen.
