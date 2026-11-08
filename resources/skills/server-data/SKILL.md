---
name: server-data
description: >
  Coordinates Roblox player-session lifecycles, cross-server temporary state, offline work, and concurrent access. Use when asked to "fix a session lock", "handle reconnect races", "build matchmaking storage", "update offline data", "sync servers", or "clean up player state on shutdown".
---

# Roblox Server Data and Sessions

## When to use

- Controlling a player's load, active, closing, and released session states.
- Preventing reconnect races and writes from stale servers.
- Using MemoryStoreService or MessagingService for temporary cross-server work.
- Applying offline operations without overwriting an active session.

## When NOT to use

- Defining the full durable schema; that belongs to data.
- Granting developer products; that belongs to monetization.
- Calling external Open Cloud endpoints; that belongs to cloud.

## Core instructions

### 1. Define lifecycle and ownership

1. Keep active records private in ServerScriptService with one owner per player.
2. Model Loading, Active, Closing, Released, and Failed states explicitly.
3. ALWAYS block economic mutations until the profile is loaded and session ownership is confirmed.
4. NEVER infer ownership merely because a player is connected to this server.
5. Use the project's established session library when available; do not add a second lock mechanism.
6. Atomically acquire durable profile locks through UpdateAsync when implementing custom ownership.
7. Validate the lock token on every durable save; losing ownership MUST stop local gameplay mutations.
8. Handle a player leaving while load is still in flight, including releasing late acquisitions.

### 2. Guard the local lifecycle

- Connect PlayerAdded before enumerating existing players.
- Make load and close handlers idempotent because callbacks and shutdown overlap.
- Never allow a late async completion to reactivate a departed player's session.
- Release a successfully acquired session even if its player left during acquisition.
- Clean event connections, registry entries, queues, and pending callbacks together.
- NEVER use Player.Name as the durable identity; use Player.UserId.

This server skeleton guards late completions without implementing persistence itself.
The injected loader MUST return a release function only after acquiring a real session.
Its release function MUST be idempotent and perform the project's final-save policy.

```luau
--!strict
type Session = {release: () -> ()}
type Slot = {closing: boolean, session: Session?}
local slots: {[Player]: Slot} = {}

local function begin(player: Player, load: (number) -> Session?)
    if slots[player] then return end
    local slot: Slot = {closing = false, session = nil}
    slots[player] = slot
    task.spawn(function()
        local ok, session = pcall(load, player.UserId)
        if not ok or session == nil then
            if slots[player] == slot then slots[player] = nil end
            if player.Parent then player:Kick("Data is unavailable. Please rejoin.") end
            return
        end
        if slot.closing or slots[player] ~= slot or not player.Parent then
            session.release()
            return
        end
        slot.session = session
    end)
end

local function close(player: Player)
    local slot = slots[player]
    if not slot then return end
    slot.closing = true
    slots[player] = nil
    if slot.session then slot.session.release() end
end

return {begin = begin, close = close}
```

### 3. Separate durable records from temporary coordination

- DataStoreService holds progress and economic truth.
- MemoryStoreService holds expiring matchmaking, presence, and coordination data.
- MessagingService carries notifications; messages are not a durable event log.
- ALWAYS give temporary entries an explicit expiration and tolerate missing entries.
- NEVER use a MemoryStore-only lease as the sole defense for overwriting durable player data.
- Queue delivery can repeat; consumers need operation IDs and idempotent completion.
- OrderedDataStore leaderboards are derived views, not the canonical player wallet.

This MemoryStore lease coordinates temporary work, not economic ownership.
The unique token prevents an old worker from renewing another worker's lease.
Downstream effects still need their own idempotency and fencing rules.

```luau
--!strict
local MemoryStoreService = game:GetService("MemoryStoreService")
local HttpService = game:GetService("HttpService")
local leases = MemoryStoreService:GetHashMap("TemporaryWorkers_v1")

local function claim(key: string): string?
    local token = HttpService:GenerateGUID(false)
    local ok, value = pcall(function()
        return leases:UpdateAsync(key, function(old)
            if old ~= nil then return nil end
            return {token = token}
        end, 30)
    end)
    if ok and type(value) == "table" and value.token == token then
        return token
    end
    return nil
end

local function renew(key: string, token: string): boolean
    local ok, value = pcall(function()
        return leases:UpdateAsync(key, function(old)
            if type(old) ~= "table" or old.token ~= token then return nil end
            return old
        end, 30)
    end)
    return ok and type(value) == "table" and value.token == token
end

return {claim = claim, renew = renew}
```

### 4. Handle offline work and cross-server notifications

- Enqueue durable operations with stable IDs instead of overwriting a live cached profile.
- The active owner applies queued operations through the same serialized mutation path.
- If an offline updater must acquire ownership, it MUST respect the same durable lock contract.
- A notification tells the owner to refresh or inspect a queue; the queue remains authoritative.
- Include a schema version and a small allowlisted action type in cross-server messages.
- Bound message size and frequency and wrap service calls in pcall.
- NEVER include secrets, raw chat, or unnecessary personal data in messages.

This subscriber validates a small cache-invalidation message.
The revision map is only a hint; durable refreshes need rate limits and error handling.
Call the returned cleanup function when its owning service stops.

```luau
--!strict
local MessagingService = game:GetService("MessagingService")
local revisions: {[string]: number} = {}
local allowed: {[string]: boolean} = {Weather = true, ShopRotation = true}

local ok, subscription = pcall(function()
    return MessagingService:SubscribeAsync("ConfigChanged_v1", function(message)
        local data = message.Data
        if type(data) ~= "table" or data.version ~= 1 then return end
        if type(data.key) ~= "string" or not allowed[data.key] then return end
        local revision = data.revision
        if type(revision) ~= "number" or revision % 1 ~= 0 then return end
        if revision < 0 or revision > 1_000_000_000 then return end
        revisions[data.key] = math.max(revisions[data.key] or 0, revision)
    end)
end)

if not ok then
    warn("Configuration notifications unavailable")
end

return function()
    if ok then subscription:Disconnect() end
    table.clear(revisions)
end
```

### 5. Prove failure behavior

- Race two session acquisitions for one user and verify only one can mutate.
- Disconnect during load, save, lock renewal, and finalization.
- Simulate a write whose response is lost after the backend committed it.
- Stop mutations before a local lease deadline; account for clock skew in custom designs.
- Test stale workers resuming after another owner takes over.
- Test duplicate and missing cross-server notifications against a durable source of truth.
- During BindToClose, stop accepting work first and bound concurrent finalization.
- Expose load failures, lost ownership, queue age, and final-save failures as operational metrics.

## Common mistakes

- Saving from both an offline tool and an active cached session; use one ownership protocol.
- Keeping temporary matchmaking data forever; set expiration and reconcile stale entries.
- Deleting a lease by key without checking its owner; let it expire or use a safe ownership protocol.
- Treating MessagingService as guaranteed delivery; refresh from authoritative storage.
- Ignoring a player who leaves during load; release any late-acquired session immediately.

## Reference

- [Memory stores](https://create.roblox.com/docs/cloud-services/memory-stores).
- [MessagingService](https://create.roblox.com/docs/reference/engine/classes/MessagingService).
- [Player data session locking](https://create.roblox.com/docs/cloud-services/data-stores/player-data-purchasing).
