---
name: networking
description: >
  Designs validated Roblox remote contracts, state replication, request limits, and resynchronization. Use when asked to "create a RemoteEvent", "fix remote spam", "replicate inventory state", "debug a RemoteFunction hang", "reduce network traffic", or "sync players after joining".
---

# Roblox Networking

## When to use

- Adding communication between LocalScripts and server Scripts.
- Defining remote payloads, acknowledgements, and state snapshots.
- Debugging duplicate requests, stale UI state, or remote overload.
- Reducing bandwidth for frequent cosmetic or positional updates.

## When NOT to use

- Building a persistent cross-server store; that belongs to server-data.
- Auditing the full exploit surface; that belongs to security.
- Wiring local module events; that belongs to luau-patterns.

## Core instructions

### 1. Specify the protocol

1. Define direction, sender, payload schema, allowed rate, and observable response.
2. ALWAYS use the Player supplied by `OnServerEvent` as sender identity.
3. NEVER accept client-provided prices, damage, ownership, or reward amounts as truth.
4. Keep remotes in a known ReplicatedStorage folder, created by server or edit-time setup.
5. Use RemoteEvent for asynchronous intent and replies.
6. Use RemoteFunction only for bounded operations whose yielding behavior is acceptable.
7. NEVER make critical server progress depend on `InvokeClient` returning.
8. A client timeout does not cancel server work; late replies need request IDs.

### 2. Bound requests before doing expensive work

- Check type, size, numeric finiteness, enum membership, and Instance ancestry.
- Check authorization, alive state, distance, cooldown, and server-owned inventory.
- Rate-limit rejected requests as well as accepted requests where abuse could be expensive.
- NEVER forward arbitrary client payloads through `FireAllClients`.
- Use per-player limits and an aggregate budget for costly global actions.
- Clean limiter state on PlayerRemoving.

This ServerScriptService example accepts only two harmless cosmetic intents.
Create `ReplicatedStorage.Remotes.EmoteRequest` as a RemoteEvent beforehand.
The server sends a vetted ID rather than relaying an asset ID supplied by a client.

```luau
--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local remote = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("EmoteRequest")
assert(remote:IsA("RemoteEvent"))

local allowed: {[string]: boolean} = {Wave = true, Cheer = true}
local nextAt: {[Player]: number} = {}

remote.OnServerEvent:Connect(function(player: Player, emote: unknown)
    local now = os.clock()
    if now < (nextAt[player] or 0) then
        return
    end
    nextAt[player] = now + 1
    if type(emote) ~= "string" or not allowed[emote] then
        return
    end
    local character = player.Character
    local humanoid = character and character:FindFirstChildOfClass("Humanoid")
    if not humanoid or humanoid.Health <= 0 then
        return
    end
    remote:FireAllClients(player.UserId, emote)
end)

Players.PlayerRemoving:Connect(function(player)
    nextAt[player] = nil
end)
```

### 3. Separate reliable state from disposable effects

- Use reliable remotes for inventory, currency, objectives, and confirmations.
- Use UnreliableRemoteEvent only for data whose loss and reordering are acceptable.
- NEVER put a purchase result or durable progression update on an unreliable channel.
- Coalesce frequent changes and send deltas only when they materially reduce traffic.
- Restrict effect recipients by interest or distance when the player count grows.
- Read current payload limits from the API reference instead of hardcoding remembered quotas.
- Replicated instances may arrive separately from remote messages; do not assume ordering.

This pure token bucket supports small bursts while limiting sustained traffic.
Keep one bucket per player and remote category on the server.

```luau
--!strict
local function newBucket(capacity: number, refill: number, clock: () -> number)
    assert(capacity > 0 and refill > 0)
    local tokens = capacity
    local last = clock()
    return function(): boolean
        local now = clock()
        tokens = math.min(capacity, tokens + math.max(0, now - last) * refill)
        last = now
        if tokens < 1 then
            return false
        end
        tokens -= 1
        return true
    end
end

local time = 0
local accept = newBucket(2, 1, function() return time end)
assert(accept() and accept())
assert(not accept())
time = 1
assert(accept())
```

### 4. Make initial state and recovery explicit

- Connect client listeners before requesting an initial snapshot.
- Include a monotonic server revision in snapshots and state updates.
- Ignore duplicate revisions and request a fresh snapshot after a gap.
- Bound snapshot request frequency and response size.
- NEVER assume a local controller surviving respawn still has current server state.
- Rebuild views after a restart without granting gameplay rewards a second time.

This client reducer accepts complete snapshots and sequential deltas.
On `false`, its caller must request a rate-limited authoritative snapshot.
The table shape is trusted here only after the caller has checked the payload contract.

```luau
--!strict
type View = {revision: number, coins: number}
local view: View = {revision = 0, coins = 0}

local function applySnapshot(nextView: View)
    if nextView.revision >= view.revision then
        view = table.clone(nextView)
    end
end

local function applyDelta(revision: number, coins: number): boolean
    if revision <= view.revision then
        return true
    end
    if revision ~= view.revision + 1 then
        return false
    end
    view = {revision = revision, coins = coins}
    return true
end

applySnapshot({revision = 5, coins = 20})
assert(not applyDelta(7, 30))
assert(applyDelta(6, 25) and view.coins == 25)
```

### 5. Verify under imperfect conditions

- Test with two clients, simulated latency, rapid input, and client reconnection.
- Send wrong types, oversized strings, NaN, infinity, and unrelated Instances.
- Test listener startup after state already changed.
- Measure bytes and handler cost before introducing compression or prediction.
- Log aggregate rejection reasons; NEVER log every abusive request synchronously.

## Common mistakes

- Debouncing only in a LocalScript; enforce the limit again on the server.
- Sending an entire save record on every change; define a minimal view protocol.
- Blocking the server on `InvokeClient`; use an asynchronous request with a deadline.
- Assuming unreliable events preserve order; design each sample to tolerate loss.
- Missing the initial update before connecting; subscribe first and request a snapshot.

## Reference

- [Remote events and callbacks](https://create.roblox.com/docs/scripting/events/remote).
- [UnreliableRemoteEvent](https://create.roblox.com/docs/reference/engine/classes/UnreliableRemoteEvent).
- [Client-server boundary](https://create.roblox.com/docs/scripting/security/client-server-boundary).
