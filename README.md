<div align="center">

# RBX Agents

**Your agents. Your models. Your Roblox workspace.**

A local-first desktop app for managing specialized AI agents that work with Roblox Studio.
Built with a clean Dracula-inspired interface, a complete Roblox skill library, and a bundled MCP bridge.

![License: MIT](https://img.shields.io/badge/license-MIT-bd93f9)
![Desktop](https://img.shields.io/badge/desktop-Windows%20%7C%20Linux-8be9fd)
![Skills](https://img.shields.io/badge/bundled_skills-29-50fa7b)
![Status](https://img.shields.io/badge/status-desktop_preview-ffb86c)

</div>

![RBX Agents desktop workspace](docs/images/workspace.png)

## What you can do

- **Build your team.** Create, duplicate, pause, and configure agents. Start with a Master, Architect, Builder, Scripter, and Reviewer.
- **Let a Master Agent run the team.** The Master plans, delegates self-contained briefs to your specialists in parallel, and synthesizes their reports. Put a strong model on the Master and cheaper ones on the workers. It can propose new agents, but you must approve each one, even in Unrestricted mode. See [docs/MASTER_AGENT.md](docs/MASTER_AGENT.md).
- **Reach the internet.** Agents can search the web and read public pages (`web_search`, `web_fetch`), for example current Roblox documentation and DevForum answers. Local and private addresses are blocked. See [Web access](#web-access).
- **Steer while it works.** Send a message at any time: it is delivered before the agent's next step. Use `/btw` for a side question, `/model` and `/effort` to change model and reasoning depth from the chat.
- **Choose a model for each agent.** Connect OpenAI-compatible APIs, local inference servers, Anthropic, your installed Claude Code, or an eligible ChatGPT account. Discover models or enter a model ID yourself.
- **Set their instructions.** Combine a workspace system prompt, individual agent instructions, and selected skills.
- **Use all 29 Roblox skills offline.** The complete [roblox-brain](https://github.com/tabooharmony/roblox-brain) library ships with the app, including every `references/full.md`. Import additional local skill collections.
- **Connect directly to Studio.** The [Chrrxs Roblox Studio MCP](https://github.com/Chrrxs/robloxstudio-mcp) server and matching plugin are bundled. Install the plugin from inside the app without a separate Node.js installation.
- **Model and animate in Blender.** Connect [MCP for Blender](https://github.com/ahujasid/mcp-for-blender) with one click. The **Artist** agent inspects your scene, runs Blender Python (with your approval), and **posts rendered previews straight into the chat**: turntable videos, animation clips, and stills that play right there. See [docs/BLENDER.md](docs/BLENDER.md).
- **Choose an access mode.** Use Ask before changes, Read only, or **Unrestricted access** to execute tools without approval prompts. Calls to the same MCP server are serialized across agents.
- **Spend fewer tokens.** Discover MCP tools on demand, load paged skill references, keep bounded context, and remember what was learned between messages.
- **Keep your context.** Conversations, agent settings, token counts reported by providers, and recent activity are stored locally. Export agent definitions and the workspace prompt without credentials.

RBX Agents is a functional desktop preview. See [Current limitations](#current-limitations) for the verification and platform boundaries.

## Run from source

Requires **Node.js 24.18 or later**, npm, and Git. Installed desktop builds include their own runtime.

```bash
git clone https://github.com/MrHB102/RbxAgents.git
cd RbxAgents
npm ci
npm run dev
```

The `postinstall` step downloads the Electron runtime for your development machine.

To run the production build locally:

```bash
npm run build
npm run preview
```

## First launch

1. Open **Providers** and add a connection.
2. Select **Refresh models**, or use **Continue with ChatGPT** for a ChatGPT connection.
3. Open an agent’s **Configure** dialog and choose its provider and model.
4. Select its skills, instructions, permissions, and MCP connections.
5. Open **MCP bridges**, select **Install Studio plugin**, then fully close and reopen Roblox Studio.
6. Connect the Studio plugin, select **Connect bridge**, and use **Check Studio instances** to inspect availability.
7. Start a conversation with an agent and give it a task.

A connected MCP bridge does not by itself mean that a Studio place is connected. Agents are instructed to discover the target Studio instance before making changes.

For Blender, open **MCP bridges** and select **Install Blender add-on**, open Blender, then **Connect bridge** and **Check Blender**. Details are in [Blender](#blender).

For a planning-only conversation, turn off the agent’s MCP connections in **Configure → Connections**. This allows the agent to work without Studio running.

## Providers and authentication

### Economy mode and token usage

Economy context handling is on by default, including for existing agents:

- The model receives a small `search_tools` / `call_tool` interface instead of every connected MCP tool definition on every request. Exact tool schemas are discovered only when needed.
- All 29 skills remain installed. Skill instructions and references are loaded in pages of up to 5,000 characters. **Pages an agent has read are remembered for the whole conversation** (up to 9,000 characters, oldest evicted first) and shared with the workers that have the skill, so they are neither fetched nor re-paid for on every message.
- **Session memory replaces the old "forget on the next message" behavior.** The last three exchanges are sent verbatim. Older ones are folded locally into one line each (request, actions, result), together with a short list of recent actions and the current plan. No model call is used to summarize. `/compact` and `/clear` control this by hand.
- **Prompt caching.** For Anthropic models the app marks tools, system blocks, and the newest message as cacheable, so every step of a run re-reads its prefix at the cached price. Instructions are kept byte-stable between steps. OpenAI caches stable prefixes on its own; other OpenAI-compatible servers vary.
- Tool results are capped at 6,000 characters. Binary image/audio output is omitted from text context.
- Serialized model context and tool definitions are limited to 48,000 characters per request (the memory block is part of it). Old tool rounds are removed locally when needed. The current user request is preserved; oversized instructions fail before inference.
- **There are no per-message limits.** An agent works until it stops calling tools or you press **Stop**: no step limit, token budget, or request cap, for agents, a Master's workers, web access, or Claude Code. Stop ends everything, including workers and pending approvals. Watch the inspector's token counts while a long task runs, because a model that keeps calling tools will keep spending your provider's tokens.
- Each response is capped at 4,096 output tokens by default, because provider APIs require a cap. A higher `/effort` raises it (medium 8,192, high 12,000, xhigh/max 24,000) because reasoning uses output tokens.
- The conversation inspector separates **Conversation tokens**, **Last run tokens**, model request count, approximate context size, and cached input. Cached input is part of the reported input total, not an extra charge added by the app. Estimates are labeled when provider usage is unavailable.

Opening the app or creating a conversation does not start model inference. Inference starts only when you send a message. The conversation total is cumulative and can include earlier runs; it is not startup usage or a price estimate. Actual plan consumption and billing depend on your provider. See [OpenAI’s prompt-caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching) for the distinction between input, cached input, and cache writes.

### Chat commands and messages while it works

You do not have to wait for an agent to finish. A message sent while it works appears as **Queued** and is delivered as a `[User update]` before the agent's next model request (the request already in flight cannot be rewritten; use Stop to cut it short). Type `/` in the composer for suggestions.

| Command | What it does |
| --- | --- |
| `/btw <question>` | Side question. Answered immediately from the conversation and memory, with no tools, without interrupting the running task and without entering the agent's context. |
| `/model [name] [--save]` | Show or switch the model for this conversation. Accepts a partial name or `Provider:model`. `--save` also updates the agent. Applies from the next step, even mid-run. |
| `/effort [low\|medium\|high\|xhigh\|max\|default]` | Reasoning depth. Sent to Claude 4.5+ / 5.x (adaptive thinking plus `output_config.effort`) and OpenAI reasoning models; ignored by models that do not take it. |
| `/status` | Model, effort, tokens, cache reads, memory, plan, queued messages. |
| `/plan` | The Master's current plan. |
| `/compact`, `/clear` | Fold history into memory, or forget earlier context (the transcript stays visible). |
| `/stop`, `/help` | Stop the run; list commands. |

The composer also has model and effort selectors. Text such as `/Workspace/Map is broken` is sent normally because only the commands above are recognized.

### Web access

Every agent except an orchestrator gets two tools, which you can switch off per agent under **Configure → Connections**:

- `web_search` returns titles, URLs, and snippets. It uses DuckDuckGo by default, which needs no account but can rate limit automated searches. Add an optional **Brave Search API key** in **Settings → Web access** for a more reliable engine; the key is stored in the credential vault and sent only to Brave.
- `web_fetch` reads a public page or text file. HTML becomes readable text with headings, lists, code blocks, and links; long documents continue with `nextOffset`, and later pages of the same document are not downloaded again. A Master Agent has no web tools; its workers research for it.

Because a model chooses the addresses and page text can try to steer it, the app limits what it can do:

- Only the public internet: loopback, private, link-local, and cloud-metadata addresses are refused, including when a public name resolves to one and after every redirect. Only ports 80 and 443; no usernames in URLs.
- GET only, with no cookies or credentials. Text pages and data files only (no images, PDFs, or downloads), at most 2 MB, 15 seconds, and 5 redirects.
- Results carry `untrusted_web_content: true`, and the prompts tell agents to ignore instructions found in pages and never to put project code or secrets in a query or URL.
- Every web call is listed in the chat and under **Activity**.

Web access does not need approval in any access mode, because it changes nothing in Studio. Search queries go to the search engine, page requests go to the websites, and page text becomes part of what is sent to your model provider.

### Unrestricted access

Open **Agents → Configure → Permissions → Unrestricted access**, then save. The agent runs its available MCP tools without application approval prompts, including writes. Switching to this mode also releases pending application approvals for that agent, except requests to create a new agent, which always wait for you. Switching to Read only blocks subsequent mutations. Provider permissions, MCP server restrictions, and Stop still apply.

| Connection | Authentication | Inference API |
| --- | --- | --- |
| OpenAI-compatible | Your API key, or no key for a local server | Streaming Chat Completions with function tools |
| Anthropic | Your Anthropic API key | Streaming Messages API with tool use |
| ChatGPT | Browser authorization for RBX Agents | Public Responses API, using eligible ChatGPT plan usage |
| Claude Code | Claude Code's own sign-in, on Anthropic's site | The `claude` program installed on this computer, driven headlessly |

Built-in endpoint presets include OpenAI, OpenRouter, Ollama, and LM Studio. A compatible provider must support streaming chat completions and function tools to use the full agent runtime. Local HTTP is accepted on loopback addresses; remote endpoints require HTTPS. Endpoints should include their API path, usually `/v1`.

### Continue with ChatGPT

The app implements the documented [Sign in with ChatGPT flow for local and open-source tools](https://developers.openai.com/siwc/token-sharing-open-source/sign-in):

- A browser authorization request identifies the app as **RBX Agents**.
- Each installation has a stable host ID; each connection retains its own issued client ID and verified account identity.
- PKCE, state, nonce, and signed ID-token verification protect sign-in.
- Credentials remain in the desktop main process. Refreshes are serialized and rotated tokens are saved together.
- Inference requires the granted `chatgpt.tokens.use.direct` permission, uses `store: false` and `stream: true`, and succeeds only after `response.completed`.
- **Manage usage** opens [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).

Availability depends on OpenAI’s current eligibility rules, account, plan, workspace, and permissions. Creating a connection does not grant model access. This integration does not read your ChatGPT conversation history. A paid or hosted distribution may require separate approval from OpenAI; consult the current official documentation before changing the distribution model.

### Claude: API key, or your installed Claude Code

There are two ways to use Claude:

- **Anthropic API key.** Add an **Anthropic** connection. This is the route Anthropic documents for products built on Claude.
- **Claude Code.** Add a **Claude Code** connection, then select **Sign in with Claude**. The app runs `claude auth login`, which opens Anthropic's sign-in page and completes there. The same connection can use a Claude subscription or whatever Claude Code itself is signed in with.

How the Claude Code connection works:

- RBX Agents starts your own, unmodified `claude` program for each model turn (`claude -p`, streaming JSON). It was tested with Claude Code 2.1.310 and is found on your PATH or at the path you choose. A `.cmd` wrapper is not supported; use the native `claude.exe`.
- **The app never reads, copies, or stores Claude credentials or tokens.** Sign-in belongs to Claude Code. Only the account kind and Claude Code's version are shown in the app. Signing out of the app connection does not sign Claude Code out.
- Claude Code's built-in tools are switched off (`--tools ""`), user settings, slash commands, and other MCP servers are not loaded, and it runs in an empty temporary folder, so no project settings or memory files are found. Its only tools are the ones this app offers (`search_tools`, `call_tool`, `load_skill`, `web_search`, `web_fetch`, and the Master's delegation tools) through a loopback MCP server that exists for one turn and requires a random bearer token. Every call goes through the agent's access mode, approvals, step limit, and token budget.
- Messages you send while it works are delivered inside its next tool result, so steering works here too. `/model` accepts `fable`, `opus`, `sonnet`, `haiku`, or a full model ID, and `/effort` maps to Claude Code's `--effort`.
- It starts a process per turn, so each turn has a short startup cost.

**Anthropic's terms matter here.** Their [authentication and credential-use guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) says OAuth sign-in is for Claude Code and Anthropic's own apps, that developers building products should use API keys, and that third-party apps may not offer Claude.ai login or route requests through Free, Pro, or Max plan credentials on behalf of users. The same page allows a person to sign in to the unmodified Claude Code binary with their own subscription. This connection keeps credentials entirely inside Claude Code, but whether driving it from another application is within Anthropic's terms is Anthropic's call, not this project's, and they state they may enforce their rules without notice. If that risk is not acceptable for you, use an API key.

## Bundled Roblox skills

All four upstream collections are included. No network access is required to browse or load them after installation.

| Collection | Skills |
| --- | --- |
| **Core · 10** | `roblox-collaboration-mode`, `roblox-luau-core`, `roblox-luau-types`, `roblox-luau-patterns`, `roblox-architecture`, `roblox-networking`, `roblox-security`, `roblox-data`, `roblox-server-data`, `roblox-performance` |
| **Gameplay · 10** | `roblox-building`, `roblox-physics`, `roblox-npc-ai`, `roblox-camera`, `roblox-input`, `roblox-gui`, `roblox-animation-vfx`, `roblox-lighting`, `roblox-audio`, `roblox-localization` |
| **Design · 5** | `roblox-game-design`, `roblox-player-psychology`, `roblox-growth-design`, `roblox-analytics`, `roblox-monetization` |
| **Tools · 4** | `roblox-studio-mcp`, `roblox-tooling`, `roblox-cloud`, `roblox-publish-checklist` |

The upstream commit and license are preserved in [resources/roblox-brain](resources/roblox-brain). The runtime exposes a skill catalog and a `load_skill` tool so agents can read selected instructions and reference files on demand. The collaboration-mode entry point is also included automatically when selected.

To add a custom skill, choose **Skill library → Import skills**, then select a folder containing one or more `SKILL.md` files. The app copies the collection into its local data folder. Enable imported skills separately for each agent.

```text
my-skill/
├── SKILL.md
└── references/
    └── full.md
```

## Roblox MCP

The application pins **`@chrrxs/robloxstudio-mcp` 3.3.0**, including its matching `MCPPlugin.rbxmx`. The installer invokes the package’s own `--install-plugin` command using the bundled Electron Node runtime. It does not need to download or execute an unpinned npm package at launch.

The default Windows plugin location is detected by the upstream installer. A custom Plugins folder can be selected in **MCP bridges → Configure Roblox Studio**. After installation or replacement, restart Studio completely. The upstream installer may replace its existing plugin or remove the other edition to maintain version compatibility.

### Linux and Wine

RBX Agents runs natively on Linux. Roblox Studio itself requires a compatible Wine setup. Before installing the plugin, select the Studio **Plugins** directory inside your Wine prefix. Where needed, configure the upstream bridge environment using `ROBLOX_STUDIO_WINE_LAUNCHER`, `ROBLOX_STUDIO_EXE`, and related non-secret settings. See the [upstream Linux configuration](https://github.com/Chrrxs/robloxstudio-mcp/blob/main/docs/configuration.md#native-linux-with-wine).

Custom MCP servers support **stdio**, **Streamable HTTP**, and **legacy SSE**. HTTP/SSE connections can store a bearer token in the credential vault. Local server commands run as your OS user; configure executables you trust. The environment editor is for non-secret values and is stored in plain text with the workspace.

## Blender

RBX Agents connects to Blender through [MCP for Blender](https://github.com/ahujasid/mcp-for-blender) (`mcp-for-blender` **2.2.4**, MIT). It is not bundled: the app runs it with [uv](https://docs.astral.sh/uv/) at the pinned version, so the add-on and the server that talks to it are always the same release.

**Install Blender add-on** (in **MCP bridges**) does four things: installs uv if it is missing (it asks first, then runs Astral's official installer), runs `mcp-for-blender install-addon`, turns the add-on on in the saved preferences of each Blender it finds (a copy of Blender starts briefly with no window), and tells you to restart Blender. Open Blender and the add-on connects by itself; **Check Blender** shows what it reports.

- The **Artist** agent works with Blender. Any agent can be given the Blender connection under **Configure → Connections**.
- `render_preview` renders a turntable, the scene's animation, or a still in your open Blender and posts it in the chat as a playable video (MP4 or WebM) or an image. `share_media` shows an image or video that already exists on your computer. Previews are stored in the app's `media` folder and deleted with their conversation.
- Looking tools run freely; anything that changes Blender (`execute_blender_code`, `generate_3d`, `import_asset`, `render_preview`) follows the agent's access mode, and the Python of each script is shown before you approve it.
- The server's usage telemetry is switched off, and its two data-collection tools are hidden from agents.

The add-on listens on this computer only and has no password. Any program on your computer can reach it while Blender is open. See [docs/BLENDER.md](docs/BLENDER.md) for security notes, the exact files touched, and troubleshooting.

## Desktop builds

Build artifacts are written to `release/`. Build on the target OS, or use the included GitHub Actions build matrix. This repository does not automatically publish releases.

```bash
# Windows NSIS installer with x64 and ARM64 payloads
npm run dist:win

# Linux AppImage and Debian packages: x64 and ARM64
npm run dist:linux

# Build only the current host target
npm run dist
```

| Platform | Architecture | Build track |
| --- | --- | --- |
| Windows 10/11 | x64, ARM64 | Current Electron 45 |
| Linux | x64, ARM64 | Current Electron 45 |
| Windows 10, 32-bit | x86 / ia32 | Optional legacy Electron 43 |
| Linux, 32-bit ARM | ARMv7 | Optional legacy Electron 43; tarball |
| Linux, 32-bit Intel; other CPU families | ia32, RISC-V, others | Not supported by these Electron builds |

```bash
# Optional legacy targets
npm run dist:legacy:win
npm run dist:legacy:linux
```

“All architectures” is not a platform guarantee: Electron does not supply binaries for every CPU and OS combination. [Electron 44 removed Windows x86 and Linux ARMv7](https://www.electronjs.org/blog/electron-44-0). The legacy commands pin 43.8.3, whose support ends in January 2027; these are separate compatibility builds, not a long-term security track. Windows 11 does not have a 32-bit x86 edition. Linux compatibility also depends on the distribution’s system libraries.

Local verification is performed on Windows x64. Linux, ARM64, and legacy packages need builds and runtime checks on their target systems before distribution. Code signing is not configured; locally generated installers are unsigned.

## Development and checks

```bash
npm run typecheck
npm test
npm run verify:skills
npm run test:e2e
npm run test:package # After creating a Windows x64 package
npm run build
npm audit
```

Two opt-in groups of tests use a real Blender and open it briefly in a throwaway profile; see [docs/BLENDER.md](docs/BLENDER.md#what-was-verified).

The desktop end-to-end test starts an isolated Electron profile and a local test API. It exercises the visible UI, provider discovery, streamed agent output, skill loading, persistence after restart, and actual plugin installation into a temporary folder. The package smoke test checks the compiled executable, bundled resources, and plugin installer with another isolated profile. These tests do not require paid API credentials or modify the developer’s Studio plugin folder. On a headless Linux host, run desktop tests through a suitable virtual display such as Xvfb.

## Storage and privacy

Data is saved under Electron’s per-user application data directory, typically `%APPDATA%/rbx-agents` on Windows and `$XDG_CONFIG_HOME/rbx-agents` or `~/.config/rbx-agents` on Linux.

- `workspace.json`: settings, agent definitions, provider metadata, conversations, skills, MCP configuration, and the latest 500 activity events.
- `credentials.enc`: encrypted API keys, HTTP MCP bearer tokens, the optional Brave Search key, and ChatGPT credentials, when secure OS storage is available.
- `skills/`: imported local skill collections.
- `media/`: previews agents posted in chats (videos and images). Only their descriptions are in `workspace.json`; the files are removed when their conversation is deleted.

On Windows, credential encryption uses the OS-backed Electron `safeStorage` implementation. On Linux, the app requires an available secure keyring and rejects the `basic_text` fallback. Without a secure keyring, credentials remain in memory for the current session only. Conversations and configuration are not encrypted at rest.

The renderer has no Node.js access. A narrow preload bridge validates actions in the main process. Credentials are excluded from state snapshots and exports. Provider requests are sent from the main process, and known credentials are redacted from error/activity output. No analytics or telemetry service is configured, and the Blender server's own usage telemetry is switched off.

Messages, selected skill content, MCP tool results, and web page text are sent to the provider selected for the conversation. Local storage does not make a remote provider’s inference private to your device.

## Architecture

```text
src/
├── main/       Electron lifecycle, validated IPC, storage, OAuth, providers,
│               skill loader, MCP processes, Blender setup, preview media, and agent runtime
├── preload/    Narrow typed renderer bridge
├── renderer/   React desktop interface and Dracula-inspired CSS
└── shared/     Domain types, starter agents, and default instructions
resources/     Complete bundled Roblox skill library and attribution
tests/         Unit tests and Electron desktop integration tests
```

Independent agent conversations can run concurrently. Each uses a snapshot of its agent configuration at start; access-mode changes, `/model`, and `/effort` also apply to active runs. A Master's workers are extra threads inside its run (at most the concurrency limit at once) that abort with Stop. The runtime supports model/tool loops, the selected access mode, cancellation, and explicit failures on incomplete provider streams. Studio calls to the same MCP server are queued to prevent interleaved actions.

## Current limitations

- Live ChatGPT OAuth, live Anthropic API inference, and real Studio place edits require the user’s account and Studio connection; fixture tests do not establish those external services’ availability.
- Agents can show you previews, but they cannot see them: images from Blender's `look` tool are left out of the text sent to the model, and you cannot attach images to a message. Multimodal screenshot feedback is not implemented.
- The Master Agent delegates within one message: worker threads live for that message, and a worker cannot see the conversation or other workers. Workers do not run in the background after the Master answers, and there is no shared task board between conversations.
- The project folder setting labels your workspace. Direct project filesystem tools, terminal access, and Rojo synchronization are not implemented; Studio access goes through MCP.
- MCP OAuth discovery, automatic skill updates, configuration import, automatic application updates, and signed releases are not implemented.
- The app serializes its own Studio calls. It cannot coordinate external MCP clients or manual Studio edits made at the same time.
- Blender is busy while a preview renders, and Stop cannot interrupt a render already running inside Blender. Previews need Blender on the same computer. The one-click Blender install is verified on Windows with Blender 4.5 and 5.2; macOS and Linux use the same steps but have not been run.

## Credits and license

- [TabooHarmony/roblox-brain](https://github.com/tabooharmony/roblox-brain): all 29 skills and complete references, MIT; bundled license preserved.
- [Chrrxs/robloxstudio-mcp](https://github.com/Chrrxs/robloxstudio-mcp): Studio MCP server and plugin, MIT; upstream package license preserved.
- [ahujasid/mcp-for-blender](https://github.com/ahujasid/mcp-for-blender): the Blender add-on and MCP server the integration installs and runs, MIT. Downloaded on first use, not bundled. [uv](https://docs.astral.sh/uv/) by Astral runs it.
- [Dracula](https://draculatheme.com/): palette inspiration.
- Electron, React, Lucide, the Model Context Protocol TypeScript SDK, Zod, YAML, and jose.

RBX Agents is an independent project and is not affiliated with or endorsed by Roblox, OpenAI, Anthropic, or the Dracula project.

Released under the [MIT License](LICENSE).
