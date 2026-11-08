---
name: input
description: >
  Implements contextual Roblox actions across keyboard, mouse, touch, and gamepad using the Input Action System. Use when asked to "bind an action", "add mobile controls", "support a controller", "fix input while typing", "set up input contexts", or "handle a device switch".
---

# Roblox Input

## When to use

- Defining actions with keyboard, gamepad, and touch bindings.
- Enabling gameplay, menu, vehicle, or tool input contexts.
- Debugging stuck held actions and duplicate listeners.
- Updating prompts when the player's preferred input device changes.

## When NOT to use

- Designing responsive menu geometry; that belongs to gui.
- Granting authoritative ability outcomes; that belongs to networking and security.
- Owning camera transforms; that belongs to camera.

## Core instructions

### 1. Define actions before devices

1. Name actions by intent, such as Interact, Sprint, Confirm, or PrimaryAttack.
2. ALWAYS distinguish press, release, held state, analog value, and contextual availability.
3. Prefer InputContext, InputAction, and InputBinding for new cross-platform action systems.
4. Preserve an existing compatible ContextActionService integration when a narrow fix is sufficient.
5. NEVER run hardware input logic on the server; send validated intent through the game's protocol.
6. Group related actions into contexts with explicit priority and sink behavior.
7. Do not override Roblox core controls casually or duplicate the default jump action.
8. Test with actual hardware as well as Studio's device emulation.

### 2. Create contextual bindings

- Parent client contexts under the local player's hierarchy.
- Set action type before creating bindings that depend on its state type.
- Use Bool for discrete press/release actions and direction types for analog movement.
- NEVER use the deprecated InputAction:Fire method for scripted input.
- If synthetic input is required, use supported scriptable InputBinding behavior.
- Keep one action subscription even when the action has several hardware bindings.

This LocalScript creates one action with keyboard and gamepad bindings.
Place it in StarterPlayerScripts; the action demonstrates intent without granting a reward.
The owner must destroy the context when this feature is permanently removed.

```luau
--!strict
local Players = game:GetService("Players")
local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")

local context = Instance.new("InputContext")
context.Name = "ExplorationInput"
context.Priority = 10
context.Sink = true
context.Enabled = true
context.Parent = playerGui

local interact = Instance.new("InputAction")
interact.Name = "Interact"
interact.Type = Enum.InputActionType.Bool
interact.Enabled = true
interact.Parent = context

for _, key in {Enum.KeyCode.E, Enum.KeyCode.ButtonX} do
    local binding = Instance.new("InputBinding")
    binding.KeyCode = key
    binding.Parent = interact
end

interact.Pressed:Connect(function()
    print("Local interaction requested")
end)
```

### 3. Add touch through the same action

- Use an InputBinding.UIButton reference to route touch UI into the same action.
- Do not also fire gameplay from the button's Activated event for that action.
- Keep important touch controls away from reserved movement and system UI regions.
- Make buttons large enough to use comfortably and provide visible pressed feedback.
- NEVER infer that TouchEnabled means keyboard or gamepad cannot be present.
- Use current preferred input to choose prompts, while preserving working bindings for all devices.

This client helper binds an existing TextButton to an existing Bool action.
It does not replace the button's layout, ownership, or accessibility labels.

```luau
--!strict
local function attachTouch(action: InputAction, button: TextButton): () -> ()
    assert(action.Type == Enum.InputActionType.Bool)
    local binding = Instance.new("InputBinding")
    binding.Name = "TouchBinding"
    binding.UIButton = button
    binding.Parent = action

    local oldText = button.Text
    button.Text = "Interact"
    button.Selectable = true

    return function()
        binding:Destroy()
        if button.Parent then
            button.Text = oldText
        end
    end
end

return attachTouch
```

### 4. Respect focus and lifecycle

- Disable the appropriate gameplay context while text input or a blocking menu owns focus.
- Keep separate contexts for menus and gameplay instead of scattering global booleans.
- Handle release or cancellation so Sprint, Aim, and Charge do not remain stuck.
- Reset held state on focus loss, context disable, death, and controller teardown.
- For raw UserInputService events, honor gameProcessedEvent and GetFocusedTextBox.
- NEVER send movement or interaction remotes every frame merely because a key is held.
- Rate-limit and validate ability requests again on the server.

This raw-input example is suitable for a local diagnostic toggle.
Use an action context instead when the input is a normal gameplay action.

```luau
--!strict
local UserInputService = game:GetService("UserInputService")
local enabled = false

local connection = UserInputService.InputBegan:Connect(function(input, processed)
    if processed or UserInputService:GetFocusedTextBox() then
        return
    end
    if input.KeyCode == Enum.KeyCode.F8 then
        enabled = not enabled
        print("Local diagnostics", enabled)
    end
end)

local function destroy()
    connection:Disconnect()
end

return destroy
```

### 5. Verify device transitions

- Change from touch to gamepad and keyboard during one session.
- Check action availability while chat, a TextBox, a menu, and a purchase prompt are open.
- Test analog dead zones, diagonal normalization, and inverted axes when relevant.
- Verify one press produces one intent even when both UI and hardware bindings exist.
- Confirm controls recover after respawn and menus close cleanly on gamepad.
- Inspect InputContext priority collisions when a lower-priority action stops firing.
- Recheck current API availability in the targeted Studio/client channel before shipping.

## Common mistakes

- Binding a button and Activated to the same action; use a single dispatch path.
- Using device capability as exclusive mode; support mixed devices and preferred-input changes.
- Forgetting release on focus loss; clear held state on every cancellation path.
- Nesting contexts to imply priority inheritance; configure each context's priority explicitly.
- Trusting a keypress as permission; validate the requested gameplay action on the server.

## Reference

- [Roblox input](https://create.roblox.com/docs/input).
- [InputContext](https://create.roblox.com/docs/reference/engine/classes/InputContext).
- [InputBinding](https://create.roblox.com/docs/reference/engine/classes/InputBinding).
