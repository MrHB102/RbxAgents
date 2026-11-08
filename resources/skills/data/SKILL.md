---
name: data
description: >
  Designs durable Roblox schemas, migrations, DataStore operations, and safe save recovery. Use when asked to "save player progress", "fix lost data", "migrate a profile", "use ProfileService", "handle DataStore throttling", or "restore a previous save".
---

# Roblox Persistent Data

## When to use

- Designing versioned player profiles and save formats.
- Diagnosing failed loads, overwritten progress, or oversized records.
- Implementing idempotent single-key writes and bounded retries.
- Reviewing an existing ProfileService or ProfileStore integration.

## When NOT to use

- Coordinating temporary matchmaking entries; that belongs to server-data.
- Designing a purchase catalog; that belongs to monetization.
- Wiring a client inventory view; that belongs to networking or gui.

## Core instructions

### 1. Define durable invariants

1. Use DataStoreService only from server code in ServerScriptService.
2. ALWAYS distinguish a missing record from a failed read and an invalid existing record.
3. NEVER replace a failed or malformed load with a default that can overwrite real progress.
4. Use a stable UserId-based key and a versioned schema.
5. Save serializable primitives and tables; NEVER persist Instances, functions, or connections.
6. Validate finite numbers, valid UTF-8, field bounds, and record size before writing.
7. Test against a separate universe; Studio API access can reach real production stores.
8. Document session ownership, retry, shutdown, and recovery guarantees before enabling trades.

### 2. Migrate deterministically

- Start new players from a freshly allocated default record.
- Make migration steps deterministic and safe to execute again after a failed write.
- NEVER silently downgrade a record from a newer schema version.
- Validate each migrated field; do not copy arbitrary external keys into live state.
- Preserve unknown future versions for investigation instead of deleting them.
- Back up representative records before deploying a destructive migration.

This pure schema parser supports one old shape and one current shape.
It rejects malformed existing data rather than manufacturing a valid-looking balance.

```luau
--!strict
type Profile = {schemaVersion: number, coins: number, inventory: {[string]: number}}

local function migrate(raw: unknown): Profile?
    if raw == nil then
        return {schemaVersion = 2, coins = 0, inventory = {}}
    end
    if type(raw) ~= "table" then
        return nil
    end
    local version = raw.schemaVersion
    if version ~= 1 and version ~= 2 then
        return nil
    end
    local coins = if version == 1 then raw.gold else raw.coins
    if type(coins) ~= "number" or coins ~= coins or coins % 1 ~= 0 then
        return nil
    end
    if coins < 0 or coins > 1_000_000_000 then
        return nil
    end
    local inventory: {[string]: number} = {}
    if version == 2 then
        if type(raw.inventory) ~= "table" then return nil end
        local count = 0
        for id, quantity in raw.inventory do
            count += 1
            if count > 200 or type(id) ~= "string" or #id > 48 then return nil end
            if not utf8.len(id) then return nil end
            if type(quantity) ~= "number" or quantity % 1 ~= 0 then return nil end
            if quantity < 0 or quantity > 999 then return nil end
            inventory[id] = quantity
        end
    end
    return {schemaVersion = 2, coins = coins, inventory = inventory}
end

local migrated = migrate({schemaVersion = 1, gold = 7})
assert(migrated and migrated.coins == 7)
assert(migrate({schemaVersion = 99, coins = 7}) == nil)
assert(migrate({schemaVersion = 1, gold = 0 / 0}) == nil)
```

### 3. Choose writes by consistency requirements

- Use UpdateAsync when a value depends on its previous durable state.
- Its transform can execute more than once and MUST NOT yield.
- NEVER grant external rewards, fire remotes, or log one-time outcomes inside the transform.
- Return nil to cancel a write when validation or ownership fails.
- Preserve associated UserIds and metadata when transforming existing keys that use them.
- A failed write can have an unknown outcome; retries MUST reuse the same operation ID.
- NEVER mix direct writes with a session-managed profile system for the same keys.

