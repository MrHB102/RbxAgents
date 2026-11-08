---
name: studio-mcp
description: >
  Connects AI agents to Roblox Studio MCP for inspected, scoped edits and evidence-based playtesting. Use when asked to "connect an agent to Studio", "inspect my open place", "automate a Studio edit", "debug through MCP", "run a Studio playtest", or "repair an MCP connection".
---

# Roblox Studio MCP

## When to use

- Connecting an MCP-capable AI client to an intended Studio window.
- Inspecting the DataModel, reading scripts, and making scoped edits.
- Automating repeatable authoring work with an inspectable result.
- Running and diagnosing server/client playtests through available tools.

## When NOT to use

- Designing a remote protocol inside the game; that belongs to networking.
- Publishing or modifying Open Cloud resources independently; that belongs to cloud.
- Replacing source-control ownership rules; that belongs to collaboration-mode.

## Core instructions

### 1. Discover the actual connection

1. ALWAYS inspect the installed MCP tool inventory and current schemas before calling tools.
2. NEVER invent a tool name, parameter, data-model selector, or supported execution context.
3. The current built-in server is enabled through Assistant's Manage MCP Servers settings.
4. Prefer Studio's supported quick-connect setup when the installed client supports it.
5. If manual configuration is necessary, use the setup instructions for that exact Studio build.
6. Do not install an unofficial bridge merely because older instructions mention one.
7. Preserve unrelated MCP configuration and existing client connections.
8. A connection authorizes only the user's requested task, not unrestricted changes to every open place.

### 2. Select the place and execution context

- List connected Studio instances when the integration supports it.
- Confirm place name, PlaceId, universe, and whether Studio is editing or playing.
- Target the discovered Studio identifier explicitly where required by the schema.
- Distinguish Edit, Server, and Client DataModels before executing code.
- NEVER assume a runtime mutation persists after stopping play.
- NEVER stop a user's active playtest unless the requested work requires that transition.
- Use read-only exploration before editing or executing state-changing snippets.

This diagnostic is safe to run through a supported Luau execution tool.
It reports context rather than reading script source or changing the place.

```luau
--!strict
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")
local Players = game:GetService("Players")

local parts = 0
for _, object in Workspace:GetDescendants() do
    if object:IsA("BasePart") then parts += 1 end
end

return {
    placeId = game.PlaceId,
    universeId = game.GameId,
    studio = RunService:IsStudio(),
    running = RunService:IsRunning(),
    server = RunService:IsServer(),
    players = #Players:GetPlayers(),
    parts = parts,
}
```

### 3. Inspect, edit, and verify narrowly

- Read the target and its callers before replacing a script or export.
- Prefer supported source-edit tools over direct Source assignment.
- Include expected old text or a revision check to reject stale edits.
- ALWAYS preserve unrelated properties, attributes, children, and developer changes.
- Use a named output container for procedural work.
- NEVER clear Workspace or delete broad class matches to simplify a small edit.
- For destructive authoring, make a recoverable snapshot and identify exact affected paths.
- Batch independent property changes only when partial failure can be understood and recovered.

This edit-only snippet creates or updates a scoped marker model.
It refuses to run in play mode and does not erase existing children.
Validate that the selected Studio window is the intended place before execution.

```luau
--!strict
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")
assert(RunService:IsStudio() and not RunService:IsRunning(), "Edit mode required")

local existing = Workspace:FindFirstChild("AgentPreview")
assert(existing == nil or existing:IsA("Model"), "Output name conflict")
local model: Model
if existing and existing:IsA("Model") then
    model = existing
else
    model = Instance.new("Model")
    model.Name = "AgentPreview"
    model.Parent = Workspace
end

model:SetAttribute("Purpose", "Scoped authoring preview")
model:SetAttribute("LastInspectedPlaceId", game.PlaceId)
return {path = model:GetFullName(), children = #model:GetChildren()}
```

### 4. Respect script-editor security boundaries

- Normal gameplay scripts cannot edit arbitrary script source.
- ScriptEditorService:UpdateSourceAsync requires an authorized plugin-capable context.
- NEVER enable LoadStringEnabled or add a runtime backdoor to work around missing tool capability.
- If a bridge does not support source editing, use an available source tool or an explicit file workflow.
- Compare source through the editor-aware API so unsaved open-document edits are not ignored.
- Re-read the saved result and inspect Studio diagnostics after the edit.

This example is for an authorized edit-time plugin execution context only.
Create `ServerScriptService.AgentExampleConfig` as a ModuleScript beforehand.
Use the MCP tool's own source-edit operation instead when it already handles editor synchronization.

```luau
--!strict
local ScriptEditorService = game:GetService("ScriptEditorService")
local ServerScriptService = game:GetService("ServerScriptService")
local RunService = game:GetService("RunService")
assert(RunService:IsStudio() and not RunService:IsRunning())

local target = ServerScriptService:FindFirstChild("AgentExampleConfig")
assert(target and target:IsA("ModuleScript"), "Expected an existing config module")
local expected = ScriptEditorService:GetEditorSource(target)
local replacement = "--!strict\nreturn {Enabled = true}\n"

ScriptEditorService:UpdateSourceAsync(target, function(current: string): string
    assert(current == expected, "Source changed; inspect the latest edit before retrying")
    return replacement
end)

assert(ScriptEditorService:GetEditorSource(target) == replacement)
return {updated = target:GetFullName()}
```

### 5. Prove behavior in the correct runtime

- Start a playtest through the discovered tool only when needed for the requested change.
- Verify server Output and each relevant client Output independently.
- Use simulated input through supported tooling rather than assuming a GUI screenshot proves interaction.
- Test a concrete action, expected state change, and visible result.
- For multiplayer changes, verify an actual server/client boundary with more than one player.
- Capture screenshots after the state settles and include context for interpreting them.
- Stop only playtests started for this task unless the user authorized a broader reset.
- Report the changed paths, tested context, evidence, and unverified behavior.
- Never claim a source edit was published merely because Studio shows the new code.

## Common mistakes

- Using remembered MCP schemas; inspect the active tool inventory and required parameters.
- Editing the wrong Studio window; confirm the instance identifier and place identity first.
- Editing Server DataModel during play and expecting persistence; use Edit for authoring.
- Bypassing editor state with Source writes; use supported source tools or editor-aware APIs.
- Treating a screenshot as a successful test; verify the action and resulting state.

## Reference

- [Studio MCP connection and tools](https://create.roblox.com/docs/studio/mcp).
- [ScriptEditorService](https://create.roblox.com/docs/reference/engine/classes/ScriptEditorService).
- [Studio testing modes](https://create.roblox.com/docs/studio/testing-modes).
