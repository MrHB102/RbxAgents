# Verification record

Application version: 0.2.0. The 0.2.0 rows below were run on Windows x64 on October 25, 2026. Rows marked "0.1.1" were not repeated for 0.2.0.

## Automated checks

| Check | Result | Coverage |
| --- | --- | --- |
| TypeScript | Passed (0.2.0) | Main process, preload, renderer, and test sources |
| Unit and integration tests | 56 passed (0.2.0) | Prior coverage plus messages queued during a run, `/model`, `/effort`, `/btw`, `/stop`, remembered skill pages, folded history, Master delegation (parallel workers, follow-ups, budget exhaustion, unknown workers), plan memory, agent creation approval that Unrestricted access cannot bypass, Anthropic cache markers, effort fields, thinking replay, and workspace migration |
| Electron desktop test | Passed (0.2.0) | Visible navigation, five starter agents including the Master, all 29 skills, full references, API connection form, model discovery, agent configuration, streaming tool loop, slash-command suggestions and a command that makes no model request, activity, prompt editing, persistence after restart, secret exclusion, and actual plugin installation into a temporary directory |
| Packaged Windows x64 smoke test | Passed (0.1.1) | Production renderer, starter agents, all bundled skills, isolated user data directory, and the packaged MCP plugin installer |
| Windows installers | Built (0.1.1) | Individual x64 and ARM64 installers plus a combined installer; unsigned. The two architecture payloads contain identical application ASAR hashes. |
| Upstream file comparison | 58 of 58 files identical (0.1.1) | Every SKILL.md and references/full.md against roblox-brain commit ceee4aaa5004502e2a51d78b3c33bba44d84742b |
| Dependency audit | No known vulnerabilities reported (0.1.1) | npm dependency audit at verification time |

The OAuth tests mock the token endpoint and signature verifier to test application control flow. Production uses jose to verify signed tokens against OpenAI’s published JWKS. These tests do not establish live OAuth account eligibility.

The provider integration test uses a local fixture API. The packaged plugin test executes the bundled upstream installer and verifies that its generated plugin file exists and exceeds 1 MB. All installer tests target temporary directories, not the user’s Studio plugin folder.

## Visual checks

The application was captured and inspected at 1440 × 960. A compact 1060 × 790 desktop capture was also generated. Checks covered agent cards, navigation, connection states, skill browsing, configuration dialogs, and conversation layout. The README screenshot is captured from the application.

## External and platform boundaries

- Live ChatGPT account authorization and live Anthropic inference have not been exercised with a user account. The Anthropic prompt-caching, effort, and thinking-replay request shapes follow the current Messages API documentation and are verified against recorded request bodies, not against the live service.
- Master Agent runs and `/btw` were tested with scripted model responses; no live multi-model run has been performed.
- Real Roblox Studio place mutations and playtests have not been performed by this verification suite.
- Windows ARM64 packages are build targets; their runtime requires verification on ARM64 hardware.
- Linux x64/ARM64 and legacy x86/ARMv7 require their target build and runtime checks. CI workflows are included but have not been dispatched from this workspace.
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

For other package executable locations, pass the path directly:

```bash
node scripts/smoke-package.mjs path/to/rbx-agents.exe
```