This independent store records one completion per fixed chapter key.
The allowlisted server chapter determines the reward; callers cannot set the amount.
It is intentionally separate from any session-managed player wallet.

```luau
--!strict
local DataStoreService = game:GetService("DataStoreService")
local store = DataStoreService:GetDataStore("ChapterCompletions_v1")
local chapters: {[string]: boolean} = {Intro = true, Forest = true}

local function recordChapter(userId: number, chapter: string): boolean
    assert(chapters[chapter], "Unknown server chapter")
    local ok, result = pcall(function()
        return store:UpdateAsync("u_" .. userId .. "_" .. chapter, function(old, keyInfo)
            local userIds = if keyInfo then keyInfo:GetUserIds() else {userId}
            local metadata = if keyInfo then keyInfo:GetMetadata() else {}
            if old ~= nil then
                if type(old) ~= "table" or old.completed ~= true then
                    return nil
                end
                return old, userIds, metadata
            end
            return {completed = true, completedAt = os.time()}, userIds, metadata
        end)
    end)
    return ok and type(result) == "table" and result.completed == true
end

return recordChapter
```

### 4. Bound persistence work and preserve failures

- Keep active profiles in memory and save at controlled intervals with jitter.
- Coalesce dirty changes; NEVER write a DataStore key for every coin pickup.
- Observe request budgets and errors rather than assuming a fixed throughput.
- Retry transient failures with backoff and a deadline; do not retry malformed data forever.
- Track dirty state until the write is confirmed, including concurrent changes during a save.
- Budget final saves concurrently within the platform's shutdown deadline.
- BindToClose and PlayerRemoving may overlap; serialize or deduplicate finalization.
- NEVER claim shutdown callbacks guarantee a successful save after a process crash.

This helper retries an idempotent operation with a bounded attempt count.
Use it only when the callback has stable operation identity or no duplicate side effects.

```luau
--!strict
local function retry(operation: () -> any, attempts: number): (boolean, any)
    assert(attempts >= 1 and attempts <= 5 and attempts % 1 == 0)
    local lastError: any = nil
    for attempt = 1, attempts do
        local ok, result = pcall(operation)
        if ok then
            return true, result
        end
        lastError = result
        if attempt < attempts then
            task.wait(math.min(2 ^ (attempt - 1), 8) + math.random() * 0.25)
        end
    end
    return false, lastError
end

local calls = 0
local ok, value = retry(function()
    calls += 1
    return "ready"
end, 3)
assert(ok and value == "ready" and calls == 1)
```

### 5. Integrate existing profile libraries and recovery

- ProfileService and ProfileStore are third-party modules, not Roblox services.
- Inspect the installed version and public API before writing lifecycle integration.
- NEVER mix one library's load/release names with another library's session methods.
- Require explicit release/lost-session handling and remove gameplay access immediately on loss.
- Preserve user association, metadata, and migration behavior during any library transition.
- Use DataStore version APIs and a reviewed restore procedure for recovery.
- Verify a restore in a staging environment and reconcile purchases made after the backup.

## Common mistakes

- Calling GetAsync then blindly SetAsync; use a consistency strategy that prevents lost updates.
- Treating nil and an exception identically; only a successful missing read permits defaults.
- Mutating rewards inside UpdateAsync; return the new record and act after confirmation.
- Clearing dirty state while newer changes exist; compare the saved mutation revision.
- Releasing a profile while callbacks still mutate it; stop access before final save and release.

## Reference

- [Data stores](https://create.roblox.com/docs/cloud-services/data-stores).
- [Player data and session locking](https://create.roblox.com/docs/cloud-services/data-stores/player-data-purchasing).
- [Versioning and caching](https://create.roblox.com/docs/cloud-services/data-stores/versioning-listing-and-caching).
