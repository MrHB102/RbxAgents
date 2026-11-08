---
name: luau-types
description: >
  Defines and repairs strict Luau type contracts, generics, tagged unions, and runtime narrowing. Use when asked to "fix a type error", "add strict typing", "type a ModuleScript", "write a generic helper", "narrow an optional value", or "model a typed remote payload".
---

# Luau Types

## When to use

- Introducing strict annotations to a shared or server module.
- Modeling states, results, payloads, and module exports.
- Fixing generic inference, optional instance, or union narrowing errors.
- Validating external data before exposing a typed internal representation.

## When NOT to use

- Explaining basic table iteration; that belongs to luau-core.
- Selecting a state machine's gameplay rules; that belongs to luau-patterns or game-design.
- Establishing server trust solely through annotations; that belongs to security.

## Core instructions

### 1. Identify the contract before annotating

1. Enable `--!strict` and inspect all callers before changing an exported type.
2. Name domain records with `type` and expose public contracts with `export type`.
3. ALWAYS distinguish optional data from data guaranteed after initialization.
4. Use `unknown` at untrusted boundaries and narrow it with runtime validation.
5. NEVER use `any` or `::` as proof that client input is safe.
6. A type alias is erased at runtime; create actual validation when data enters the system.
7. Prefer a small concrete type over a generic abstraction with one caller.
8. Keep shared types in ReplicatedStorage only when their content can be public.

### 2. Represent alternatives with tagged unions

- Give each alternative a literal discriminator such as `kind` or `ok`.
- Narrow the discriminator before accessing variant-specific fields.
- Model impossible combinations out of the type where practical.
- NEVER use a collection of optional fields to hide mutually exclusive states.
- Make failure reasons stable identifiers when callers branch on them.
- Preserve exhaustive handling when adding another alternative.

This module models a reward calculation without coupling it to Roblox instances.
Place it in ReplicatedStorage.Shared if both execution contexts need the calculation.

```luau
--!strict
export type RewardResult =
    {kind: "Granted", coins: number}
    | {kind: "Denied", reason: "AlreadyClaimed" | "NotReady"}

local function describe(result: RewardResult): string
    if result.kind == "Granted" then
        return string.format("Granted %d coins", result.coins)
    end
    return "Denied: " .. result.reason
end

local granted: RewardResult = {kind = "Granted", coins = 25}
local denied: RewardResult = {kind = "Denied", reason = "NotReady"}

assert(describe(granted) == "Granted 25 coins")
assert(describe(denied) == "Denied: NotReady")

return {describe = describe}
```

### 3. Use generics to retain relationships

- A generic parameter MUST express a relationship between inputs and outputs.
- Keep array element types through map, filter, or selection operations.
- Avoid forcing heterogeneous tables into homogeneous array types.
- State callback signatures precisely, including multiple returns when relevant.
- NEVER erase a useful inferred type merely to make the checker quiet.
- Prefer the project's currently supported solver syntax over experimental features.

This example preserves input and output element types through a generic function.
The implementation uses a dense array; it does not promise dictionary support.

```luau
--!strict
local function map<T, U>(items: {T}, transform: (T, number) -> U): {U}
    local output: {U} = table.create(#items)
    for index, item in items do
        output[index] = transform(item, index)
    end
    return output
end

local names: {string} = {"Sword", "Shield"}
local lengths: {number} = map(names, function(name: string, _index: number)
    return #name
end)

assert(lengths[1] == 5)
assert(lengths[2] == 6)

local function identity<T>(value: T): T
    return value
end

assert(identity(7) == 7)
```

### 4. Narrow Roblox instances and dynamic values

- `FindFirstChild` can return nil and does not guarantee the desired class.
- Use `IsA` before accessing class-specific properties.
- `WaitForChild` with a timeout can fail; handle absence explicitly.
- ALWAYS revalidate instance lifetime after yielding when later mutation depends on it.
- Type refinements are local reasoning aids; another task can still destroy an instance.
- NEVER cast a remote argument to `Player` and treat it as the authenticated caller.
- Use the `Player` supplied by `OnServerEvent` as the sender identity.

This boundary accepts an unknown value and constructs a validated typed record.
The payload carries only a catalog key and quantity; the server owns the price.

```luau
--!strict
type Request = {itemId: string, quantity: number}

local function parseRequest(value: unknown): Request?
    if type(value) ~= "table" then
        return nil
    end
    local itemId = value.itemId
    local quantity = value.quantity
    if type(itemId) ~= "string" or #itemId > 48 then
        return nil
    end
    if type(quantity) ~= "number" or quantity ~= quantity then
        return nil
    end
    if quantity % 1 ~= 0 or quantity < 1 or quantity > 10 then
        return nil
    end
    return {itemId = itemId, quantity = quantity}
end

assert(parseRequest({itemId = "Potion", quantity = 2}) ~= nil)
assert(parseRequest({itemId = "Potion", quantity = math.huge}) == nil)
assert(parseRequest(false) == nil)
```

### 5. Keep module and object types maintainable

- Derive an object's public type with `typeof` only when it improves clarity.
- Avoid circular requires introduced solely to import types.
- Extract a small type-only module if a real dependency cycle requires it.
- A read-only convention is not enforced by an ordinary mutable table annotation.
- Use `table.freeze` when runtime immutability is part of the contract.
- Annotate a metatable method's `self` when inference cannot express its shape clearly.
- Check both Studio diagnostics and the project's matching external type environment.
- NEVER invent Roblox engine type definitions just to silence missing tooling support.

### 6. Verify type behavior

- Include accepted and rejected payload fixtures for runtime validators.
- Check callers after changing exported discriminators, fields, or callback returns.
- Confirm that strict diagnostics do not require broad suppressions.
- Run runtime tests for validation; a clean static report does not exercise malformed input.

## Common mistakes

- Treating `:: SomeType` as validation; check the value and build a trusted record.
- Letting `any` spread through module exports; confine it to a documented interop boundary.
- Accessing `.Position` on an unverified Instance; narrow it with `IsA("BasePart")`.
- Using optional fields for every state; model the alternatives with tagged unions.
- Over-generalizing one helper; use a concrete type until a real relationship needs a generic.

## Reference

- [Luau type checking](https://luau.org/typecheck).
- [Luau syntax and type annotations](https://luau.org/syntax).
- [Roblox Instance API](https://create.roblox.com/docs/reference/engine/classes/Instance).
