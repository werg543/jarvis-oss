# JARVIS-OSS

A framework for a personal AI assistant built on top of an agentic coding CLI (e.g. Claude Code). One orchestrator brain, a markdown memory vault, a roster of specialist sub-agents, and an always-on supervisor that routes cheap work to local models and only escalates to a frontier model when it matters.

This repo is the **framework, with the author's personal data removed**. You bring your own profile and memory; nothing here is tied to one person.

## The idea

- **Brain:** the agentic CLI you already use. `CLAUDE.md` is its standing brief: persona, how it works, and hard action gates.
- **Memory:** a plain-markdown vault under `memory/`. The assistant reads it at session start and appends to it as it learns. Your private facts live here and are gitignored.
- **Profile:** `PROFILE.md` (copy from `PROFILE.template.md`) is the one file that makes the assistant "yours", who you are, how you communicate, and your writing voice. Portable: drop it on any machine.
- **Agents:** `.claude/agents/*.md` are specialist definitions (research, coding, a reality-checker, ...). The orchestrator delegates to them.
- **Supervisor:** `tools/supervisor/` is an always-on loop. Cheap plain-code triggers fire first; only a real signal spends a model call, and a **cost cascade** routes it: local model → free cloud tier → frontier model. Sensitive content never leaves the machine.

## Quick start

1. Copy `PROFILE.template.md` to `PROFILE.md` and fill it in. (It's gitignored.)
2. Point your CLI at this folder so it reads `CLAUDE.md` and `.claude/agents/`.
3. (Optional) Run the supervisor:
   ```
   cd tools/supervisor && npm install && npm run build && node dist/index.js --once
   ```
   Replace the example trigger in `src/triggers/index.ts` with your own checks.

## Cost cascade

The supervisor's router (`tools/supervisor/src/dispatch.ts`) tries, in order:
1. **Local model** (Ollama) for basic tasks. Free, private, never leaves the box.
2. **Free cloud tier** (e.g. an OpenAI-compatible endpoint) for harder tasks. Set its key via env.
3. **Frontier model** for important work and every decision.

Hard rule baked in: anything touching email, finance, or secrets skips the cloud tiers and stays local or goes to the frontier model only.

## What's intentionally not here

No credentials, no live connector configs, no personal memory or business data. Bring your own keys via environment variables. See `.gitignore`.

MIT licensed.
