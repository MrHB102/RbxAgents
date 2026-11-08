---
name: npc-ai
description: >
  Implements bounded Roblox NPC perception, decisions, navigation, and combat behavior with cancellation. Use when asked to "create an enemy NPC", "fix stuck pathfinding", "build a behavior tree", "make an NPC chase players", "optimize many NPCs", or "stop attacks through walls".
---

# Roblox NPC AI

## When to use

- Building patrol, chase, attack, flee, or recovery behaviors.
- Debugging unreachable paths, stale targets, and blocked movement.
- Scheduling perception and navigation for many NPCs.
- Choosing between a small state machine and a behavior tree.

## When NOT to use

- Authoring a rig or attack animation; that belongs to animation-vfx.
- Building physical vehicle controllers; that belongs to physics.
- Defining combat progression and encounter difficulty; that belongs to game-design.

## Core instructions

### 1. Separate sensing, decisions, and actions

1. Define the NPC's goal, target rules, movement capabilities, and attack contract.
2. ALWAYS keep valuable combat outcomes authoritative on the server.
3. Use a small state machine for mutually exclusive modes.
4. Use a behavior tree only when reusable hierarchical decisions justify its complexity.
5. NEVER recompute a path for every NPC on every frame.
6. Give each NPC one owner responsible for tasks, paths, connections, and destruction.
7. Track cancellation generations so old navigation cannot overwrite a new decision.
8. Revalidate targets after yields, death, respawn, and streaming changes.

### 2. Bound perception and validate visibility

- Use broad-phase distance checks before expensive raycasts.
- Query candidates from an existing player or combatant registry.
- Ignore the NPC's own model during line-of-sight checks.
- Differentiate visual perception from hearing or last-known-position behavior.
- NEVER attack solely because the client reports that an NPC is in range.
- Use hysteresis between acquire and lose distances to avoid state flicker.

This server helper checks range and static line of sight to a target model.
The caller must separately verify faction, health, and target eligibility.

```luau
--!strict
local Workspace = game:GetService("Workspace")

local function canSee(npc: Model, origin: Vector3, target: Model, range: number): boolean
    local root = target:FindFirstChild("HumanoidRootPart")
    if not root or not root:IsA("BasePart") then
        return false
    end
    local offset = root.Position - origin
    if offset.Magnitude > range then
        return false
    end
    if offset.Magnitude < 0.001 then
        return true
    end
    local params = RaycastParams.new()
    params.FilterType = Enum.RaycastFilterType.Exclude
    params.FilterDescendantsInstances = {npc}
    local hit = Workspace:Raycast(origin, offset, params)
    return hit == nil or hit.Instance:IsDescendantOf(target)
end

return canSee
```

### 3. Compute navigation deliberately

- Configure AgentRadius, AgentHeight, jumping, and costs to match the actual rig.
- Call Path:ComputeAsync inside pcall and check Path.Status.
- Treat NoPath as an ordinary recovery condition, not an exception to retry every frame.
- React to Path.Blocked only when the blockage is ahead of the current waypoint.
- Include a movement deadline and progress checks; never wait forever for arrival.
- Disconnect path listeners and destroy Path instances when the operation ends.
- A production controller MUST handle jump actions and explicit traversal links if the map uses them.

This bounded walking primitive supports waypoint jumps and cancellation.
It returns false for a blockage or timeout so its owner can schedule a bounded replan.
It is not a complete chase loop; call it through one NPC action owner.

```luau
--!strict
local PathfindingService = game:GetService("PathfindingService")
local RunService = game:GetService("RunService")

local function walk(npc: Model, destination: Vector3, cancelled: () -> boolean): boolean
    local humanoid = npc:FindFirstChildOfClass("Humanoid")
    local root = npc:FindFirstChild("HumanoidRootPart")
    if not humanoid or not root or not root:IsA("BasePart") then return false end
    local path = PathfindingService:CreatePath({
        AgentRadius = 2, AgentHeight = 5, AgentCanJump = true,
    })
    local ok = pcall(function() path:ComputeAsync(root.Position, destination) end)
    if not ok or path.Status ~= Enum.PathStatus.Success or cancelled() then
        path:Destroy()
        return false
    end
    local index = 1
    local blocked = false
    local connection = path.Blocked:Connect(function(blockedIndex)
        if blockedIndex >= index then blocked = true end
    end)
    local reached = true
    for waypointIndex, waypoint in path:GetWaypoints() do
        index = waypointIndex
        if cancelled() or blocked or not npc.Parent or humanoid.Health <= 0 then
            reached = false
            break
        end
        if waypoint.Action == Enum.PathWaypointAction.Jump then
            humanoid.Jump = true
        end
        local arrived: boolean? = nil
        local moveConnection = humanoid.MoveToFinished:Connect(function(success)
            arrived = success
        end)
        humanoid:MoveTo(waypoint.Position)
        local deadline = os.clock() + 6
        while arrived == nil do
            if cancelled() or blocked or not npc.Parent or not root:IsDescendantOf(npc) or humanoid.Health <= 0 then
                reached = false
                break
            end
            if os.clock() >= deadline then reached = false; break end
            RunService.Heartbeat:Wait()
        end
        moveConnection:Disconnect()
        if arrived ~= true then reached = false end
        if not reached then break end
    end
    connection:Disconnect()
    path:Destroy()
    if not cancelled() and root.Parent and humanoid.Parent then humanoid:MoveTo(root.Position) end
    return reached
end

return walk
```

### 4. Make decision rules testable

- Keep target selection and state choice pure where practical.
- Run perception at a measured interval and stagger NPCs across frames.
- Replan when the goal moves meaningfully, the path blocks, or progress stalls.
- NEVER let movement owners overlap; cancel the previous action and await its cleanup before replacing it.
- Rate-limit attacks on the server and check reach and visibility at the hit moment.
- Separate animation wind-up from authoritative damage timing.

This pure decision function exposes the priority order of death, attack, and chase.
Its distance input must come from server-observed state.

```luau
--!strict
type State = "Dead" | "Idle" | "Chase" | "Attack"

local function choose(alive: boolean, hasTarget: boolean, distance: number): State
    if not alive then return "Dead" end
    if not hasTarget then return "Idle" end
    if distance <= 5 then return "Attack" end
    return "Chase"
end

assert(choose(false, true, 1) == "Dead")
assert(choose(true, false, 1) == "Idle")
assert(choose(true, true, 4) == "Attack")
assert(choose(true, true, 20) == "Chase")
```

### 5. Verify navigation and lifecycle

- Test narrow doors, steep slopes, moving blockers, unreachable goals, and falling starts.
- Remove the target during ComputeAsync and during movement.
- Destroy the NPC while a path is active and verify no retained connections remain.
- Test many NPCs with realistic server population and navigation costs.
- Use navigation visualization to inspect agent clearance and modifier labels.

## Common mistakes

- Pathfinding every frame; replan on meaningful changes with a per-NPC cooldown.
- Keeping blocked-path connections forever; disconnect on completion and cancellation.
- Attacking a cached character after respawn; revalidate the target model and health.
- Letting multiple coroutines call MoveTo; give movement one cancellable owner.
- Treating NoPath as fatal; enter a bounded wait, fallback, or retreat behavior.

## Reference

- [Pathfinding](https://create.roblox.com/docs/characters/pathfinding).
- [Path API](https://create.roblox.com/docs/reference/engine/classes/Path).
- [Humanoid movement](https://create.roblox.com/docs/reference/engine/classes/Humanoid).
