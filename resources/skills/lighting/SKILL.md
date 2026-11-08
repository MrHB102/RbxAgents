---
name: lighting
description: >
  Configures Roblox global lighting, local lights, atmosphere, post-processing, and time-of-day transitions. Use when asked to "set a lighting mood", "fix dark interiors", "build a day-night cycle", "reduce shadow cost", "add atmospheric fog", or "tune post-processing".
---

# Roblox Lighting and Atmosphere

## When to use

- Establishing readable global lighting and environmental mood.
- Creating controlled day/night or weather presentation.
- Tuning Atmosphere, local lights, and post-processing effects.
- Debugging mobile readability, excessive bloom, or expensive shadows.

## When NOT to use

- Authoring map geometry or mesh materials from scratch; that belongs to building.
- Building particles and transient combat effects; that belongs to animation-vfx.
- Applying a cinematic camera path; that belongs to camera.

## Core instructions

### 1. Define readability and ownership

1. Capture baseline screenshots at representative locations and graphics levels.
2. ALWAYS prioritize navigation, enemy silhouettes, interactables, and text readability.
3. Identify one owner for each global Lighting property and weather effect.
4. NEVER stack untracked post-processing objects on every respawn or scene change.
5. Separate server-shared world settings from per-player accessibility and cinematic effects.
6. Preserve unrelated Atmosphere, Sky, Clouds, and lighting configuration.
7. Use current LightingStyle and PrioritizeLightingQuality settings where supported.
8. NEVER introduce deprecated Lighting.Technology assignments into new examples.

### 2. Establish a restrained baseline

- Tune ClockTime, Brightness, ExposureCompensation, ambient values, and shadows together.
- Configure LightingStyle in the supported authoring context if runtime writes are restricted.
- Avoid using excessive Ambient to erase all interior contrast.
- Check local light range and brightness before increasing global exposure.
- Keep a versioned preset with known test locations and screenshots.
- Do not assume the same shadow detail exists on every graphics level.

This server or edit-time baseline changes only ordinary global properties.
Choose the project's LightingStyle through the supported Studio settings workflow.

```luau
--!strict
local Lighting = game:GetService("Lighting")

local preset = {
    ClockTime = 14,
    Brightness = 2,
    ExposureCompensation = 0,
    Ambient = Color3.fromRGB(55, 58, 68),
    OutdoorAmbient = Color3.fromRGB(105, 112, 125),
}

Lighting.ClockTime = preset.ClockTime
Lighting.Brightness = preset.Brightness
Lighting.ExposureCompensation = preset.ExposureCompensation
Lighting.Ambient = preset.Ambient
Lighting.OutdoorAmbient = preset.OutdoorAmbient
Lighting.GlobalShadows = true

assert(Lighting.ClockTime == 14)
print("Lighting baseline applied")
```

### 3. Own atmosphere and post-processing resources

- Reuse a named effect owned by the feature instead of cloning another copy.
- Treat an existing unowned atmosphere as a design dependency before changing it.
- Atmosphere alters distance readability; evaluate combat sightlines after tuning density.
- Bloom MUST NOT erase important highlight detail or turn every emissive surface into glare.
- Use camera-parented post-processing when an effect is intentionally local to one view.
- NEVER leave a temporary BlurEffect enabled after its menu or cutscene closes.
- Respect reduced motion and visual comfort when animating strong exposure changes.

This example creates or reuses one owned color correction effect.
It refuses a conflicting class instead of silently replacing an existing object.

```luau
--!strict
local Lighting = game:GetService("Lighting")
local name = "WorldColorGrade"
local existing = Lighting:FindFirstChild(name)
assert(existing == nil or existing:IsA("ColorCorrectionEffect"), "Effect name conflict")

local effect: ColorCorrectionEffect
if existing and existing:IsA("ColorCorrectionEffect") then
    effect = existing
else
    effect = Instance.new("ColorCorrectionEffect")
    effect.Name = name
    effect.Parent = Lighting
end

effect.Brightness = 0
effect.Contrast = 0.05
effect.Saturation = -0.08
effect.TintColor = Color3.fromRGB(255, 248, 238)
effect.Enabled = true
```

### 4. Compute day/night from time, not accumulated frame assumptions

- Decide whether time follows server uptime, an event timeline, or a shared world epoch.
- Use elapsed-time formulas to avoid drift from delayed task resumes.
- NEVER use `ClockTime += constant` without dt or an actual time basis.
- A local day/night calculation is presentation; gameplay schedules need server authority.
- Interpolate wrapped clock values through midnight deliberately.
- Stagger light toggles and avoid replicating dozens of small property writes every frame.
- Enable shadows selectively on lights where the visual benefit justifies the cost.

This client presentation loop follows the server's synchronized time estimate.
Store a chosen DayCycleEpoch attribute on ReplicatedStorage through the server or build.
The loop computes a continuous cycle without accumulating scheduler drift.

```luau
--!strict
local Lighting = game:GetService("Lighting")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local epoch = ReplicatedStorage:GetAttribute("DayCycleEpoch")
assert(type(epoch) == "number" and epoch == epoch and math.abs(epoch) < math.huge)
local cycleSeconds = 1_200
local accumulated = 0

local connection = RunService.Heartbeat:Connect(function(dt)
    accumulated += dt
    if accumulated < 0.1 then return end
    accumulated %= 0.1
    local progress = ((Workspace:GetServerTimeNow() - epoch) % cycleSeconds) / cycleSeconds
    Lighting.ClockTime = progress * 24
end)

return function()
    connection:Disconnect()
end
```

### 5. Verify the whole environment

- Inspect noon, dusk, midnight, and sunrise at all important gameplay locations.
- Test fog and atmosphere against maximum required target visibility.
- Compare interiors and exteriors on a low graphics setting.
- Check overlapping shadowed lights and expensive transparent effects together.
- Verify weather changes do not permanently replace a user's local accessibility effects.
- Capture before/after images using the same camera and graphics conditions.
- Test repeated preset transitions for duplicated Instances and lingering tweens.
- Record which properties the system owns and restore them when a temporary mode ends.

## Common mistakes

- Recreating effects on each respawn; reuse a named owned effect or destroy the previous one.
- Brightening everything to fix one room; adjust local lights and material response.
- Accumulating ClockTime per tick; calculate it from elapsed time and a stable epoch.
- Designing only at maximum graphics; validate readability on lower settings.
- Using heavy bloom to hide weak lighting; establish balanced exposure first.

## Reference

- [Global lighting](https://create.roblox.com/docs/environment/lighting).
- [Atmosphere](https://create.roblox.com/docs/reference/engine/classes/Atmosphere).
- [Post-processing effects](https://create.roblox.com/docs/environment/post-processing-effects).
