---
name: gui
description: >
  Builds responsive and accessible Roblox menus, HUDs, dialogs, and navigation across device sizes. Use when asked to "build a shop UI", "fix mobile scaling", "add gamepad navigation", "stop text clipping", "make a responsive HUD", or "improve menu accessibility".
---

# Roblox GUI

## When to use

- Creating ScreenGui interfaces, HUD components, dialogs, and menus.
- Fixing safe-area, text-size, scrolling, and aspect-ratio problems.
- Implementing keyboard and gamepad focus behavior.
- Respecting reduced motion, readable text, and clear interaction states.

## When NOT to use

- Defining an action binding system; that belongs to input.
- Verifying prices or purchases; that belongs to monetization and security.
- Translating the text catalog; that belongs to localization.

## Core instructions

### 1. Specify content, states, and device constraints

1. Identify the interface owner, visibility rules, data source, and supported inputs.
2. ALWAYS include loading, empty, error, disabled, and success states when applicable.
3. Distinguish StarterGui templates from each player's runtime PlayerGui instances.
4. NEVER make the UI authoritative for purchases, rewards, or inventory ownership.
5. Reuse existing design tokens and components before creating another visual system.
6. Keep interactive elements clear of device cutouts and Roblox system UI.
7. Plan for translated text expansion and preferred text size before tuning pixel positions.
8. Use clear labels and feedback that do not depend solely on color or sound.

### 2. Compose responsive layouts

- Use scale for overall placement and offsets for controlled spacing and minimum sizes.
- Use AnchorPoint deliberately instead of compensating with arbitrary position offsets.
- Use UIListLayout, UIGridLayout, UIPadding, and AutomaticSize for content flow.
- Constrain oversized panels with UISizeConstraint rather than a single global UIScale.
- NEVER shrink essential text until it fits an overcrowded design.
- Use ScrollingFrame with automatic canvas sizing for lists that exceed available space.
- Virtualize long lists when measured item counts make full rendering expensive.

This LocalScript creates a responsive, content-sized panel with a readable action.
Place it in StarterPlayerScripts or create the same hierarchy as a StarterGui template.
The action below is local presentation only.

```luau
--!strict
local Players = game:GetService("Players")
local gui = Instance.new("ScreenGui")
gui.Name = "ExampleMenu"
gui.ResetOnSpawn = false
gui.ScreenInsets = Enum.ScreenInsets.CoreUISafeInsets
gui.Parent = Players.LocalPlayer:WaitForChild("PlayerGui")

local panel = Instance.new("Frame")
panel.AnchorPoint = Vector2.new(0.5, 0.5)
panel.Position = UDim2.fromScale(0.5, 0.5)
panel.Size = UDim2.new(0.9, 0, 0, 0)
panel.AutomaticSize = Enum.AutomaticSize.Y
panel.BackgroundColor3 = Color3.fromRGB(26, 30, 38)
panel.Parent = gui

local constraint = Instance.new("UISizeConstraint")
constraint.MaxSize = Vector2.new(480, 1000)
constraint.Parent = panel
local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 16)
padding.PaddingBottom = UDim.new(0, 16)
padding.PaddingLeft = UDim.new(0, 16)
padding.PaddingRight = UDim.new(0, 16)
padding.Parent = panel
local layout = Instance.new("UIListLayout")
layout.Padding = UDim.new(0, 12)
layout.Parent = panel

local button = Instance.new("TextButton")
button.Size = UDim2.new(1, 0, 0, 52)
button.AutomaticSize = Enum.AutomaticSize.Y
button.TextWrapped = true
button.Text = "Continue"
button.TextSize = 20
button.TextColor3 = Color3.new(1, 1, 1)
button.BackgroundColor3 = Color3.fromRGB(48, 83, 139)
button.Selectable = true
button.Parent = panel
local corner = Instance.new("UICorner")
corner.CornerRadius = UDim.new(0, 10)
corner.Parent = button
button.Activated:Connect(function() gui.Enabled = false end)
```

### 3. Make navigation and focus explicit

- Use GuiButton.Activated for shared mouse, touch, and gamepad activation.
- Set Selectable only on meaningful interactive targets.
- Define directional selection for irregular layouts where automatic navigation fails.
- Remember prior focus when opening a modal and restore it if still valid.
- NEVER trap gamepad users in a dialog without a visible close or back action.
- Keep focus visible through a clear selected state.

This client helper transfers focus to a modal's first action.
Its owner must block underlying input and call the returned function when closing.

```luau
--!strict
local GuiService = game:GetService("GuiService")

local function focusModal(firstButton: GuiButton): () -> ()
    local previous = GuiService.SelectedObject
    firstButton.Selectable = true
    GuiService.SelectedObject = firstButton
    local closed = false

    return function()
        if closed then return end
        closed = true
        if previous and previous:IsDescendantOf(game) then
            GuiService.SelectedObject = previous
        elseif GuiService.SelectedObject == firstButton then
            GuiService.SelectedObject = nil
        end
    end
end

return focusModal
```

### 4. Respect accessibility and asynchronous state

- Honor GuiService.ReducedMotionEnabled when animating panels and feedback.
- Support preferred text size using readable base sizes and flexible bounds.
- TextScaled bypasses preferred text sizing behavior; use it deliberately and sparingly.
- Prevent duplicate submissions while a server request is pending.
- Show request failure and retry state without implying that a local timeout cancelled the server.
- NEVER embed unfiltered user text into RichText markup.
- Disconnect data subscriptions and cancel tweens when the view is destroyed.

This animation helper provides a reduced-motion path and a cancellation handle.
The caller chooses the starting position before showing the panel.

```luau
--!strict
local TweenService = game:GetService("TweenService")
local GuiService = game:GetService("GuiService")

local function movePanel(panel: GuiObject, position: UDim2): () -> ()
    if GuiService.ReducedMotionEnabled then
        panel.Position = position
        return function() end
    end
    local tween = TweenService:Create(
        panel,
        TweenInfo.new(0.18, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
        {Position = position}
    )
    tween:Play()
    return function()
        tween:Cancel()
        tween:Destroy()
    end
end

return movePanel
```

### 5. Verify real layouts

- Test narrow phones, tablets, desktop, and console-safe viewing distances.
- Increase preferred text size and use long translations and multiline labels.
- Navigate every action without a mouse, including scrolling and closing dialogs.
- Open and close the interface repeatedly while data requests are pending.
- Check respawn behavior against ResetOnSpawn and persistent controller ownership.
- Measure menu memory and frame time when rendering the largest supported list.

## Common mistakes

- Positioning every row manually; use layouts and padding with content-sized containers.
- Shrinking translated text to unreadable sizes; allow wrapping and additional space.
- Using MouseButton1Click as the sole action path; use Activated for cross-input activation.
- Losing selection after a modal closes; restore a still-valid previous focus target.
- Keeping view listeners after closing permanently; release subscriptions and owned tweens.

## Reference

- [Roblox UI](https://create.roblox.com/docs/ui).
- [Accessibility](https://create.roblox.com/docs/production/publishing/accessibility).
- [GuiService](https://create.roblox.com/docs/reference/engine/classes/GuiService).
