---
name: tooling
description: >
  Sets up reproducible Roblox source synchronization, toolchains, static checks, tests, and release builds. Use when asked to "set up Rojo", "configure Luau checking", "add CI", "run Roblox tests", "fix a build pipeline", or "manage Wally dependencies".
---

# Roblox Developer Tooling

## When to use

- Mapping source files into a Roblox place with Rojo.
- Pinning CLI tools and package dependencies for consistent builds.
- Adding formatting, linting, type checks, and meaningful automated tests.
- Repairing CI failures and separating build from deployment.

## When NOT to use

- Editing an active Studio DataModel through MCP; that belongs to studio-mcp.
- Choosing the game's module ownership model; that belongs to architecture.
- Approving release readiness; that belongs to publish-checklist.

## Core instructions

### 1. Inspect the existing workflow

1. Identify project mappings, package manifests, lockfiles, tool versions, tests, and CI configuration.
2. ALWAYS use the project's established tool manager and test runner when they work.
3. NEVER add a second package manager or formatter for the same files without a migration need.
4. Record which source files own each synced Studio instance.
5. Preserve authored terrain, binary models, packages, and source not represented in the project mapping.
6. Keep generated outputs out of editable source locations.
7. Do not claim that a source sync or build automatically includes unsaved Studio edits.
8. Make clean-checkout reproduction the baseline for CI reliability.

### 2. Establish reproducible source synchronization

- Use a Rojo project tree that maps server code to ServerScriptService.
- Map public shared modules and remotes to ReplicatedStorage.
- Map client entry points to the appropriate StarterPlayer or StarterGui containers.
- Pin a compatible Rojo CLI/plugin major version.
- Use `rojo build default.project.json --output build/game.rbxlx` for an inspectable build artifact.
- Use `rojo serve default.project.json` for live source sync when that is the project's workflow.
- NEVER sync a broad mapping into a valuable place without inspecting the affected tree.
- Keep development sync and production deployment as separate pipeline steps.

### 3. Make domain logic executable without Studio when appropriate

- Put pure calculations in modules that do not call game:GetService at import time.
- Inject clocks, randomness, persistence adapters, and service calls where tests need control.
- NEVER mock the entire Roblox engine to test a small arithmetic function.
- Use the existing TestEZ or custom runner if the project already has one.
- A standalone Luau or Lune runner cannot prove Roblox replication, physics, or asset permissions.
- Include Studio integration tests for those engine-dependent behaviors.

This pure ModuleScript can be tested without Roblox services.
Save it at the project's shared module path and map it through the existing Rojo tree.

```luau
--!strict
local function totalCost(unitPrice: number, quantity: number): number
    assert(unitPrice >= 0 and unitPrice <= 1_000_000 and unitPrice % 1 == 0)
    assert(quantity >= 1 and quantity <= 100 and quantity % 1 == 0)
    return unitPrice * quantity
end

local function canAfford(balance: number, cost: number): boolean
    assert(balance >= 0 and balance < math.huge)
    assert(cost >= 0 and cost < math.huge)
    return balance >= cost
end

return {totalCost = totalCost, canAfford = canAfford}
```

The corresponding Studio test checks outcomes and rejected inputs.
Adapt only the require path to the actual project mapping.
Use a separate test place or test entry point so tests do not run in production.

```luau
--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
assert(RunService:IsStudio(), "Test entry point is Studio-only")

local module = ReplicatedStorage:WaitForChild("Shared"):WaitForChild("ShopMath")
local ShopMath = require(module)

assert(ShopMath.totalCost(25, 3) == 75)
assert(ShopMath.canAfford(75, 75))
assert(not ShopMath.canAfford(74, 75))

local acceptedInvalid = pcall(function()
    ShopMath.totalCost(25, 0)
end)
assert(not acceptedInvalid, "Zero quantity must be rejected")

local acceptedNaN = pcall(function()
    ShopMath.canAfford(0 / 0, 10)
end)
assert(not acceptedNaN, "NaN balance must be rejected")
print("ShopMath tests passed")
```

### 4. Layer checks according to what they prove

- Run StyLua for formatting if already adopted; avoid unrelated formatting churn.
- Run Selene or existing lint rules with Roblox-aware standard-library configuration.
- Use a matching Roblox type environment for luau-lsp or the project's type checker.
- NEVER invent global definitions to hide real missing-service or wrong-class diagnostics.
- Use Wally or pesde according to the existing project, preserving the lockfile.
- Pin tools through Rokit or the existing manager; do not install floating latest versions in CI.
- Keep dependency download credentials outside source, place files, and build logs.
- Publish test reports and build artifacts even when diagnostics fail where the CI system permits it.
- A successful parser pass does not prove type safety or correct engine API usage.

### 5. Validate the built hierarchy

- Inspect the actual generated place rather than assuming a successful command means correct mapping.
- Check required entry points, classes, attributes, remotes, and config.
- NEVER ship test-only admin tools, fake product grants, or privileged debug remotes.
- Use environment identity to prevent staging builds from touching production stores.
- Record revision and toolchain versions in the build metadata.

This Studio assertion checks a concrete build contract.
It is a smoke check, not a replacement for gameplay integration tests.

```luau
--!strict
local ServerScriptService = game:GetService("ServerScriptService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local server = ServerScriptService:FindFirstChild("ServerMain")
local shared = ReplicatedStorage:FindFirstChild("Shared")
local remotes = ReplicatedStorage:FindFirstChild("Remotes")

assert(server and server:IsA("Script"), "Missing server entry point")
assert(shared and shared:IsA("Folder"), "Missing shared module folder")
assert(remotes and remotes:IsA("Folder"), "Missing remote folder")
assert(not ReplicatedStorage:FindFirstChild("TestAdminRemote"), "Test remote leaked into build")

print("Build hierarchy smoke check passed")
```

### 6. Separate CI validation from deployment

- Build and test on review branches without production credentials.
- Grant deployment credentials only to the release job for an explicitly selected target.
- Upload the artifact already validated rather than rebuilding with a different dependency state.
- Keep place publication, universe settings, and server restart decisions explicit.
- Preserve a previously known-good artifact and a data-compatible rollback path.
- Document engine-dependent checks that CI cannot execute in the chosen environment.
- Never report a test as passed when the runner skipped it or could not connect to Studio.

## Common mistakes

- Syncing over authored content without checking mappings; inspect the target tree first.
- Using floating CLI versions in CI; pin the same toolchain used locally.
- Treating pure tests as physics validation; add the relevant Studio integration scenario.
- Running test scripts in live servers; isolate test entry points from production mappings.
- Rebuilding differently at deployment; publish the exact tested artifact.

## Reference

- [Rojo documentation](https://rojo.space/docs/v7/).
- [Luau type checking](https://luau.org/typecheck).
- [Studio testing modes](https://create.roblox.com/docs/studio/testing-modes).
