# Verification record

## Blender bridge 0.2.3 — November 4, 2026

- Found two independent per-call cutoffs: 120 seconds in RBX Agents and a hardcoded 180-second socket read in `mcp-for-blender@2.2.4`. Blender calls now allow 610 seconds, and the pinned uvx server is launched with a process-local adapter extending its socket read to 600 seconds. Custom bridge commands are preserved. Render previews share the same policy.
- Stdio stderr is consumed to prevent Python logging from filling an unread pipe. A real stdio fixture writes 2 MiB of stderr per call and still completes serialized requests.
- `npm test`: 158 passed, 11 opt-in live tests skipped. The focused MCP suite also passed after the final stream-drain adjustment. Its SDK-backed simulated clock test crosses 181 seconds, checks cancellation, and verifies timeout diagnostics without replaying mutations.
- `RBX_LIVE_BLENDER_MCP=1 npx vitest run tests/unit/blender-bridge.live.test.ts`: passed. The real pinned Python MCP server completed a 185-second response from an isolated TCP add-on fixture with exactly one execution. No real Blender scene or user profile was modified.
- `npm run build`: TypeScript and production build passed. Real Blender geometry generation and long GPU renders were not exercised by this regression test.
- Windows x64 installer generated at `release/blender-connection-fix/windows/RBX-Agents-0.2.3-win-x64.exe`. After packaging finished, the isolated packaged smoke test passed (renderer, version, skills, Blender defaults, media protocol and temporary plugin installation). An earlier smoke attempt while packaging was still modifying the payload timed out; the completed payload passed on rerun. The packaged ASAR version and runtime SHA-256 match the build. Installer size/header and SHA-256 were verified; checksums are in `release/blender-connection-fix/SHA256SUMS.txt`. Installer is unsigned. Other platform installers were not regenerated in this fix.

## Windows 0.2.2 installers — November 2, 2026

Updated Windows installers containing the quality-workflow implementation were generated in `release/quality-update/`: separate x64 and ARM64 installers, a combined x64/ARM64 installer, and a legacy x86 installer. Current targets use Electron 45.0.0; x86 uses 43.8.3. Package metadata and lockfile were advanced to application version 0.2.2 without creating a Git tag.

The production build and TypeScript checks passed. Packaged smoke tests passed for x64 and x86 using isolated profiles, including renderer startup, 29 skills, access-mode settings, media protocol registration and installation of the bundled plugin into a temporary folder. PE architecture headers, packaged version and identical runtime SHA-256 were checked for x64, ARM64 and x86. All four installers passed size/header checks; hashes and sizes are in `SHA256SUMS.txt` and `build-manifest.json` in the output folder. Windows signing status is unsigned. ARM64 was inspected but not executed on ARM hardware.

## Quality workflow and headless desktop — November 2, 2026

- `npm run build`: TypeScript and production builds passed on Windows; the Linux headless job also built successfully.
- `npm test -- --maxWorkers=2 --reporter=dot`: 157 passed, 10 opt-in live tests skipped (23 files).
- `npm run test:headless:linux`: 3 desktop scenarios passed under Ubuntu 24.04/WSL2 with Xvfb. The latest run completed in 18.8 seconds after building.
- The third desktop scenario performs an initial acceptance review, dispatches a later mutation, attempts to finish with stale evidence, then obtains another image and passes a new review. The session ends idle with its acceptance contract and current review persisted.
- Provider tests cover actual image payload shapes, parallel tool-result ordering, GPT-6 effort/Responses routing, opaque reasoning and assistant-phase replay, native Claude image input/output, image budgets, and rejection of stale/reference-only visual acceptance. Local image inspection approval and refusal paths are covered.
- The Blender fixture now returns real PNG image content from `look`. Desktop tests verify that those pixels reach the fixture provider without entering workspace JSON.

Logs and screenshots are under `test-results/headless-linux/`; `headless.log` records the build and test verdicts, and `visual-acceptance-headless.png` shows the guarded completion flow. These tests use an isolated profile, local fixture API and MCP processes. They do not measure live model aesthetics or establish real Studio/Blender availability. The prior installers in `release/communication-fix/` predate this implementation. See [ROQER_COMPARISON.md](ROQER_COMPARISON.md) for findings, source references and remaining differences.

## Agent communication fixes — November 1, 2026

Verified in the source workspace on Windows x64. Updated distribution files were subsequently generated in `release/communication-fix/`, as recorded below.

- `npm test -- --reporter=dot --maxWorkers=2`: 142 passed, 10 opt-in live tests skipped. Two workers avoid overloading process-startup tests with short polling deadlines.
- `npm run build`: TypeScript and production builds passed.
- `npx playwright test`: both desktop scenarios passed against isolated local fixtures.
- `git diff --check`: passed.

Communication failure paths corrected:

