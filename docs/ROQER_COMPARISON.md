# Roqer comparison and quality improvements

Reviewed on November 2, 2026 against [S4US/Roqer commit 9e57b6f](https://github.com/S4US/Roqer/tree/9e57b6ff64adc71bb5b97517f38fe473664245cd). The reference checkout is under ignored `vendor/roqer-reference`, outside the application package. The changes below were implemented independently in RBX Agents.

## Findings

| Area | Roqer evidence | RBX Agents improvement |
| --- | --- | --- |
| Image feedback | Its custom loop preserves tool images and comparison history | Supported inline images now reach Chat Completions, Responses, Anthropic and Claude Code; four recent images are retained separately from text limits |
| Completion criteria | Developer instructions require relevant evidence and review of the changed revision | `set_brief` records acceptance criteria; `assess_quality` validates pass/revise/blocked; scene changes and pending writes invalidate prior evidence |
| Context continuity | Conversation records retain decisions and unfinished work | A persistent shared brief preserves the original request, constraints, references, criteria, recent updates and unresolved review issues |
| Design guidance | Dedicated visual/UI guidance and reference routing | Runtime quality instructions distinguish composition, scale, hierarchy, materials and visual review from functional checks |
| Provider continuity | Its provider integrations preserve provider-specific state | GPT-6 effort routing is fixed; Responses output items preserve encrypted reasoning, assistant phase and function calls during a run |
| Delegation | Its main architecture differs from RBX Agents' Master/worker design | Workers inherit the shared brief; current scene images reach the Master and full reports are available through `read_agent_report` |

Primary reference files: [agent-loop.ts](https://github.com/S4US/Roqer/blob/9e57b6ff64adc71bb5b97517f38fe473664245cd/apps/desktop/runtime/agent-loop.ts), [developer.md](https://github.com/S4US/Roqer/blob/9e57b6ff64adc71bb5b97517f38fe473664245cd/apps/desktop/agent/developer.md), [conversation-prompt.ts](https://github.com/S4US/Roqer/blob/9e57b6ff64adc71bb5b97517f38fe473664245cd/apps/desktop/runtime/conversation-prompt.ts), [codex-app-server.ts](https://github.com/S4US/Roqer/blob/9e57b6ff64adc71bb5b97517f38fe473664245cd/apps/desktop/runtime/codex-app-server.ts).

Roqer also has a different Studio bridge, specialized design references, asset pipelines and a Codex app-server integration. RBX Agents continues to use its own runtime and bundled bridge. Matching the model name does not match these surrounding capabilities, the reference material, model settings or the number of refinement attempts. This code comparison does not establish a measured aesthetic-quality advantage.

## Provider documentation

[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) supports low, medium, high, xhigh and max effort; medium is its default. Omitting medium therefore does not establish that medium-configured runs used less reasoning, but the old mapping prevented explicit control of high/xhigh/max for this model. Official GPT-6 tool calls require Responses. The implementation follows the [image input guide](https://developers.openai.com/api/docs/guides/images-vision) and [stateless reasoning replay guidance](https://developers.openai.com/api/docs/guides/reasoning).

## Validation and limits

The headless desktop suite uses Ubuntu/WSL2 and Xvfb with an isolated test profile, a fixture model API and a fixture MCP server. It tests real Electron startup, UI configuration, persistence, plugin installation into a temporary folder, image payload delivery and preview decoding. A third scenario passes a review, changes the scene again, attempts to finish prematurely, and must collect another image and pass a new review before completion.

Unit coverage includes effort payloads, parallel tool-result ordering, encrypted output replay, native Claude image blocks, bounded image memory, durable handoffs, reference-versus-scene evidence, stale evidence rejection and local-image inspection approval. Tests use fixtures, not live paid-model inference or a real Studio place. Revision tracking covers app-dispatched tool mutations, not manual Studio edits or changes from other clients. Actual artistic quality still needs representative tasks, references and visual evaluation with a real model. Composer attachments, automatic video-frame analysis and objective aesthetic scoring are outside this implementation.

The earlier installers in `release/communication-fix` predate these quality changes. Updated Windows installers containing this implementation are available as version 0.2.2 in `release/quality-update/`, including x64, ARM64, a combined installer and legacy x86.
