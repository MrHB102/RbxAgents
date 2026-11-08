---
name: performance
description: >
  Diagnoses and improves Roblox frame time, server cost, memory, replication, and loading using measured evidence. Use when asked to "fix low FPS", "profile server lag", "find a memory leak", "optimize an update loop", "reduce loading time", or "support slower phones".
---

# Roblox Performance

## When to use

- Investigating frame spikes, slow servers, memory growth, or long joins.
- Replacing repeated world scans or excessive per-frame work.
- Establishing device and player-count performance budgets.
- Verifying whether pooling, streaming, batching, or LOD improves a measured bottleneck.

## When NOT to use

- Changing mechanics merely because they seem expensive; that belongs to game-design.
- Fixing malformed remote authorization; that belongs to security.
- Selecting a mesh's artistic silhouette; that belongs to building.

## Core instructions

### 1. Measure the constrained resource

1. Record device, graphics level, player count, place revision, and reproduction path.
2. ALWAYS distinguish client rendering, client scripting, server scripting, physics, and network cost.
3. Capture Developer Console, Script Profiler, and MicroProfiler evidence as appropriate.
4. Compare frame-time distributions and spikes, not only average FPS.
5. NEVER assume a Studio desktop result represents a low-memory mobile device.
6. Establish a baseline before changing code or asset budgets.
7. Optimize the measured hot path first and remeasure the same scenario afterward.
8. Keep behavior and correctness checks alongside performance measurements.

### 2. Profile bounded work

- Add `debug.profilebegin` and `debug.profileend` around meaningful non-yielding sections.
- NEVER leave a profiling region open after an early return or exception.
- Do not add synchronous logging in a hot loop while measuring it.
- Cache stable lookups, not object lifetimes that can change through streaming or destruction.
- Hoist immutable configuration out of callbacks.
- Use native code generation or parallel Luau only after simpler work reduction is insufficient.

This helper labels a pure batch calculation and includes a correctness check.
The example belongs in a computational module, not a render callback.

```luau
--!strict
local function sumPositive(values: {number}): number
    debug.profilebegin("SumPositive")
    local total = 0
    for _, value in values do
        if value > 0 then
            total += value
        end
    end
    debug.profileend()
    return total
end

assert(sumPositive({-3, 0, 4, 5}) == 9)
assert(sumPositive({}) == 0)
```

### 3. Replace polling and world scans with maintained membership

- Use CollectionService tags or existing registries for dynamic groups.
- Subscribe to added/removed signals and also enumerate initial members.
- Disconnect global signals when the owning service shuts down.
- NEVER call Workspace:GetDescendants every Heartbeat to find the same objects.
- Keep removal operations bounded for large sets; use an index if order is irrelevant.
- Avoid holding destroyed instances through tables, closures, or unfinished tasks.

This registry uses constant-time membership updates.
Put it on the server or client according to which objects actually exist there.
Its Destroy method releases both external connections and retained instances.

```luau
--!strict
local CollectionService = game:GetService("CollectionService")
local members: {[Instance]: boolean} = {}

local function add(instance: Instance)
    if instance:IsA("BasePart") then
        members[instance] = true
    end
end

local added = CollectionService:GetInstanceAddedSignal("DamageZone"):Connect(add)
local removed = CollectionService:GetInstanceRemovedSignal("DamageZone"):Connect(function(instance)
    members[instance] = nil
end)

for _, instance in CollectionService:GetTagged("DamageZone") do
    add(instance)
end

local function destroy()
    added:Disconnect()
    removed:Disconnect()
    table.clear(members)
end

return {members = members, Destroy = destroy}
```

### 4. Schedule by purpose and budget

- Reserve PreRender or BindToRenderStep for work that must affect the current rendered frame.
- Apply physics inputs before simulation and inspect results after simulation.
- Run AI perception and distant object updates less frequently than camera updates.
- Use dt or elapsed time rather than assuming a fixed frame rate.
- Bound catch-up work; NEVER run an unbounded fixed-step loop after a long stall.
- Batch or stagger background work without delaying authoritative combat checks incorrectly.
- Keep expensive yielding work out of render callbacks.

This server loop updates a cosmetic diagnostic at 5 Hz without catch-up bursts.
It intentionally samples current state instead of simulating missed gameplay steps.
The loop's owner receives a stop function for cleanup.

```luau
--!strict
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")
local elapsed = 0
local connection = RunService.Heartbeat:Connect(function(dt)
    elapsed += dt
    if elapsed < 0.2 then
        return
    end
    elapsed %= 0.2
    local part = Workspace:FindFirstChild("DiagnosticPart")
    if part and part:IsA("BasePart") then
        part:SetAttribute("SampledHeight", part.Position.Y)
    end
end)

local function stop()
    connection:Disconnect()
end

return stop
```

### 5. Address rendering, physics, network, and memory separately

- Reduce overlapping transparency, excessive particle fill, unique textures, and costly shadows.
- Use streaming and model LOD according to visibility and interaction requirements.
- Disable CanTouch and CanQuery only where no gameplay depends on those interactions.
- Keep decorative geometry anchored and simplify collision fidelity when acceptable.
- Replicate necessary outcomes; render disposable effects locally.
- Pool only measured high-churn objects and reset all mutable state on reuse.
- A pool MUST have a capacity limit and a destruction path.
- Never trade a small allocation reduction for permanent unbounded retained memory.
- Use Actors and parallel-safe APIs only when ownership and thread-safety are explicit.

### 6. Verify realistic sessions

- Repeat the same route before and after the change on representative hardware.
- Join, respawn, open menus, trigger effects, and leave repeatedly to reveal leaks.
- Measure long-session memory trends after garbage collection has had time to settle.
- Test the intended server population rather than extrapolating a one-player result.
- Record remaining bottlenecks and the evidence supporting the improvement.

## Common mistakes

- Optimizing every loop without profiling; target the measured bottleneck.
- Yielding inside render work; move background processing to a suitable scheduler.
- Pooling unlimited effects; bound the pool and release its resources on shutdown.
- Treating all lag as network lag; separate render, physics, script, and replication evidence.
- Testing only in Studio; include a published staging place and a slower mobile device.

## Reference

- [Identify performance issues](https://create.roblox.com/docs/performance-optimization/identify).
- [MicroProfiler](https://create.roblox.com/docs/performance-optimization/microprofiler).
- [Task scheduler](https://create.roblox.com/docs/performance-optimization/microprofiler/task-scheduler).
