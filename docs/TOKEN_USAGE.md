# Token usage and context

## 0.4.0: a cache that holds, and attachments that are paid for once

- **Stable memory block.** The session memory system block is written when a participant starts and left unchanged for the rest of the run. It used to change after every tool call (recent actions, newly pinned skill pages), which made Anthropic rewrite the whole conversation into the cache on every step. Skill pages read during a run are no longer sent twice (tool result plus memory). The next message, and workers started later in the run, still see everything that was learned.
- **Compaction with headroom.** When the context passes 96,000 characters it is brought down to 72,000, so the following steps do not compact (and rebuild the cache) again. Old tool results are cleared first, keeping each call and a short excerpt; dropping exchanges and rounds comes after.
- **OpenAI `prompt_cache_key`.** Requests to `api.openai.com` (Chat Completions and Responses) carry a stable key per conversation and agent.
- **Attachments.** Pictures (downscaled to ≤ 1568 px, video stills ≤ 1024 px, at most 8 per message), native PDFs (≤ 24 MB, providers that support them) and up to 24,000 characters of extracted text are sent only with the message that carries them. Later messages list each file in one line; `read_attachment` reads it again in pages of up to 5,000 characters when needed. Image input is still estimated at 1,500 tokens per picture when the provider does not report usage; PDF input is estimated from its size.

See [PIPELINE.md](PIPELINE.md) for the sources behind these changes.

## November 2026: visual evidence and durable work briefs

The text context ceiling is now 96,000 characters. The original request, structured brief, recent user updates and acceptance review survive transcript folding and are shared with delegated workers. The last three exchanges still remain verbatim; `/clear` resets the brief and review as well as the digest.

Supported tool images are passed as image content rather than serialized into text. Each result accepts up to two images of 4 MB each; model context retains at most four recent comparison images. Pixels stay out of textual logs and workspace JSON. Actual provider usage is preferred; when unavailable, image input is estimated at 1,500 tokens per image, and the existing context meter represents text only. Costs depend on the provider and image encoding, so this estimate is not a billing prediction.

GPT-6 effort levels are transmitted without collapsing xhigh/max to high. Official GPT-6 tool requests use Responses; replayable output items, encrypted reasoning and assistant phase are preserved within the active run. Worker reports can be read in pages rather than losing details when their summary is shortened.

These changes allow more context and visual review, and can increase usage. There is still no per-message tool-loop or token budget; Stop cancels the run.

## 0.1.1: economy context

The previous runtime resent every connected MCP tool definition on each model step, allowed tool results as large as 120,000 characters, and retained up to roughly 1.5 million characters of request context. The displayed token counter accumulated every model step across the conversation.

This can make a multi-step task expensive even when its first user message is short. A high displayed conversation total does not prove that opening the agent made a paid request.

0.1.1 introduced provider-independent tool discovery, paged skills, bounded tool results, output caps, and a configurable per-message token budget. The budget and the step limit were removed in 0.2.0 (see below).

## 0.2.0: stop paying twice, stop forgetting

0.1.1 was cheap per request but forgetful between messages. Each new message rebuilt the prompt from only the user/assistant text of earlier messages, so tool rounds, loaded skill pages, and what had been inspected disappeared. The agent then read the same skills and re-inspected the same state. That is both the "reads skills all the time" and the "loses context" symptom.

What changed:

- **Skill pages are remembered.** Every page an agent loads is kept for the conversation (9,000 characters, oldest evicted first) and injected into the system prompt of later messages and of workers that have the skill. `load_skill` for a remembered page returns a one-line `alreadyLoaded` instead of the page.
- **Rolling digest.** Only the last three exchanges are sent verbatim. Older exchanges become one line each (request, tools used, result), built locally with no model call. Up to 14 lines or 3,500 characters; older lines shrink first. `/compact` folds immediately, `/clear` forgets.
- **Recent actions and plan.** The last eight tool actions of unfolded exchanges and the Master's plan are part of the memory block, so the agent knows what it already did without re-reading it.
- **Prompt caching.** Anthropic requests mark tools, system blocks, and the newest message as cacheable. The system prompt is split into a stable block (workspace prompt, agent prompt, skill catalog, access mode) and a memory block that changes only when something new is learned. OpenAI caches stable prefixes on its own, and other OpenAI-compatible servers vary; the same layout helps wherever prefix caching exists.
- **Context limit 48,000 characters** (was 36,000) because the memory block now lives inside it. The extra room is paid for by sending far less history.
- **Effort-aware output caps.** Reasoning consumes output tokens, so `/effort medium|high|xhigh|max` raises the per-request cap to 8,192 / 12,000 / 24,000.
- **Messages sent while an agent works** are delivered at the next step rather than starting a second run, and `/btw` answers from memory without adding to the agent's context.
- **Web pages are paged like skills.** `web_fetch` returns up to 5,000 characters at a time (6,000 with metadata) and continues at `nextOffset`; a page is downloaded once per message however many pages of it are read, and links back to the same page are dropped from the text.
- **Claude Code connections** report usage from Claude Code's final result (input including cache reads and writes, plus output). Nothing stops it early except Stop; a subscription is not billed per token, but long runs use up its limits faster.
- **Master Agent.** Reading and doing happens in worker threads on cheaper models; the Master sees only distilled reports. See [MASTER_AGENT.md](MASTER_AGENT.md).

## Regression coverage

- A large catalog is replaced by fewer than 2,000 characters of gateway definitions in the no-skill fixture, independently of catalog size.
- Old messages and tool rounds are removed without orphan tool results or dropping the current task.
- Escaped skill pages remain valid JSON within the output limit.
- Read-only calls remain enforced through the gateway.
- Unrestricted access executes mutations without application approvals and can release an existing pending approval, but never an agent-creation request.
- Usage is counted per run and separately from conversation totals; a Master's run includes its workers.
- Runs are not limited by steps, tokens, or requests: a long tool loop (60 rounds at 50,000 tokens each in the test) finishes, and only Stop ends one early.
- A skill page loaded in one message is not loaded again in the next.
- Exchanges beyond the last three are folded into the digest and the recent ones stay verbatim.
- Queued messages arrive before the next model request, including when they land during the final answer.
- Anthropic requests carry cache markers on every system block, the last tool, and the newest message; thinking blocks are replayed unchanged with their tool calls.
- Startup and conversation creation make no inference requests in the desktop test; slash commands never call the model.

Character limits and token estimates are not exact billing counters. Provider-reported totals can include cached input and reasoning/output tokens, and different providers apply different pricing or plan rules. No fixed percentage reduction in real plan usage is claimed. Live account consumption must be checked in the provider’s own usage controls; the inspector shows cached input when the provider reports it, which is the quickest way to confirm that caching is working.
