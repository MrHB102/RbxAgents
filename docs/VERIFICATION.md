# Verification record

Date: October 23, 2026. Host: Windows x64. Application version: 0.1.0.

## Automated checks

| Check | Result | Coverage |
| --- | --- | --- |
| TypeScript | Passed | Main process, preload, renderer, and test sources |
| Unit and integration tests | 18 passed | Complete skill library, path boundaries, credential fallback, restart recovery, fragmented UTF-8/SSE, provider URLs, mutation approval/denial, cancellation, read-only tools, OAuth state/PKCE/identity checks, serialized token refresh, and a real stdio MCP process with queued concurrent calls |
| Electron desktop test | Passed | Visible navigation, all 29 skills, full references, API connection form, model discovery, agent configuration, streaming tool loop, activity, prompt editing, persistence after restart, secret exclusion, and actual plugin installation into a temporary directory |
| Packaged Windows x64 smoke test | Passed | Production renderer, starter agents, all bundled skills, isolated user data directory, and the packaged MCP plugin installer |
| Windows installers | Built | Individual x64 and ARM64 installers plus a combined installer; unsigned. The two architecture payloads contain identical application ASAR hashes. |
| Upstream file comparison | 58 of 58 files identical | Every SKILL.md and references/full.md against roblox-brain commit ceee4aaa5004502e2a51d78b3c33bba44d84742b |
| Dependency audit | No known vulnerabilities reported | npm dependency audit at verification time |

The OAuth tests mock the token endpoint and signature verifier to test application control flow. Production uses jose to verify signed tokens against OpenAI’s published JWKS. These tests do not establish live OAuth account eligibility.

The provider integration test uses a local fixture API. The packaged plugin test executes the bundled upstream installer and verifies that its generated plugin file exists and exceeds 1 MB. All installer tests target temporary directories, not the user’s Studio plugin folder.

## Visual checks

The application was captured and inspected at 1440 × 960. A compact 1060 × 790 desktop capture was also generated. Checks covered agent cards, navigation, connection states, skill browsing, configuration dialogs, and conversation layout. The README screenshot is captured from the application.

## External and platform boundaries

- Live ChatGPT account authorization and live Anthropic inference have not been exercised with a user account.
- Real Roblox Studio place mutations and playtests have not been performed by this verification suite.
- Windows ARM64 packages are build targets; their runtime requires verification on ARM64 hardware.
- Linux x64/ARM64 and legacy x86/ARMv7 require their target build and runtime checks. CI workflows are included but have not been dispatched from this workspace.
- Code signing, publishing, automatic updates, image feedback, direct filesystem tools, and agent delegation are outside this preview.

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