- A delegated model or MCP connection that ignores cancellation no longer prevents Stop from completing. A stopped run rejects late output and cancels remaining workers, including those waiting for execution slots.
- Claude Code now reports a lost tool-result connection, even if the subprocess remains alive. Silent inference fails after two minutes without stdout; the inactivity timer is suspended during tool execution, delegation, and human approval. Long productive tasks retain their unlimited tool loop.
- Cancelling a queued MCP call returns immediately while preserving serialization for later actions.
- A malformed delegation task returns its own error instead of discarding valid sibling reports.
- Parallel approvals retain the waiting state until all are resolved, and approvals in other conversations stay visible in the global banner.
- Restart recovery restores queued user messages to the next model context and clears stale running worker statuses.
- Claude Code side questions now receive the required callback while retaining their tool-free behavior. Windows subprocess cleanup retries transient folder locks.

Regression coverage includes cancellation during `send_to_agent`, late provider responses, a blocked worker plus a queued worker, mixed valid/invalid task batches, concurrent approvals, cancelled MCP waiters, subprocess silence, connection loss during a tool, long tool execution, and restart recovery. Live paid model inference and real Studio mutations were not exercised in this patch; the exact original incident could not be matched to a provider log supplied by the user.

## Distribution builds — November 1, 2026

All six architecture targets configured by the project were packaged from the corrected runtime, keeping application version 0.2.1:

| System | Architecture | Distribution formats | Electron |
| --- | --- | --- | --- |
| Windows | x64, ARM64 | Separate NSIS installers plus a combined installer | 45.0.0 |
| Windows legacy | x86 / ia32 | NSIS installer | 43.8.3 |
| Linux | x64, ARM64 | AppImage and Debian package for each architecture | 45.0.0 |
| Linux legacy | ARMv7 / armv7l | tar.gz | 43.8.3 |

Nine distribution files and their `SHA256SUMS.txt` are in `release/communication-fix/`. A Portuguese `LEIA-ME.md` identifies each file. Older files in the release root were preserved. The package homepage was added to `package.json` to fix the existing Debian build failure caused by missing project metadata.

Verification passed for PE/ELF architecture headers and identical SHA-256 hashes of `out/main/index.js` extracted from all six ASARs. Both Debian package payloads contain the same ASAR as their corresponding application trees; their architecture/version fields were checked. The ARMv7 tar archive was read successfully through its end.

Packaged smoke tests passed on Windows x64 and x86, and on Linux x64 in Ubuntu 24.04 under WSL2 with Xvfb. They checked opening the renderer, all 29 skills, configuration persistence/access mode, media protocol registration, and installation of the bundled Studio plugin into a temporary directory. Only the Linux root test harness used `--no-sandbox`; the shipped application was not changed to disable its sandbox. ARM packages were built and inspected, but were not executed on ARM hardware. Windows installers are unsigned.

Application version: 0.2.1. The 0.2.1 rows below were run on Windows x64 on October 25, 2026. Rows marked "0.2.0" or "0.1.1" were not repeated for 0.2.1.

## Automated checks

| Check | Result | Coverage |
| --- | --- | --- |
| TypeScript | Passed (0.2.1) | Main process, preload, renderer, and test sources |
| Unit and integration tests | 134 passed, 10 opt-in live tests skipped (0.2.1) | Prior coverage plus messages queued during a run, `/model`, `/effort`, `/btw`, `/stop`, remembered skill pages, folded history, Master delegation (parallel workers, follow-ups, budget exhaustion, unknown workers), plan memory, agent creation approval that Unrestricted access cannot bypass, Anthropic cache markers, effort fields, thinking replay, workspace migration, web access (address and URL policy including mapped IPv6 and redirects to metadata addresses, text extraction, search parsing, size limits, no cookies or credentials sent, paging with one download, no step, token, or request limits (a 60-round, 3-million-token tool loop and 60 web requests finish), the per-agent switch, and prompt migration), and the Claude Code connection (loopback bridge authentication, no tool-call or token limits, stop, status, and runtime transcript order), the Blender connection (installer branches with stand-in processes, add-on port and Blender discovery, tool filtering and read-only classification, migration to schema 5, uv missing, approval/denial/read-only/failure paths of `render_preview`, `share_media`, scratch cleanup), and the media store (content checks, range requests, id-only lookup, cleanup) |
| Electron desktop test | 2 tests passed (0.2.1) | Visible navigation, six starter agents including the Master and the Artist, all 29 skills, full references, API connection form, model discovery, agent configuration, streaming tool loop, slash-command suggestions and a command that makes no model request, activity, prompt editing, persistence after restart, secret exclusion, and actual plugin installation into a temporary directory. The second test runs the Blender flow against stand-ins: one-click install, a connected bridge, Check Blender, and an agent posting a test-double render plus a real MP4, WebM, and PNG rendered by Blender 5.2. The MP4 and WebM are checked to actually load and play (decoded size and no media error), nothing overflows the window, and only descriptions are saved with the conversation |
| Packaged Windows x64 smoke test | Passed (0.2.1) | Production renderer, six starter agents, the pinned Blender connection with telemetry off and the Artist agent, the preview protocol registered in the packaged app, all bundled skills, isolated user data directory, and the packaged MCP plugin installer |
| Windows installers | Built (0.2.1) | Individual x64 and ARM64 installers plus a combined installer; unsigned. Only the x64 package was run (smoke test); the ARM64 installer was built but not executed. |
| Real Blender, preview script | 8 passed on Blender 4.5 and 5.2 (0.2.1) | Opt-in (`RBX_BLENDER`, headless). Turntable as MP4 and WebM, the scene animation, and a still; the output is ingested as valid media; render settings, camera, light, world, objects, and frame range are identical before and after |
| Real Blender, add-on and server | 2 passed on 4.5 and on 5.2 (0.2.1) | Opt-in (`RBX_LIVE_BLENDER`, opens a Blender window for seconds, throwaway profile). The real `mcp-for-blender` 2.2.4: `install-addon`, enabling it with the app's own function, connecting over the add-on's socket, scene info, hidden data-collection tools, and a turntable rendered inside the open Blender and posted as a video. The app's one-click installer was also run for real against a pretend Windows profile |
| Upstream file comparison | 58 of 58 files identical (0.1.1) | Every SKILL.md and references/full.md against roblox-brain commit ceee4aaa5004502e2a51d78b3c33bba44d84742b |
| Dependency audit | No known vulnerabilities reported (0.1.1) | npm dependency audit at verification time |

