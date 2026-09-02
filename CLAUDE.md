# CLAUDE.md

See **[AGENTS.md](AGENTS.md)**. This project keeps its agent context in one file so every tool
(Claude Code, Codex, Cursor, Aider, Zed) reads the same thing and the two cannot drift.

Read it before changing anything — especially the "Invariants that were violated during
development" section, which lists bugs that already shipped once. They all look like reasonable
code, which is why they came back.
