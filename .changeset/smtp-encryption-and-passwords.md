---
'@manyfold/api': patch
'@manyfold/admin': patch
---

Require STARTTLS before SMTP authentication or message delivery when implicit TLS is disabled. Relays without a working TLS upgrade now fail before any password or email is sent. Clarify the TLS modes in Admin settings and preserve significant leading and trailing whitespace in SMTP passwords.
