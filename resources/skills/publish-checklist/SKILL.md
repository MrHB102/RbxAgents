---
name: publish-checklist
description: >
  Runs evidence-based Roblox release gates covering performance, security, persistence, purchases, UX, assets, and rollout recovery. Use when asked to "check before publishing", "audit a release", "prepare a soft launch", "verify a game update", "review store readiness", or "plan rollback".
---

# Roblox Pre-Publish Checklist

## When to use

- Preparing a new public experience or a substantial update.
- Reviewing a release candidate against explicit device and player-count targets.
- Planning a staged rollout, monitoring window, and rollback.
- Checking that the tested build is the exact artifact selected for publishing.

## When NOT to use

- Implementing every issue discovered during review; route each fix to its owning feature.
- Publishing automatically without the user's applicable authorization.
- Treating a checklist pass as proof of zero defects or guaranteed discovery success.

## Core instructions

### 1. Freeze the release candidate and scope

1. Record revision, build artifact, universe, place IDs, package versions, and migration version.
2. ALWAYS distinguish completed checks, failed checks, and checks that were not run.
3. NEVER mark a gate passed from a screenshot or an assumption alone.
4. Define target devices, supported inputs, expected player count, and acceptable performance budgets.
5. Identify the release owner, observation window, rollback trigger, and recovery artifact.
6. Review the exact diff and all affected places before testing.
7. Keep staging data, products, endpoints, and admin permissions separate from production.
8. Publishing a place does not automatically complete every required universe-setting or package update.

### 2. Validate build identity and required structure

- Confirm the release entry point and required remotes exist with correct classes.
- Verify staging-only scripts and privileged debug remotes are excluded.
- Check spawn locations, map ownership, collision groups, and runtime asset references.
- NEVER delete unfamiliar instances merely because they look like test content.
- Confirm all creator/group-owned assets have permissions for the target experience.
- Test the exact built artifact, not only a locally modified Studio session.

This server or staging diagnostic checks explicit build identity.
Set BuildRevision and BuildEnvironment on ServerStorage through the build pipeline.
Use the returned values in the release evidence record.

```luau
--!strict
local ServerStorage = game:GetService("ServerStorage")
local ServerScriptService = game:GetService("ServerScriptService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local revision = ServerStorage:GetAttribute("BuildRevision")
local environment = ServerStorage:GetAttribute("BuildEnvironment")
assert(type(revision) == "string" and revision ~= "", "Missing build revision")
assert(environment == "staging" or environment == "production", "Unknown environment")
local main = ServerScriptService:FindFirstChild("ServerMain")
assert(main and main:IsA("Script"), "Missing server entry point")
local remotes = ReplicatedStorage:FindFirstChild("Remotes")
assert(remotes and remotes:IsA("Folder"), "Missing remotes folder")

return {
    revision = revision,
    environment = environment,
    universeId = game.GameId,
    placeId = game.PlaceId,
    jobId = game.JobId,
}
```

### 3. Run critical correctness gates

- Persistence: test new load, existing load, failed load, save failure, rejoin, and shutdown.
- Concurrency: test reconnect races, lost session ownership, and duplicate operations.
- Security: send malformed remote inputs and try unauthorized valuable actions.
- Purchases: replay receipts and simulate a committed write with a lost response.
- Gameplay: test first objective, core loop, death, respawn, late join, and disconnect.
- Multiplayer: use a real server/client setup with at least two clients for shared mechanics.
- Physics: test ownership transfer, unstable assemblies, collision, and high-speed hit detection.
- NEVER ship a known duplication exploit, data overwrite, or unfulfilled purchase path as a cosmetic issue.

### 4. Run performance and UX gates

- Measure client frame time, server step cost, memory trends, join time, and network traffic.
- Use realistic maps, simultaneous effects, inventories, and player counts.
- Test a slower supported mobile device and lower graphics settings.
- Navigate every required action with touch and gamepad where supported.
- Test device safe areas, text expansion, preferred text size, and reduced motion.
- Verify readable errors, loading feedback, audio controls, and non-audio critical cues.
- Check supported locales, fallback strings, and right-to-left content where promised.
- Inspect server and client Output for reproducible errors after a sustained session.

