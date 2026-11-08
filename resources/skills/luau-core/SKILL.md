---
name: luau-core
description: >
  Implements correct Luau functions, tables, strings, control flow, and error handling in Roblox. Use when asked to "fix a Luau error", "write a table helper", "parse a string", "handle a failing API call", "convert Lua code to Luau", or "debug unexpected nil values".
---

# Core Luau

## When to use

- Writing functions that transform game state or validate primitive values.
- Debugging nil access, table mutation, scope, or multiple-return errors.
- Handling UTF-8 text, patterns, asynchronous calls, and failures.
- Replacing legacy Lua idioms with supported Luau and Roblox APIs.

## When NOT to use

- Designing advanced generic interfaces; that belongs to luau-types.
- Choosing a service graph or lifecycle framework; that belongs to architecture.
- Designing persistence guarantees; that belongs to data and server-data.

## Core instructions

### 1. Establish language and execution context

1. ALWAYS identify whether code executes on the server, client, or in an edit tool.
2. Use `--!strict` for new modules unless the project has a documented exception.
3. Obtain services through `game:GetService()` and keep variables local.
4. Use `task.spawn`, `task.defer`, and `task.wait` instead of legacy scheduler globals.
5. NEVER assume `task.wait(seconds)` resumes at an exact deadline.
6. Use `os.clock()` for local elapsed durations and UTC timestamps for persisted time.
7. NEVER use client timestamps as authoritative proof of an action's timing.
8. Keep pure computations separate from network calls and instance mutation.

### 2. Validate numbers and preserve return contracts

- A Luau `number` can be NaN or infinity; type checking alone is insufficient.
- `0`, empty strings, and empty tables are truthy; only `false` and `nil` are falsy.
- Use explicit nil checks when false is a valid configuration value.
- Return a consistent success value and failure reason for recoverable invalid input.
- NEVER convert untrusted strings with `tonumber` and then skip range checks.
- Use `assert` for broken internal invariants, not normal player input rejection.

This pure helper can live in ReplicatedStorage.Shared for server and client reuse.
Reusing validation on the client does not replace server validation.

```luau
--!strict
local function parseCount(value: unknown): (number?, string?)
    if type(value) ~= "number" then
        return nil, "Expected a number"
    end
    if value ~= value or math.abs(value) == math.huge then
        return nil, "Expected a finite number"
    end
    if value % 1 ~= 0 or value < 1 or value > 100 then
        return nil, "Count is outside the allowed range"
    end
    return value, nil
end

local count, reason = parseCount(3)
assert(count == 3 and reason == nil)
assert(select(1, parseCount(0 / 0)) == nil)
assert(select(1, parseCount("3")) == nil)
assert(select(1, parseCount(1.5)) == nil)
```

### 3. Use tables intentionally

- Use dense arrays for ordered sequences and dictionaries for lookup by identifier.
- NEVER rely on `#table` to count sparse arrays or dictionaries.
- Dictionary iteration order is not a sorting contract.
- Do not remove an array element while iterating forward across the same indices.
- `table.clone` is shallow; nested mutable values remain shared.
- `table.freeze` is shallow; freeze nested tables separately when required.
- NEVER use the same mutable default inventory for several players.
- Prefer `table.create` only when capacity is known and allocation matters.

This example owns its inventory entries and removes consumed stacks safely.
For large inventories, maintain an item-ID lookup instead of repeated scans.

```luau
--!strict
type Stack = {id: string, count: number}

local function copyInventory(source: {Stack}): {Stack}
    local result: {Stack} = table.create(#source)
    for _, stack in source do
        table.insert(result, {id = stack.id, count = stack.count})
    end
    return result
end

local function removeEmpty(inventory: {Stack})
    for index = #inventory, 1, -1 do
        if inventory[index].count <= 0 then
            table.remove(inventory, index)
        end
    end
end

local original = {{id = "Potion", count = 2}}
local copied = copyInventory(original)
copied[1].count = 0
removeEmpty(copied)
assert(#copied == 0 and original[1].count == 2)
```

### 4. Handle text as bytes or UTF-8 deliberately

- `#text` and `string.sub` operate on bytes, not displayed characters.
- Validate `utf8.len(text)` before persisting untrusted strings.
- Luau patterns are not regular expressions; `%d`, captures, and anchors have specific syntax.
- Bound input byte length before running patterns or allocating output.
- NEVER use `string.lower` as a complete Unicode case-folding implementation.
- Filter player-generated text through TextService before showing it to others.
- Keep identifiers separate from display text and localized labels.

### 5. Preserve errors at asynchronous boundaries

- Wrap network-facing Roblox calls in `pcall` and inspect both status and result.
- A successful `pcall` does not prove the returned result means success.
- NEVER swallow every exception and silently continue with invalid state.
- Use bounded retries only for operations whose duplicate effects are understood.
- Keep `UpdateAsync` transforms non-yielding and free of external side effects.
- Report errors with operation context, excluding credentials and private payloads.

This server example protects JSON decoding without pretending malformed data is valid.
Put the module under ServerScriptService when its callers handle backend responses.

```luau
--!strict
local HttpService = game:GetService("HttpService")

local function decodeObject(body: string): (any?, string?)
    if #body > 16_384 then
        return nil, "Response is too large"
    end
    local ok, value = pcall(function()
        return HttpService:JSONDecode(body)
    end)
    if not ok then
        return nil, "Invalid JSON"
    end
    if type(value) ~= "table" then
        return nil, "Expected an object or array"
    end
    return value, nil
end

assert(select(1, decodeObject("broken")) == nil)
assert(select(1, decodeObject('{"ready":true}')) ~= nil)
```

### 6. Verify the behavior

- Test empty input, boundary values, false, nil, invalid UTF-8, and non-finite numbers.
- Check mutation ownership by changing one copy and inspecting another.
- Test exceptions as well as successful API results.
- Run the project's type checker; syntax validity alone does not prove API correctness.

## Common mistakes

- Using `value or default` when false is meaningful; check `value == nil` explicitly.
- Copying only an inventory's outer table; clone each mutable nested record.
- Treating `pcall` status as a business result; validate the returned value too.
- Counting dictionary entries with `#`; count keys or maintain a deliberate counter.
- Cutting translated text at arbitrary bytes; use UTF-8 boundaries and UI truncation.

## Reference

- [Luau syntax](https://luau.org/syntax).
- [Luau standard library](https://luau.org/library).
- [Roblox task library](https://create.roblox.com/docs/reference/engine/libraries/task).
