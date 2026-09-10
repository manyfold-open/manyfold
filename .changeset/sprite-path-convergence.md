---
"@manyfold/api": patch
---

Sprite shell reconciliation now removes duplicate managed activation directories
from inherited PATH values. Login shells keep one activation entry first while
preserving custom paths, empty entries and all other directories in their original order.
