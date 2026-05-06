# HTML-PPT Agent V2

This directory is the isolated codebase for the IR-first HTML-PPT agent rewrite.

The v2 invariant is strict:

1. The LLM produces typed JSON only.
2. HTML and CSS are rendered deterministically from validated IR.
3. Layouts, themes, donors, animations, FX, and assets are closed-set catalogs.
4. Playwright/render verification checks the final visible deck after deterministic rendering.

The legacy `html-ppt-agent.service.ts` remains the v1 pipeline while v2 is developed behind a feature flag.

Planned module layout:

```text
html-ppt-v2/
├── ir/
├── registry/
├── renderer/
├── stages/
├── prompts/
├── orchestration/
└── tests/
```
