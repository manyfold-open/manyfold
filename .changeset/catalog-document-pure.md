---
---

Internal move only: `catalogDocumentFromRows` lives with the catalog sync code, so the unit test that covers it no longer imports the `framework-catalog` script, which reads DATABASE_URL. The import, export and release behaviour is unchanged, so there is no release note.
