---
'@manyfold/web': patch
---

The runtime page's sign-in terminal now shows what you type. `claude auth
login` does read the code pasted at its `Paste code here if prompted >`
prompt, but it echoes none of it, so the terminal looked dead and there was
no way to tell whether anything had been entered. The sign-in command now
leaves the terminal to `cat` and pipes it into the CLI, which is enough to
get the echo back — the same code, typed or pasted, still reaches the CLI.
