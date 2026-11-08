---
name: luau-patterns
description: >
  Applies small Luau module, object, signal, state-machine, and dependency-injection patterns with explicit lifecycles. Use when asked to "structure a ModuleScript", "fix a connection leak", "write a state machine", "inject a dependency", "create a reusable object", or "replace circular requires".
---

# Luau Design Patterns

## When to use

- Building a reusable gameplay module with explicit creation and cleanup.
- Replacing tangled conditionals with a small state machine.
- Testing logic independently of Roblox services through injected functions.
- Debugging signal subscriptions, duplicated initialization, or circular requires.

## When NOT to use

- Choosing the whole project's service graph; that belongs to architecture.
- Building typed generic libraries; that belongs to luau-types.
- Optimizing a measured frame bottleneck; that belongs to performance.

## Core instructions

### 1. Select the smallest pattern that expresses ownership

1. Use a plain function for a computation and a table for a small module API.
2. Use a constructor only when separate instances need separate mutable state.
3. ALWAYS define who creates, starts, stops, and destroys an object.
4. NEVER introduce an inheritance hierarchy for unrelated gameplay features.
5. A ModuleScript is cached per execution environment, not shared memory across clients.
6. Keep module loading free of hidden network calls and indefinite waits.
7. Inject dependencies that make side effects controllable in tests.
8. NEVER require numeric asset IDs from untrusted or player-controlled input.

### 2. Model objects with explicit disposal

- Prefer composition over inheritance for timers, effects, and controllers.
- Record every event connection whose publisher can outlive the subscriber.
- Make destruction idempotent and stop future callbacks after disposal.
- Remove references from registries when objects are destroyed.
- Cancel scheduled work or invalidate it with a generation token.
- NEVER assume destroying one Instance clears references stored in arbitrary Lua tables.

This ModuleScript owns one Heartbeat connection and an injected update callback.
Put server-only controllers under ServerScriptService, not ReplicatedStorage.

```luau
--!strict
local RunService = game:GetService("RunService")
local Controller = {}
Controller.__index = Controller

type Fields = {
    connection: RBXScriptConnection?,
    destroyed: boolean,
}
export type Controller = typeof(setmetatable({} :: Fields, Controller))

function Controller.new(step: (number) -> ()): Controller
    local self = setmetatable({
        connection = nil :: RBXScriptConnection?,
        destroyed = false,
    }, Controller)
    self.connection = RunService.Heartbeat:Connect(function(dt)
        if not self.destroyed then
            step(dt)
        end
    end)
    return self
end

function Controller.Destroy(self: Controller)
    if self.destroyed then
        return
    end
    self.destroyed = true
    if self.connection then
        self.connection:Disconnect()
        self.connection = nil
    end
end

return Controller
```

### 3. Make transitions explicit

- Keep state transitions in one function, with allowed transitions declared nearby.
- State entry owns its timers and subscriptions; state exit releases them.
- NEVER yield halfway through a transition that must be atomic.
- Use monotonically increasing generation tokens to reject stale async completions.
- Do not turn every boolean into a state machine; use it for real mutually exclusive modes.
- Log rejected transitions during development without flooding production Output.

This pure example validates transition rules before assigning the next state.
Integrate animation and movement as entry/exit actions after the rules are tested.

```luau
--!strict
type State = "Idle" | "Chase" | "Stunned"
local allowed: {[State]: {[State]: boolean}} = {
    Idle = {Chase = true, Stunned = true},
    Chase = {Idle = true, Stunned = true},
    Stunned = {Idle = true},
}

local state: State = "Idle"
local generation = 0

local function transition(nextState: State): boolean
    if not allowed[state][nextState] then
        return false
    end
    generation += 1
    state = nextState
    return true
end

assert(transition("Chase"))
assert(transition("Stunned"))
assert(not transition("Chase"))
assert(state == "Stunned" and generation == 2)
```

### 4. Use signals and dependency injection deliberately

- Use Roblox events when they already describe the required lifecycle.
- Use BindableEvent for local event communication when its Instance lifecycle is useful.
- NEVER use BindableEvent as client-server transport; it does not cross that boundary.
- If the project has a signal library, preserve its ordering and cleanup semantics.
- Avoid inventing a general signal library for one callback.
- Inject a clock, random generator, or persistence function when tests need deterministic control.
- Keep injected contracts small and document whether they may yield.

The cooldown factory below requires no services and can be tested with a fake clock.
Its owner must create a separate instance for each independent cooldown domain.

```luau
--!strict
local function newCooldown(duration: number, clock: () -> number)
    assert(duration >= 0 and duration < math.huge)
    local readyAt = -math.huge
    return function(): boolean
        local now = clock()
        if now < readyAt then
            return false
        end
        readyAt = now + duration
        return true
    end
end

local now = 0
local use = newCooldown(2, function()
    return now
end)

assert(use())
assert(not use())
now = 2
assert(use())
```

### 5. Verify lifecycle behavior

- Create, destroy, and recreate the object repeatedly without duplicate callbacks.
- Test destruction while an async task is waiting.
- Test reentrant events if callbacks can trigger their own publisher.
- Ensure module constructors do not accidentally reuse mutable defaults.
- Review every callback closure for captured player, character, and instance references.

## Common mistakes

- Starting services during `require`; expose explicit initialization so order is visible.
- Keeping connections after an object's owner leaves; disconnect and remove registry entries.
- Mutating shared module state for each player; allocate separate records per player.
- Completing old async work after a state change; reject stale generation tokens.
- Adding a global service locator for one dependency; pass the needed function directly.

## Reference

- [ModuleScript](https://create.roblox.com/docs/reference/engine/classes/ModuleScript).
- [Bindable events](https://create.roblox.com/docs/scripting/events/bindable).
- [Luau metatables and types](https://luau.org/typecheck).
