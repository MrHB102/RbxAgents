---
name: collaboration-mode
description: >
  Coordinates Roblox development teams, source ownership, place branches, and safe integration. Use when asked to "set up Team Create", "choose a branch strategy", "resolve a place conflict", "coordinate developers", "review a teammate's changes", or "prepare a shared playtest".
---

# Roblox Collaboration Mode

## When to use

- Establishing ownership for scripts, map regions, packages, and shared assets.
- Combining Team Create editing with source control and review.
- Resolving overlapping edits to a place or a shared ModuleScript.
- Planning an integration playtest involving several developers.

## When NOT to use

- Designing module boundaries; that is the architecture skill's subject.
- Configuring compiler and build commands; that is the tooling skill's subject.
- Running final release gates; that is the publish-checklist skill's subject.

## Core instructions

### 1. Establish the collaboration contract

1. Identify the universe, place IDs, source folders, and current editing session.
2. Record the source of truth for scripts, terrain, models, and configuration separately.
3. ALWAYS inspect existing instructions and uncommitted work before changing files.
4. NEVER overwrite another developer's edits to obtain a clean diff.
5. Assign one integration owner and a reviewer for shared contracts.
6. Record which developer owns each map region and shared package during the task.
7. Keep permissions scoped to the work; NEVER share account credentials.
8. Treat playtest data, published production data, and local fixtures as separate environments.

### 2. Choose a branch and place strategy

- Use short feature branches for serialized source and configuration.
- Use isolated development places for incompatible world or terrain experiments.
- NEVER assume a Git branch isolates an already connected Team Create session.
- Team Create edits a shared place; coordinate overlapping instance changes explicitly.
- Use draft review where supported, and verify which scripts have actually been committed.
- Export an inspectable model or place snapshot before a risky merge.
- Prefer text source and stable instance paths for changes requiring code review.
- NEVER attempt to resolve a binary place conflict by concatenating files.
- Designate an owner to reconcile conflicting geometry in Studio.
- Record package version changes and downstream places requiring an update.

The following server diagnostic makes an integration build identifiable.
Place it in ServerScriptService; attributes contain identifiers, NEVER secrets.
Set the attributes through the build pipeline before publishing.

```luau
--!strict
local RunService = game:GetService("RunService")
local ServerStorage = game:GetService("ServerStorage")

local info = ServerStorage:FindFirstChild("BuildInfo")
if not info then
    info = Instance.new("Folder")
    info.Name = "BuildInfo"
    info.Parent = ServerStorage
end

local revision = info:GetAttribute("Revision")
local environment = info:GetAttribute("Environment")
assert(type(revision) == "string", "Build revision is missing")
assert(type(environment) == "string", "Environment is missing")

print("Build", revision, "Environment", environment)
print("Universe", game.GameId, "Place", game.PlaceId)
print("Studio", RunService:IsStudio(), "Job", game.JobId)
```

### 3. Make ownership visible without inventing a framework

- Use existing task tracking; include affected instance paths and expected behavior.
- State which files, services, models, and package versions a task may change.
- Distinguish edit-time objects from runtime instances generated during play.
- Preserve naming, pivots, collision groups, tags, and attributes used by other systems.
- Move shared contracts first when several features depend on them.
- Stage incompatible contract changes with an explicit migration or coordinated merge.
- NEVER hide unfinished work by silently disabling unrelated systems.

This edit-time validation checks a simple ownership convention on map models.
Run it in Studio's Command Bar or an authorized edit-time execution tool.
An ownership attribute is coordination metadata, not an access-control boundary.

```luau
--!strict
local Workspace = game:GetService("Workspace")

local map = Workspace:FindFirstChild("Map")
assert(map and map:IsA("Folder"), "Expected Workspace.Map")

local missing: {string} = {}
for _, object in map:GetChildren() do
    if not object:IsA("Model") then
        continue
    end
    local owner = object:GetAttribute("DevelopmentOwner")
    if type(owner) ~= "string" or owner == "" then
        table.insert(missing, object:GetFullName())
    end
end

assert(#missing == 0, "Missing owners: " .. table.concat(missing, ", "))
print("Map ownership validated")
```

### 4. Integrate contracts and test the shared result

1. Inspect the complete diff, including generated project mappings and asset changes.
2. Check every caller of changed ModuleScript exports and remote payloads.
3. Run a clean source build before synchronizing into the integration place.
4. ALWAYS test with a server and at least two clients for multiplayer changes.
5. Test joining, respawning, leaving, and rejoining with the combined feature set.
6. Review Output on both server and clients; capture reproducible failures.
7. Record the tested revision, place, device class, and remaining limitations.
8. Publish only within the user's authorized release scope.

The assertion below detects missing shared instances before a playtest starts.
It belongs in an integration check, not a client-authoritative security system.
Replace the contract list with the project's actual agreed paths.

```luau
--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")

local contracts = {
    {parent = ReplicatedStorage, name = "Remotes", class = "Folder"},
    {parent = ReplicatedStorage, name = "Shared", class = "Folder"},
    {parent = ServerScriptService, name = "Services", class = "Folder"},
}

for _, contract in contracts do
    local object = contract.parent:FindFirstChild(contract.name)
    assert(object, "Missing " .. contract.parent.Name .. "." .. contract.name)
    assert(object:IsA(contract.class), "Wrong class for " .. object:GetFullName())
end

print("Integration contracts present")
```

### 5. Resolve conflicts and hand off

- Reproduce a conflict against the shared revision before editing either side.
- Preserve both developers' intended behavior when reconciling code.
- Ask the owners to resolve incompatible product decisions; do not guess intent.
- Keep a recoverable snapshot until the reconciled place passes its checks.
- Hand off changed paths, setup requirements, test evidence, and rollback steps.
- A completed code review MUST identify the exact revision it covers.
- NEVER claim a published place matches Git without checking the build identity.

## Common mistakes

- Editing the same terrain region concurrently; assign regions and merge snapshots deliberately.
- Treating a Team Create session as a private branch; use an isolated place for conflicting experiments.
- Reviewing scripts but missing renamed instances; validate runtime paths and asset references.
- Reverting unfamiliar work during cleanup; inspect ownership and preserve unrelated edits.
- Sharing production data with tests; use a separate test universe and explicit environment identifiers.

## Reference

- [Roblox collaboration](https://create.roblox.com/docs/projects/collaboration).
- [Script types and locations](https://create.roblox.com/docs/scripting/locations).
- [Roblox packages](https://create.roblox.com/docs/projects/assets/packages).
