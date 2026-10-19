---
'@manyfold/api': patch
---

The sandbox status sync now reads a sprites account 500 sprites per page instead of 50. When a listing stops before its end, the sprites it did not reach are no longer counted as gone, and the partial count is not recorded as the account's usage. The provider probe in Admin says when it saw only part of the account.
