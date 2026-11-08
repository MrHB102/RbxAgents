---
name: animation-vfx
description: >
  Implements Roblox rig animation, tweens, particles, beams, trails, and effect lifecycles. Use when asked to "play an NPC animation", "fix animation replication", "add a particle burst", "build a beam effect", "tween a prop", or "clean up visual effects".
---

# Roblox Animation and VFX

## When to use

- Playing and blending animations on characters or non-humanoid rigs.
- Creating bounded particle, beam, trail, and tween effects.
- Debugging rig compatibility, ownership, priority, and replication.
- Synchronizing visual feedback with a validated gameplay event.

## When NOT to use

- Defining authoritative hit damage; that belongs to security or npc-ai.
- Animating Camera.CFrame and FOV; that belongs to camera.
- Setting global atmosphere and exposure; that belongs to lighting.

## Core instructions

### 1. Establish rig and authority

1. Identify rig type, joint names, animation ownership, and asset permissions.
2. ALWAYS load tracks through Animator:LoadAnimation.
3. NEVER use deprecated Humanoid:LoadAnimation or AnimationController:LoadAnimation proxies.
4. Ensure the Animator is created on the server when animation replication depends on it.
5. Player-character tracks and NPC tracks have different replication ownership requirements.
6. Use an AnimationController with an Animator for appropriate non-humanoid rigs.
7. Set priority, looping, fade time, and interruption rules explicitly.
8. Keep visual timing separate from server-authoritative damage and reward decisions.

### 2. Load and dispose tracks deliberately

- Reuse a loaded track for repeated playback on the same Animator when appropriate.
- Do not repeatedly load identical tracks on every button press.
- Connect marker signals before playing if the first marker may occur immediately.
- Marker callbacks drive local effects; NEVER trust a client marker as proof of a hit.
- Stop and destroy tracks when their rig or owning feature ends.
- Disconnect marker listeners along with the track lifecycle.

This server helper plays one non-looping NPC animation and exposes cleanup.
The asset ID must be an owned or permitted animation matching the NPC's rig.
The caller must call cleanup when removing the NPC or replacing the action.

```luau
--!strict
local function playNpcAnimation(npc: Model, animationId: string): () -> ()
    local humanoid = npc:FindFirstChildOfClass("Humanoid")
    assert(humanoid, "NPC requires a Humanoid")
    local animator = humanoid:FindFirstChildOfClass("Animator")
    if not animator then
        animator = Instance.new("Animator")
        animator.Parent = humanoid
    end

    local animation = Instance.new("Animation")
    animation.AnimationId = animationId
    local track = animator:LoadAnimation(animation)
    track.Priority = Enum.AnimationPriority.Action
    track.Looped = false
    local marker = track:GetMarkerReachedSignal("Impact"):Connect(function()
        print("Visual impact marker", npc.Name)
    end)
    track:Play(0.1)

    local disposed = false
    return function()
        if disposed then return end
        disposed = true
        marker:Disconnect()
        track:Stop(0.1)
        track:Destroy()
        animation:Destroy()
    end
end

return playNpcAnimation
```

### 3. Bound particle and geometry effects

- Prefer client rendering for disposable effects after a server-validated event.
- Use Emit for one-shot bursts rather than leaving an emitter enabled indefinitely.
- Budget particle lifetime, count, screen coverage, transparency overlap, and lights.
- Set Beam and Trail attachments explicitly and handle attachment destruction.
- NEVER create one replicated Part per visual particle without measured justification.
- Use Debris for noncritical cleanup and explicit ownership for critical pooled effects.
- A pooled effect MUST reset attachments, color, playback, enabled flags, and listeners.

This client effect clones a vetted ParticleEmitter template under an attachment.
Create `ReplicatedStorage.Effects.HitBurst` with an approved particle texture.
The emitter is disabled and only the requested bounded burst is emitted.

```luau
--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Debris = game:GetService("Debris")

local function burst(parent: BasePart, count: number)
    assert(count >= 1 and count <= 40 and count % 1 == 0)
    local template = ReplicatedStorage:WaitForChild("Effects"):WaitForChild("HitBurst")
    assert(template:IsA("ParticleEmitter"))
    local attachment = Instance.new("Attachment")
    attachment.Parent = parent
    local emitter = template:Clone()
    emitter.Enabled = false
    emitter.Parent = attachment
    emitter:Emit(count)
    Debris:AddItem(attachment, emitter.Lifetime.Max + 0.5)
end

return burst
```

### 4. Own tweens and competing transforms

- Tween only properties owned by the current feature.
- Cancel a conflicting tween before applying a new target to the same property.
- NEVER tween a physics assembly's CFrame while another controller applies simulation forces.
- Inspect PlaybackState when completion behavior depends on successful completion.
- Use dt or seekable time for continuously evaluated effects.
- Honor reduced motion for strong flashes, camera-like movement, and UI effects.
- Keep color and audio cues available when an effect is reduced or disabled.

This helper animates a cosmetic anchored part and returns an explicit cancellation path.
It does not transfer authority over a gameplay-moving platform.

```luau
--!strict
local TweenService = game:GetService("TweenService")

local function fadeDecoration(part: BasePart): () -> ()
    assert(part.Anchored, "Cosmetic tween expects an anchored part")
    local tween = TweenService:Create(
        part,
        TweenInfo.new(0.4, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
        {Transparency = 1}
    )
    local connection = tween.Completed:Connect(function(state)
        if state == Enum.PlaybackState.Completed then
            print("Decoration fade completed")
        end
    end)
    tween:Play()
    return function()
        connection:Disconnect()
        tween:Cancel()
        tween:Destroy()
    end
end

return fadeDecoration
```

### 5. Verify effect correctness

- Test with a server and two clients to distinguish local playback from replicated playback.
- Test private/group-owned asset permissions in a published staging experience.
- Interrupt an animation before its marker and confirm no delayed gameplay mutation occurs.
- Remove the rig or effect parent during playback and verify cleanup.
- Stress the maximum simultaneous effects on a slower device.
- Inspect animations at different character scales and supported rig variants.
- Check light sensitivity, motion comfort, and reduced-motion behavior.

## Common mistakes

- Loading a new track every time; cache by Animator and clean it up with the rig.
- Creating the Animator only on a client for shared NPC animation; create it server-side.
- Using marker events to award damage from the client; validate the hit on the server.
- Forgetting lifetime after a burst; remove the attachment after the longest particle expires.
- Tweens fighting physics; separate cosmetic visuals from the simulated assembly.

## Reference

- [Animator](https://create.roblox.com/docs/reference/engine/classes/Animator).
- [ParticleEmitter](https://create.roblox.com/docs/reference/engine/classes/ParticleEmitter).
- [TweenService](https://create.roblox.com/docs/reference/engine/classes/TweenService).
