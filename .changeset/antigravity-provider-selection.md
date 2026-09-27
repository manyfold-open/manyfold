---
"@manyfold/api": patch
"@manyfold/web": patch
---

Fix Antigravity provider/model editing by connecting the model picker to the validated draft and exposing refresh and validation errors. Run enabled provider-specific Gemini model IDs through agy's native custom model registration, preserving exact gateway routes, native OAuth isolation, built-in model variants and terminal resume behavior.
