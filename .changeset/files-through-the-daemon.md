---
'@manyfold/api': minor
---

Files, backups and storage readings on a sandbox or a cloud computer now go through the machine's daemon, as they already did on a self-owned computer. An upload of up to 200 MB streams in chunks and replaces its target only once it has fully arrived, on every kind of machine; a self-owned computer needs a Manyfold CLI with streamed writes for uploads and attachments, and says so when it is older. Backups stream both ways, without the 100 MB limit cloud computers and self-owned computers had. A sandbox's storage is measured while it is up, never as it goes to sleep, which woke it again. File errors from the machine now come back as a clear not found, conflict, forbidden or unavailable status instead of an internal error.