The OAuth tests mock the token endpoint and signature verifier to test application control flow. Production uses jose to verify signed tokens against OpenAI’s published JWKS. These tests do not establish live OAuth account eligibility.

The provider integration test uses a local fixture API. The packaged plugin test executes the bundled upstream installer and verifies that its generated plugin file exists and exceeds 1 MB. All installer tests target temporary directories, not the user’s Studio plugin folder.

## Visual checks

The application was captured and inspected at 1440 × 960. A compact 1060 × 790 desktop capture was also generated. Checks covered agent cards, navigation, connection states, skill browsing, configuration dialogs, and conversation layout. The README screenshot is captured from the application.

## External and platform boundaries

- Live ChatGPT account authorization and live Anthropic inference have not been exercised with a user account. The Anthropic prompt-caching, effort, and thinking-replay request shapes follow the current Messages API documentation and are verified against recorded request bodies, not against the live service.
- Master Agent runs and `/btw` were tested with scripted model responses; no live multi-model run has been performed.
- Web access was exercised against the real internet by an opt-in test (`RBX_LIVE_WEB=1`): a DuckDuckGo search, reading a Wikipedia page, and refusing a public name that resolves to 127.0.0.1. DuckDuckGo's HTML results are scraped and may change or rate limit; the Brave Search path is tested against a recorded response shape, not the live API.
- The Claude Code connection has unit tests against a stand-in `claude` that connects to the real loopback bridge, and one opt-in live test (`RBX_LIVE_CLAUDE=1`) that ran the installed Claude Code 2.1.310 on Windows through the agent runtime. The browser sign-in itself (`claude auth login`) was not exercised. Whether this use is within Anthropic's terms for subscription plans has not been confirmed with Anthropic.
- Real Roblox Studio place mutations and playtests have not been performed by this verification suite.
- The Blender integration was exercised on Windows with Blender 4.5 and 5.2, uv 0.11, and `mcp-for-blender` 2.2.4. macOS, Linux, other Blender versions, and the interactive uv installer prompt (the app asks, then runs Astral's official installer) were not exercised. The real server's `generate_3d` and `import_asset` (third-party services and credits) were not run. See [BLENDER.md](BLENDER.md#what-was-verified).
- Windows ARM64 packages are build targets; their runtime requires verification on ARM64 hardware.
- Linux x64 was subsequently built and smoke-tested under WSL2/Xvfb, and Windows x86 was tested on Windows x64 (see the November 1 build record). Linux ARM64/ARMv7 and Windows ARM64 still require runtime checks on their target hardware. CI workflows are included but have not been dispatched from this workspace.
- Code signing, publishing, automatic updates, image feedback, and direct filesystem tools are outside this preview.

## Reproduce

```bash
npm ci
npm run typecheck
npm test
npm run verify:skills
npm run test:e2e
npm run dist:win
npm run test:package
```

The Blender tests that need a real Blender are skipped unless you point them at one:

```bash
RBX_BLENDER="C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" npx vitest run tests/unit/blender.live
RBX_LIVE_BLENDER="C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" npx vitest run tests/unit/blender-addon.live
```

For other package executable locations, pass the path directly:

```bash
node scripts/smoke-package.mjs path/to/rbx-agents.exe
```
