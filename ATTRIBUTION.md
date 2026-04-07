# Attribution and Acknowledgements

OpenGolem is an original work by Jim Moraga. The following open-source projects
provided architectural inspiration and, in the case of NanoClaw, were the starting
point from which OpenGolem was progressively rewritten into its current form.

---

## NanoClaw

**Repository:** https://github.com/qwibitai/nanoclaw
**Author:** Gavriel
**License:** MIT — Copyright (c) 2026 Gavriel

NanoClaw established the core pattern OpenGolem builds on: a single Node.js
orchestrator routing messages through per-group Docker containers running the
Claude Agent SDK, with filesystem-based IPC, SQLite state storage, and a
sentinel-marker protocol for streamed agent output.

OpenGolem began as a fork of NanoClaw and has been progressively rewritten
into an original work through a complete clean-room rewrite (completed
2026-04-07). All source files have been replaced with clean-room
implementations written from behavioral specifications, with no NanoClaw
source remaining. The MIT license is reproduced below for attribution.

NanoClaw MIT License:

```
MIT License

Copyright (c) 2026 Gavriel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## OpenClaw

**Repository:** https://github.com/openclaw/openclaw
**License:** MIT

> *"Your own personal AI assistant. Any OS. Any Platform. The lobster way. 🦞"*

OpenClaw was the first massively popular always-on agentic assistant built on
Claude. It demonstrated that a persistent, socially-present AI — one that lives
in a group chat, remembers context across days, and acts on behalf of its users
without being explicitly invoked — was something people actually wanted.
OpenGolem's design philosophy of an always-on, per-group isolated assistant
owes its existence to OpenClaw proving the concept at scale.

---

## MicroClaw

**Repository:** https://github.com/microclaw/microclaw
**License:** MIT

MicroClaw demonstrated a provider-agnostic agentic runtime with strong isolation
primitives, a config-driven skill system, and full observability. Its SOUL.md
personality file pattern, per-chat context compaction model, and clean separation
between channel adapters and agent core informed OpenGolem's design.

---

## Original contributions

The following are original works by Jim Moraga, not derived from any of the above:

- Token Broker (scoped HMAC token issuance and revocation)
- Cato oversight layer (inline gate and scheduled audit)
- Call Inspector (per-API-call audit log)
- Credential proxy (M1 native proxy; replaces NanoClaw's OneCLI dependency)
- Telegram and TUI channel implementations
- Alef's SOUL.md character and assertiveness system
- Sender allowlist and Telegram group filtering
- Session compaction guard and self-service recovery commands
