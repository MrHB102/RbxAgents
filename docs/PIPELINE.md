# Agent pipeline: what it does and why

RBX Agents runs one loop for every agent and every worker: build the context, ask the model, run the tools it asks for, repeat until it answers without a tool call or you press Stop. This page lists the published guidance that shaped the loop in 0.4.0 and what changed because of it.

## Sources

- OpenAI, [*A practical guide to building agents*](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf): start with a single agent and add a manager (orchestrator) only when needed; clear tool definitions; layered guardrails with human approval for high-risk actions; explicit exit conditions; use smaller models where they are good enough.
- Anthropic, [*Building effective agents*](https://www.anthropic.com/engineering/building-effective-agents) (Dec 2024): prefer the simplest pattern that works; orchestrator-workers when subtasks are not known in advance; parallelize independent work; get ground truth from the environment at every step; invest in the agent-computer interface (tool descriptions, poka-yoke arguments).
- Anthropic, [*Effective context engineering for AI agents*](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (Sep 2025): context is a finite resource; just-in-time retrieval through lightweight references (paths, ids) instead of pre-loading; compaction, with clearing old tool results as its lightest form; sub-agents that return condensed reports; token-efficient tool output.
- Manus, [*Context engineering for AI agents: lessons from building Manus*](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) (Jul 2025): the KV-cache hit rate is the key production metric for cost and latency; keep the prompt prefix stable and the context append-only; make compression restorable (drop content, keep the path); keep errors in context; avoid repetitive ruts.
- HandsOnLLM, [*An Illustrated Guide to AI Agents*](https://github.com/HandsOnLLM/An-Illustrated-Guide-To-AI-Agents): the companion code covers the same building blocks (tools, memory, planning, reflection, multi-agent collaboration) that the loop already implements.

## What was already in place

Single agents by default and an optional Master (orchestrator-workers) with self-contained briefs and condensed reports; tool discovery through `search_tools` instead of sending every MCP schema; skill pages and web pages loaded just in time and paged; local, model-free folding of old exchanges into a digest; access modes and human approvals for writes; a structured work brief and evidence-based `assess_quality` for visual work; Stop as the exit of last resort.

## What changed in 0.4.0

| Change | Guidance it follows | Effect |
| --- | --- | --- |
| The session memory system block is written once per participant and no longer rewritten every step. | Stable prefix, append-only context (Manus); prompt caching. | Before, "Recent actions" and newly pinned skill pages changed this block after every tool call. Because it sits before the conversation, every step re-wrote the whole conversation into the Anthropic cache (a cache write costs more than plain input) instead of reading it. Skill pages loaded during a run were also sent twice: in the tool result and again in the memory. |
| Compaction brings the context down to 75% of the limit, not just under it. | Compaction (Anthropic); cache stability. | Once a run hit the limit, every following step compacted again and invalidated the cache again. Now compaction happens once per burst. |
| Old tool results are cleared before anything else is dropped; the tool call and its arguments stay, with a short excerpt. | "Clearing tool results is the lightest form of compaction" (Anthropic); restorable compression (Manus). | The agent keeps the trail of what it did and can re-run a tool, instead of losing whole rounds. |
| OpenAI requests carry a per-conversation `prompt_cache_key`. | OpenAI prompt caching. | Requests of one conversation are routed to the same cache. |
| Independent read-only calls in one response run concurrently. | Parallelization (Anthropic). | Lower latency for research-heavy steps. Anything that changes state still runs in order. |
| Three identical calls with identical results add a note to the result. | Keep errors visible, avoid ruts (Manus). | A stuck loop is pointed out to the model. Nothing is blocked; there is still no step or token limit. |
| Attachments: pictures and documents go with the message that carries them; later messages only reference them by `media_id` and path, and `read_attachment` brings them back page by page. | Just-in-time retrieval, lightweight references (Anthropic, Manus). | A conversation does not pay again for a 30-page PDF or a set of screenshots on every later message. Images are downscaled on your computer before they are sent. |
| Attachment content is labeled as data, not instructions. | Guardrails (OpenAI). | Text inside a file is treated as content unless you ask the agent to follow it. |

## Measuring it

The conversation inspector shows **Cached input** for each run. With an Anthropic model, a multi-step run should now show most of its input as cached after the first step; before 0.4.0 the cached share stayed low because the prefix changed every step. Actual prices and plan usage depend on the provider.
