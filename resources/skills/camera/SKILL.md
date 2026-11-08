---
name: camera
description: >
  Builds Roblox follow, cinematic, transition, field-of-view, and shake cameras with safe ownership and restoration. Use when asked to "make a follow camera", "fix camera jitter", "add a cutscene", "animate FOV", "add camera shake", or "restore the camera after respawn".
---

# Roblox Camera Systems

## When to use

- Taking temporary ownership of Workspace.CurrentCamera for a cutscene.
- Implementing custom follow, shoulder, or inspection cameras.
- Adding frame-rate-independent smoothing, FOV changes, and camera shake.
- Debugging interference with Roblox's default camera controller.

## When NOT to use

- Moving physical vehicles or characters; that belongs to physics.
- Binding raw player actions; that belongs to input.
- Creating an AnimationTrack for a rig; that belongs to animation-vfx.

## Core instructions

### 1. Establish camera ownership

1. Run camera presentation from a LocalScript in StarterPlayerScripts or an owned client controller.
2. ALWAYS obtain Workspace.CurrentCamera at runtime and handle replacement.
3. Decide whether the feature adjusts the default camera or fully owns a Scriptable camera.
4. NEVER let independent render loops fight over Camera.CFrame.
5. Capture prior CameraType, CameraSubject, and FieldOfView before temporary ownership.
6. Restore control on completion, cancellation, target destruction, and respawn as appropriate.
7. Respect reduced-motion preferences and expose intensity controls for strong shake.
8. Test first person, gamepad, touch, aspect ratio, and VR when supported.

### 2. Update at the correct point in the frame

- Use BindToRenderStep when deterministic ordering relative to the default camera matters.
- Use a unique binding name and ALWAYS unbind it during teardown.
- NEVER yield or perform backend requests in a render callback.
- Use dt-based smoothing rather than a constant lerp coefficient per frame.
- Avoid camera targets whose own update order creates a one-frame lag.
- Adjust collision and occlusion deliberately; a camera must not reveal unintended geometry.

This client cinematic function restores its captured camera when it ends.
The owner must call the returned stop function on respawn or cancellation.
It also stops when CurrentCamera is replaced or the target leaves Workspace.

```luau
--!strict
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local Workspace = game:GetService("Workspace")
local activeStop: (() -> ())? = nil

local function follow(target: BasePart): () -> ()
    if activeStop then activeStop() end
    local camera = Workspace.CurrentCamera
    assert(camera, "CurrentCamera is unavailable")
    local oldType, oldSubject, oldFov = camera.CameraType, camera.CameraSubject, camera.FieldOfView
    local binding = "FeatureCinematicCamera"
    local active = true
    camera.CameraType = Enum.CameraType.Scriptable

    local function stop()
        if not active then return end
        active = false
        activeStop = nil
        RunService:UnbindFromRenderStep(binding)
        if camera.Parent then
            camera.CameraType = oldType
            if oldSubject and oldSubject.Parent then
                camera.CameraSubject = oldSubject
            else
                local character = Players.LocalPlayer.Character
                local humanoid = character and character:FindFirstChildOfClass("Humanoid")
                if humanoid then camera.CameraSubject = humanoid end
            end
            camera.FieldOfView = oldFov
        end
    end

    RunService:BindToRenderStep(binding, Enum.RenderPriority.Camera.Value + 1, function(dt)
        if Workspace.CurrentCamera ~= camera or not target:IsDescendantOf(Workspace) then
            stop()
            return
        end
        local focus = target.Position + Vector3.new(0, 2, 0)
        local position = focus + Vector3.new(0, 6, 14)
        local alpha = 1 - math.exp(-8 * dt)
        camera.CFrame = camera.CFrame:Lerp(CFrame.lookAt(position, focus), alpha)
        camera.Focus = CFrame.new(focus)
    end)
    activeStop = stop
    return stop
end

return follow
```

### 3. Manage transitions and FOV as owned effects

- Cancel a previous tween before starting a conflicting transition.
- Keep one owner for FOV so sprint, aim, and cutscene effects compose predictably.
- NEVER use a tween completion callback to restore state after the feature was cancelled without checking ownership.
- Bound FOV to the supported camera range and a comfortable gameplay range.
- Preserve user settings where the game exposes a baseline FOV.
- Use immediate state changes when reduced motion makes interpolation undesirable.

This client function returns a cancellation handle for one FOV transition.
The caller owns conflict resolution and restoration to its chosen baseline.

```luau
--!strict
local TweenService = game:GetService("TweenService")
local GuiService = game:GetService("GuiService")

local function transitionFov(camera: Camera, goal: number): () -> ()
    assert(goal >= 40 and goal <= 100)
    if GuiService.ReducedMotionEnabled then
        camera.FieldOfView = goal
        return function() end
    end
    local tween = TweenService:Create(
        camera,
        TweenInfo.new(0.25, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
        {FieldOfView = goal}
    )
    tween:Play()
    return function()
        tween:Cancel()
        tween:Destroy()
    end
end

return transitionFov
```

### 4. Compose shake without drift

- Compute a fresh base camera transform each frame, then apply a transient offset.
- NEVER repeatedly multiply shake onto the previous shaken camera transform.
- Keep translation and angular intensity separate and clamp combined effects.
- Use a local seed or phase to make shake reproducible when testing.
- Fade both the beginning and end of strong effects.
- Disable or reduce shake for reduced-motion users and comfort-sensitive modes.

This pure function produces a decaying angular offset from elapsed time.
Apply the returned CFrame to an unshaken base transform in the camera owner.

```luau
--!strict
local function shakeOffset(elapsed: number, duration: number, degrees: number): CFrame
    if duration <= 0 or elapsed < 0 or elapsed >= duration then
        return CFrame.identity
    end
    local progress = elapsed / duration
    local envelope = math.sin(progress * math.pi) * (1 - progress)
    local amplitude = math.rad(math.clamp(degrees, 0, 3)) * envelope
    local pitch = math.noise(elapsed * 18, 0, 3) * amplitude
    local yaw = math.noise(0, elapsed * 18, 7) * amplitude
    return CFrame.Angles(pitch, yaw, 0)
end

assert(shakeOffset(1, 1, 2) == CFrame.identity)
assert(shakeOffset(0, 0, 2) == CFrame.identity)
```

### 5. Verify transitions and recovery

- Start and cancel a cutscene repeatedly without duplicating render bindings.
- Respawn, destroy the target, replace CurrentCamera, and close the owning interface.
- Compare smoothing at low and high frame rates.
- Test narrow corridors, moving platforms, and camera collision geometry.
- Confirm the default controller regains a valid subject after the effect ends.
- Check that reduced motion disables strong camera displacement and rotation.

## Common mistakes

- Setting CurrentCamera from a server Script; keep camera presentation client-side.
- Writing CFrame from two controllers; establish one camera owner and compose effects.
- Using a fixed lerp factor per frame; compute the factor from dt.
- Accumulating shake transforms; apply offsets to a fresh base transform.
- Forgetting cancellation; unbind render work and restore captured camera settings.

## Reference

- [Camera](https://create.roblox.com/docs/reference/engine/classes/Camera).
- [RunService render bindings](https://create.roblox.com/docs/reference/engine/classes/RunService).
- [GuiService accessibility preferences](https://create.roblox.com/docs/reference/engine/classes/GuiService).
