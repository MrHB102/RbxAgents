---
name: security
description: >
  Hardens Roblox trust boundaries, server authority, reward integrity, and exploit detection. Use when asked to "stop an exploit", "secure my remotes", "prevent item duplication", "validate a combat hit", "audit a free model", or "detect suspicious movement".
---

# Roblox Security

## When to use

- Reviewing player-triggered actions that mutate valuable state.
- Preventing forged hits, unauthorized admin actions, or item duplication.
- Evaluating third-party assets and unexpected scripts.
- Adding evidence-based detection without punishing normal latency.

## When NOT to use

- Choosing remote replication formats alone; that belongs to networking.
- Implementing schema migrations; that belongs to data.
- Publishing a release after the audit; that belongs to publish-checklist.

## Core instructions

### 1. Map the real trust boundaries

1. Treat every client value, including replicated movement, as potentially manipulated.
2. ALWAYS let the server decide rewards, prices, damage, cooldowns, and permissions.
3. NEVER place secrets in LocalScripts, attributes, ReplicatedStorage, or client-visible modules.
4. Inspect remotes, prompts, click detectors, drag detectors, physics ownership, and HTTP inputs.
5. Record what each entry point may read, mutate, allocate, or broadcast.
6. Validate at the boundary before indexing payload tables or calling expensive APIs.
7. Fail closed for valuable actions when authorization or persistence is unavailable.
8. Preserve evidence and reversible remediation; do not invent automatic ban rules casually.

### 2. Validate shape, magnitude, and context

- Reject non-finite numbers before arithmetic, distance tests, or persistence.
- Bound string bytes, UTF-8 validity, array count, table depth, and allowed keys.
- Check Instance class and ancestry; an Instance reference alone is not authorization.
- Resolve item IDs through server catalogs instead of accepting caller-provided definitions.
- ALWAYS check player state immediately before a mutation that follows a yield.
- NEVER perform side effects inside a retryable UpdateAsync transform.

This helper validates a direction supplied to a server combat handler.
It rejects invalid components and absurd vectors before normalization.
The combat handler must separately verify origin, ammo, timing, and team rules.

```luau
--!strict
local function finite(value: number): boolean
    return value == value and math.abs(value) < math.huge
end

local function parseDirection(value: unknown): Vector3?
    if typeof(value) ~= "Vector3" then
        return nil
    end
    if not finite(value.X) or not finite(value.Y) or not finite(value.Z) then
        return nil
    end
    local length = value.Magnitude
    if length < 0.001 or length > 10_000 then
        return nil
    end
    return value / length
end

assert(parseDirection(Vector3.zero) == nil)
assert(parseDirection(Vector3.new(0 / 0, 0, 0)) == nil)
assert(parseDirection(Vector3.new(0, 0, -1)) == Vector3.new(0, 0, -1))
```

### 3. Secure world interactions as well as remotes

- A visible or enabled prompt is not proof that the action is authorized.
- Check distance to anchored or server-owned geometry for important interactions.
- Client-owned physics can move an unanchored interaction object near the attacker.
- Verify line of sight where gameplay requires it.
- Apply server rate limits even to events that appear naturally throttled by the UI.
- Keep check and mutation non-yielding when another request could invalidate the check.

This server example toggles one anchored door after validating a prompt action.
Create `Workspace.SecurityDoor` as a BasePart with a child ProximityPrompt.
It demonstrates authorization context; add a server-owned key check for locked doors.

```luau
--!strict
local Workspace = game:GetService("Workspace")
local door = Workspace:WaitForChild("SecurityDoor")
assert(door:IsA("BasePart") and door.Anchored)
local prompt = door:WaitForChild("ProximityPrompt")
assert(prompt:IsA("ProximityPrompt"))
local nextToggle = 0

prompt.Triggered:Connect(function(player: Player)
    local now = os.clock()
    if not prompt.Enabled or now < nextToggle then
        return
    end
    local character = player.Character
    local root = character and character:FindFirstChild("HumanoidRootPart")
    local humanoid = character and character:FindFirstChildOfClass("Humanoid")
    if not root or not root:IsA("BasePart") or not humanoid or humanoid.Health <= 0 then
        return
    end
    if (root.Position - door.Position).Magnitude > 12 then
        return
    end
    nextToggle = now + 0.5
    door.CanCollide = not door.CanCollide
end)
```

### 4. Preserve transaction integrity

- Use one serialized mutation owner for each active player's valuable state.
- Validate both sides of a trade before committing either transfer.
- NEVER claim two independent DataStore keys form an atomic transaction.
- Durable trades need operation IDs, recoverable states, and reconciliation after crashes.
- Deduplicate purchase grants with durable receipt IDs in the same atomic record as the grant.
- Do not prune replay protection until a documented retention and recovery policy permits it.
- Reject malformed data instead of saving a default over a corrupted or unknown profile.
- Stop economic mutations when session ownership is lost.

### 5. Detect anomalies without pretending detection is authority

- Validate outcomes even when a detector fails to identify a cheat.
- Account for teleports, respawns, moving platforms, network ownership, and lag.
- Prefer rejecting an invalid action to permanent punishment from one heuristic.
- Keep moderation permissions on the server and identify admins by immutable UserId.
- NEVER trust a client-side anti-cheat report as sufficient evidence for a ban.

This pure movement classifier returns evidence for review, not an automatic ban.
Its caller must reset the baseline after authorized teleports and character changes.

```luau
--!strict
local function suspiciousDisplacement(
    distance: number,
    elapsed: number,
    maxSpeed: number,
    tolerance: number
): boolean
    if elapsed <= 0 or distance < 0 then
        return false
    end
    return distance > maxSpeed * elapsed + tolerance
end

assert(not suspiciousDisplacement(20, 1, 16, 8))
assert(suspiciousDisplacement(200, 1, 16, 8))
assert(not suspiciousDisplacement(20, 0, 16, 8))
```

### 6. Verify the exploit surface

- Exercise every privileged action with wrong types and an unauthorized sender.
- Test repeated receipts, simultaneous requests, player departure, and failed writes.
- Search imported assets for unexpected scripts and dynamic asset-ID requires.
- Record the exact protected invariant and a regression case for each fixed exploit.

## Common mistakes

- Hiding remote names as protection; enforce permissions and server state instead.
- Trusting client-owned part positions for purchases; use fixed server interaction geometry.
- Banning on a single speed spike; reset baselines and collect contextual evidence.
- Saving a default profile after load failure; block economic play and preserve the original record.
- Validating only top-level types; bound nested content and reject non-finite numbers.

## Reference

- [Security tactics](https://create.roblox.com/docs/scripting/security/security-tactics).
- [Access control](https://create.roblox.com/docs/scripting/security/access-control).
- [Network ownership](https://create.roblox.com/docs/physics/network-ownership).
