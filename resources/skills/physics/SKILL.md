---
name: physics
description: >
  Implements Roblox assemblies, constraints, forces, raycasts, collision rules, and network ownership. Use when asked to "fix a vehicle", "make a moving platform", "replace a BodyMover", "debug unstable constraints", "raycast a projectile", or "configure collision groups".
---

# Roblox Physics

## When to use

- Building vehicles, elevators, ragdolls, projectiles, and physical mechanisms.
- Replacing deprecated BodyMover patterns with modern constraints.
- Debugging jitter, assembly ownership, collisions, or force scaling.
- Defining authoritative collision and hit-detection behavior.

## When NOT to use

- Authoring static scenery; that belongs to building.
- Implementing camera smoothing; that belongs to camera.
- Auditing economic exploit surfaces; that belongs to security.

## Core instructions

### 1. Inspect the assembly before changing forces

1. Identify assembly roots, anchored members, welds, constraints, and attachments.
2. ALWAYS separate visual pivots from physics attachment frames.
3. Check mass, collision geometry, and network ownership before tuning constants.
4. NEVER add BodyVelocity, BodyPosition, or BodyGyro to new systems.
5. Use LinearVelocity, VectorForce, AlignPosition, AlignOrientation, or suitable mechanical constraints.
6. Use ApplyImpulse for an instantaneous impulse rather than a one-frame force approximation.
7. Keep authority requirements explicit for vehicles, NPCs, and gameplay-critical objects.
8. Test under realistic latency and varying frame rates.

### 2. Configure collisions through current APIs

- Register groups on Workspace or the relevant WorldRoot with RegisterCollisionGroup.
- Assign groups through BasePart.CollisionGroup.
- NEVER add deprecated PhysicsService, CreateCollisionGroup, or SetPartCollisionGroup calls.
- Apply group rules to descendants added after initial creation.
- Keep collision filtering separate from CanTouch and CanQuery requirements.
- Do not disable collisions globally to hide an unstable joint setup.

This server setup gives a tagged vehicle's parts a dedicated collision group.
Create `Workspace.TestVehicle` before running it.
The same group must be assigned to later-added vehicle parts by their owner.

```luau
--!strict
local Workspace = game:GetService("Workspace")
local group = "VehicleBody"

if not Workspace:IsCollisionGroupRegistered(group) then
    Workspace:RegisterCollisionGroup(group)
end
Workspace:CollisionGroupSetCollidable(group, group, false)

local vehicle = Workspace:WaitForChild("TestVehicle")
assert(vehicle:IsA("Model"))
for _, object in vehicle:GetDescendants() do
    if object:IsA("BasePart") then
        object.CollisionGroup = group
    end
end

print("Vehicle collision group configured")
```

### 3. Use mass-aware forces and deliberate ownership

- Force and impulse calculations MUST use assembly mass where acceleration is the intent.
- Choose attachment-relative or world-relative frames explicitly.
- ApplyAtCenterOfMass avoids an unintended torque for a pure translation force.
- NEVER anchor one assembly member and expect the remaining welded body to simulate freely.
- Call CanSetNetworkOwnership before assigning ownership to an eligible part.
- Server ownership improves authority but can increase perceived latency and server cost.
- Client-owned vehicles still require server validation of important outcomes.

This server helper adds a short upward impulse to an unanchored assembly.
It does not accept client-provided strength or an arbitrary remote-selected part.

```luau
--!strict
local Workspace = game:GetService("Workspace")
local part = Workspace:WaitForChild("LaunchCrate")
assert(part:IsA("BasePart") and not part.Anchored)

local canSet, reason = part:CanSetNetworkOwnership()
assert(canSet, reason)
part:SetNetworkOwner(nil)

local deltaVelocity = Vector3.new(0, 20, 0)
part:ApplyImpulse(deltaVelocity * part.AssemblyMass)

local attachment = Instance.new("Attachment")
attachment.Name = "LiftAttachment"
attachment.Parent = part

local force = Instance.new("VectorForce")
force.Attachment0 = attachment
force.RelativeTo = Enum.ActuatorRelativeTo.World
force.ApplyAtCenterOfMass = true
force.Force = Vector3.new(0, part.AssemblyMass * Workspace.Gravity, 0)
force.Enabled = false
force.Parent = part
```

### 4. Detect fast collisions with swept tests

- Touched events alone are insufficient for fast projectiles and authoritative damage.
- Raycast from the previous position to the proposed next position for thin projectiles.
- Use spherecasts or blockcasts for projectiles whose volume matters.
- Configure filters, collision groups, and water behavior deliberately.
- NEVER normalize a zero-length displacement.
- Resolve damage on the server with team, alive, range, and cooldown checks.
- Account for moving targets and latency according to the game's combat model.

This sweep returns a hit along one simulation step.
The caller owns projectile lifetime, integration, and validated damage application.

```luau
--!strict
local Workspace = game:GetService("Workspace")

local function sweep(
    previous: Vector3,
    nextPosition: Vector3,
    excluded: {Instance}
): RaycastResult?
    local displacement = nextPosition - previous
    if displacement.Magnitude < 0.0001 then
        return nil
    end
    local params = RaycastParams.new()
    params.FilterType = Enum.RaycastFilterType.Exclude
    params.FilterDescendantsInstances = excluded
    params.IgnoreWater = true
    return Workspace:Raycast(previous, displacement, params)
end

assert(sweep(Vector3.zero, Vector3.zero, {}) == nil)
```

### 5. Tune constraints and verify stability

- Begin with correct attachment orientation and realistic mass ratios.
- Bound torque, force, speed, and responsiveness instead of setting everything to infinity.
- Avoid two active constraints fighting over the same degree of freedom.
- Apply physics inputs during PreSimulation when frame scheduling matters.
- Keep dt-based controllers stable and clamp large recovery steps after stalls.
- Test slopes, wall contact, passenger changes, ownership transfer, and sleeping assemblies.
- Visualize constraints and contact geometry before adjusting constants blindly.
- Measure physics cost at the intended number of active mechanisms.
- Destroy owned attachments and constraints when temporary mechanics end.

## Common mistakes

- Scaling a force without mass; compute the acceleration requirement using AssemblyMass.
- Mixing anchored and simulated welded parts; inspect the complete assembly first.
- Trusting a client-owned projectile's Touched event; validate swept server-side hits.
- Applying force away from the center unintentionally; use ApplyAtCenterOfMass or model the torque.
- Hiding jitter with extreme responsiveness; correct attachment frames and competing constraints.

## Reference

- [Mover constraints](https://create.roblox.com/docs/physics/mover-constraints).
- [Network ownership](https://create.roblox.com/docs/physics/network-ownership).
- [Raycasting](https://create.roblox.com/docs/workspace/raycasting).
