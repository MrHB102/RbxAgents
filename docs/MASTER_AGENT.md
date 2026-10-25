# Master Agent: plan big, execute small

The Master Agent follows the orchestrator pattern from Anthropic's cookbook, [Orchestrator pattern: big models for planning, small models for execution](https://github.com/anthropics/claude-cookbooks/blob/main/managed_agents/CMA_plan_big_execute_small.ipynb). A strong model plans, delegates, and synthesizes. Cheaper models do the token-heavy reading and doing in their own context windows and report back distilled findings.

The cookbook runs on Anthropic's hosted Managed Agents. RBX Agents runs the same shape locally, on any provider you connect.

## How it maps

| Cookbook | RBX Agents |
| --- | --- |
| Orchestrator with no tools of its own, only a `multiagent` block | An agent with **Orchestrator** turned on. Its tools are `list_agents`, `update_plan`, `delegate`, `send_to_agent`, `create_agent`, plus `load_skill` for planning skills. It has no Studio connection by default. |
| `create_agent` / `send_to_agent` / `list_agents` | `delegate` starts worker threads (1 to 4 per call, in parallel). `send_to_agent` continues a thread with its context intact. |
| Workers scoped to the tools their job needs | Each worker is one of your agents, with its own model, skills, MCP connections, and **access mode**. A Reviewer stays read-only even when the Master asks for a change. |
| Worker ends with `send_to_parent` | A worker's final message is its report, capped and returned as the `delegate` result. Raw pages and logs never reach the Master. |
| "The orchestrator can't see its workers' system prompts" | The Master's instructions include a live roster built from the real agent definitions (id, specialty, description, model, access, skills). It cannot drift from the workers. |
| Inline agents disabled, so the split holds | The Master can only delegate to listed agents. A new one needs `create_agent`, which you must approve. |
| Session `budget` caps the whole team | The Master's **Team token budget per message** covers the Master and every worker. Each worker also stays within its own budget. A worker that runs out returns `status: "budget"` with its partial result, and the Master decides what to do. |
| Per-thread `usage` | The conversation inspector lists tokens and status per worker for the last run. |
| Re-assign on infrastructure errors | The Master prompt tells it to re-delegate a failed brief once. |

## Setting it up

1. Connect a provider and configure the **Master** (strong model, for example Claude Opus or Fable, or the best OpenAI model you have).
2. Configure Architect, Builder, Scripter, and Reviewer with cheaper models. Workers do the reading, so the saving comes from them.
3. Start a conversation with the Master and give it a goal. It writes a plan (shown in the inspector, kept in memory), delegates, reads reports, verifies risky changes with a read-only worker, and answers once.

Delegation has a fixed cost per worker, and the cookbook measured that splitting the same work into more, narrower briefs can raise the bill. The Master prompt tells it to answer directly when no Studio work is needed and to prefer a few well-scoped briefs.

## Creating agents

The Master can call `create_agent` when no worker fits a recurring need. This **always** opens an approval card showing the name, specialty, model, access mode, skills, system prompt, and the Master's reason:

- It is required even when the Master, or every agent, is set to Unrestricted. Switching a Master to Unrestricted does not release a pending request.
- The new agent can be `ask` or `read-only` only, never Unrestricted. It copies provider, model, and Studio connection from an existing worker.
- If you decline, the Master is told not to ask again.

## Safety properties

- Each worker's tool calls use that worker's access mode and approval flow. Approvals show which agent is asking.
- Studio calls from all workers are serialized per MCP server, so parallel workers cannot interleave mutations. The Master is told to run writers on the same target one after another.
- Stop aborts the Master, its workers, and any waiting approvals. Messages you send while a Master runs are delivered to the Master before its next step; it passes relevant changes on to workers through follow-ups.
- Worker threads only live for one message. If you need a worker to continue later, the plan and the folded memory tell the Master what happened.

## Limits

- Up to four tasks per `delegate` call. At most your **Concurrent agents** setting run at once; the rest wait.
- A worker report is capped at roughly 5,400 characters across a delegate call; workers are told to keep reports under 250 words.
- Quality depends on briefs. Workers cannot see the conversation, so the Master is instructed to include instance IDs, paths, constraints, and your decisions in each brief.
