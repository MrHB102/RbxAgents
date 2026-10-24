# Economy context in 0.1.1

The previous runtime resent every connected MCP tool definition on each model step, allowed tool results as large as 120,000 characters, and retained up to roughly 1.5 million characters of request context. The displayed token counter accumulated every model step across the conversation.

This can make a multi-step task expensive even when its first user message is short. A high displayed conversation total does not prove that opening the agent made a paid request.

The updated runtime uses provider-independent tool discovery, paged skills, a 36,000-character context boundary, 6,000-character tool results, output caps, and a configurable per-message token budget. Context trimming runs locally and does not call another model. All bundled skills remain available.

Regression coverage verifies that:

- A large catalog is replaced by fewer than 2,000 characters of gateway definitions in the no-skill fixture, independently of catalog size.
- Old messages and tool rounds are removed without orphan tool results or dropping the current task.
- Escaped skill pages remain valid JSON within the output limit.
- Read-only calls remain enforced through the gateway.
- Unrestricted access executes mutations without application approvals and can release an existing pending approval.
- Usage is counted per run and separately from conversation totals.
- Model requests stop when the remaining budget is insufficient.
- Startup and conversation creation make no inference requests in the desktop test.

Character limits and token estimates are not exact billing counters. Provider-reported totals can include cached input and reasoning/output tokens, and different providers apply different pricing or plan rules. No fixed percentage reduction in real plan usage is claimed. Live account consumption must be checked in the provider’s own usage controls.