This staging-only inventory reports potentially active physical geometry.
Counts are diagnostic evidence, not universal pass/fail performance thresholds.
Pair them with profiling under the intended gameplay load.

```luau
--!strict
local Workspace = game:GetService("Workspace")
local RunService = game:GetService("RunService")
assert(RunService:IsStudio(), "Use this authoring diagnostic in Studio")

local counts = {parts = 0, unanchored = 0, shadowLights = 0, emitters = 0}
for _, instance in Workspace:GetDescendants() do
    if instance:IsA("BasePart") then
        counts.parts += 1
        if not instance.Anchored then counts.unanchored += 1 end
    elseif instance:IsA("Light") then
        if instance.Enabled and instance.Shadows then counts.shadowLights += 1 end
    elseif instance:IsA("ParticleEmitter") and instance.Enabled then
        counts.emitters += 1
    end
end

return counts
```

### 5. Review listing, policy, and operational readiness

- Confirm name, description, icon, thumbnails, and trailer reflect the playable experience.
- Review current publishing eligibility and maturity/compliance requirements in Creator Hub.
- Verify supported devices, access settings, localization, social links, and moderation processes.
- Check current prices, paid-random disclosures, policy gating, and advertised entitlements.
- NEVER rely on remembered age, regional, advertising, or publishing rules when current rules matter.
- Confirm telemetry can reveal load failures, receipt backlog, crashes, and core-loop drop-off.
- Assign someone to inspect reports during the soft-launch window.
- Keep support and data-recovery instructions available before accepting live purchases.

### 6. Make the release decision explicit

- Record each gate with evidence, owner, result, and unresolved impact.
- A skipped check is unknown, not passed.
- Block release for critical integrity, security, or purchase failures.
- Use a staged audience when traffic or platform controls allow it.
- Confirm user authorization immediately before any external action that still needs it.
- Publish the tested artifact and verify its identity in a fresh server.
- Observe the chosen guardrails and stop rollout when predefined triggers are crossed.
- Data migrations can make code rollback unsafe; prepare forward repair or compatibility first.

This pure gate evaluator prevents skipped checks from becoming an accidental approval.
The required gate names belong to the release contract, not a universal Roblox standard.

```luau
--!strict
type Status = "Passed" | "Failed" | "NotRun"
local required = {"Persistence", "Security", "Purchases", "Devices"}

local function ready(results: {[string]: Status}): (boolean, {string})
    local blocking: {string} = {}
    for _, name in required do
        if results[name] ~= "Passed" then
            table.insert(blocking, name)
        end
    end
    return #blocking == 0, blocking
end

assert(not select(1, ready({Persistence = "Passed"})))
assert(select(1, ready({
    Persistence = "Passed", Security = "Passed", Purchases = "Passed", Devices = "Passed",
})))
```

### 7. Verify after publication

- Join a fresh server on the live target and inspect the deployed revision.
- Exercise login, first action, save/rejoin, and approved purchase verification.
- Check that existing sessions and newly started sessions remain compatible.
- Compare error rate, loading, performance, receipt delay, and activation with the baseline.
- Preserve release evidence and document any rollback or recovery action actually taken.
- Never claim live verification if only the staging place was tested.

## Common mistakes

- Publishing from an untracked Studio session; identify and test the exact release artifact.
- Marking skipped device tests as passed; report them as unknown with their impact.
- Testing only one player; verify shared behavior across a real server/client boundary.
- Rolling back code after an incompatible schema migration; prepare compatible recovery first.
- Treating a successful publish request as successful gameplay; verify a fresh deployed server.

## Reference

- [Create and publish games and places](https://create.roblox.com/docs/production/publishing/publish-games-and-places).
- [Identify performance issues](https://create.roblox.com/docs/performance-optimization/identify).
- [Content maturity and compliance](https://create.roblox.com/docs/production/promotion/content-maturity).
