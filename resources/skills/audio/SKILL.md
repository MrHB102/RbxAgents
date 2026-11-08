---
name: audio
description: >
  Builds Roblox modular audio graphs, spatial emitters, music transitions, and bounded playback lifecycles. Use when asked to "add spatial sound", "fix silent audio", "crossfade music", "pool sound effects", "set audio attenuation", or "migrate a SoundService setup".
---

# Roblox Audio

## When to use

- Adding music, UI feedback, ambience, and spatial world audio.
- Diagnosing asset permissions, loading, routing, and silent emitters.
- Managing crossfades, gain categories, and simultaneous voice limits.
- Migrating an existing Sound-based system to modular audio when justified.

## When NOT to use

- Building a rhythm game's progression; that belongs to game-design.
- Animating an effect that accompanies audio; that belongs to animation-vfx.
- Localizing voice scripts and subtitles; that belongs to localization.

## Core instructions

### 1. Choose routing and ownership

1. Define whether a sound is local UI, non-positional music, or spatial world audio.
2. Prefer AudioPlayer, Wire, AudioEmitter, AudioListener, and AudioDeviceOutput for new graphs.
3. Existing Sound and SoundGroup systems remain an integration concern; do not rewrite them without need.
4. ALWAYS verify asset permissions in the published experience, not just the creator's Studio session.
5. NEVER accept arbitrary client audio IDs for server-wide playback.
6. Use approved asset mappings and explicit playback concurrency budgets.
7. Keep user volume categories and mute preferences separate from gameplay state.
8. Provide non-audio cues for essential information.

### 2. Create a minimal 2D graph

- A source needs a connected output path; an AudioPlayer alone is not an audible system.
- Use current AudioContent or Asset properties rather than deprecated AssetId examples.
- Set gain conservatively to avoid clipping when several sounds overlap.
- Track graph ownership so stopping a feature destroys its wires and nodes.
- NEVER create an additional device output per repeated one-shot when a shared output suffices.
- Handle loading failure and readiness deadlines without blocking the whole interface.

This client factory creates a self-owned music graph under SoundService.
Pass an approved audio asset URI with permissions for the experience.
The returned cleanup function releases all graph nodes together.

```luau
--!strict
local SoundService = game:GetService("SoundService")

local function createMusic(assetUri: string): (AudioPlayer, () -> ())
    local folder = Instance.new("Folder")
    folder.Name = "OwnedMusicGraph"
    folder.Parent = SoundService

    local player = Instance.new("AudioPlayer")
    player.AudioContent = Content.fromUri(assetUri)
    player.Looping = true
    player.Volume = 0.3
    player.Parent = folder

    local output = Instance.new("AudioDeviceOutput")
    output.Parent = folder
    local wire = Instance.new("Wire")
    wire.SourceInstance = player
    wire.TargetInstance = output
    wire.Parent = folder

    local disposed = false
    return player, function()
        if disposed then return end
        disposed = true
        player:Stop()
        folder:Destroy()
    end
end

return createMusic
```

### 3. Configure spatial emission and listening

- Parent AudioEmitter to the intended world part or attachment.
- Connect the AudioPlayer output to the emitter with a Wire.
- Ensure the experience provides a listener-to-device route through its audio configuration.
- In Studio, select SoundService and set ListenerLocation to Camera or Character when that authoring option is available.
- That supported automatic mode supplies a listener and output; do not add a second manual listener route.
- If configuring manually, parent an AudioListener to CurrentCamera and connect it by Wire to one AudioDeviceOutput.
- NEVER assume a SoundService legacy rolloff property changes modular emitter attenuation.
- Set a bounded distance attenuation curve appropriate for the gameplay cue.
- Avoid duplicate listeners or outputs that double perceived volume.
- Coordinate AudioInteractionGroup when isolating different audio audiences.

This helper attaches a spatial source to a supplied part.
It assumes the experience's listener and output routing are already configured.
Use one shared listener path per intended local listening perspective.

```luau
--!strict
local function attachSpatial(part: BasePart, assetUri: string): (AudioPlayer, () -> ())
    local attachment = Instance.new("Attachment")
    attachment.Name = "OwnedAudioAttachment"
    attachment.Parent = part
    local emitter = Instance.new("AudioEmitter")
    emitter:SetDistanceAttenuation({[0] = 1, [15] = 1, [80] = 0})
    emitter.Parent = attachment
    local player = Instance.new("AudioPlayer")
    player.AudioContent = Content.fromUri(assetUri)
    player.Volume = 0.5
    player.Parent = attachment
    local wire = Instance.new("Wire")
    wire.SourceInstance = player
    wire.TargetInstance = emitter
    wire.Parent = attachment

    return player, function()
        player:Stop()
        attachment:Destroy()
    end
end

return attachSpatial
```

### 4. Mix transitions without runaway voices

- Use shared category gain stages when the graph already supports them.
- Cap concurrent one-shots per category and define which voice to drop or replace.
- Pool only measured high-churn playback and reset position, gain, content, and connections.
- NEVER preload every audio asset in a large experience during the initial join.
- Preload only critical nearby or imminent cues and tolerate noncritical loading delays.
- Use a cancellation owner for music transitions and stop the outgoing source afterward.
- Keep ducking bounded so repeated events cannot leave music permanently attenuated.

This pure helper gives equal-power crossfade gains for two music sources.
Apply category and user gain after these factors, and cancel superseded transitions.

```luau
--!strict
local function crossfadeGains(progress: number): (number, number)
    local t = math.clamp(progress, 0, 1)
    return math.cos(t * math.pi / 2), math.sin(t * math.pi / 2)
end

local startA, startB = crossfadeGains(0)
local endA, endB = crossfadeGains(1)
assert(math.abs(startA - 1) < 0.0001 and startB == 0)
assert(math.abs(endA) < 0.0001 and math.abs(endB - 1) < 0.0001)

local a, b = crossfadeGains(0.5)
assert(math.abs(a * a + b * b - 1) < 0.0001)
```

### 5. Verify audibility and cleanup

- Test owned and group-owned asset permissions in a published staging place.
- Move through minimum, intermediate, and maximum attenuation distances.
- Test headphones, small speakers, mute settings, and many overlapping effects.
- Verify an unavailable asset does not leave a stalled gameplay flow.
- Open and close the owning feature repeatedly and inspect graph instance counts.
- Stop loops when their world owner disappears or streams out on the client.
- Check subtitles and visual equivalents for critical warnings.
- Measure memory and decode cost before increasing audio concurrency.

## Common mistakes

- Creating an AudioPlayer without an output path; inspect every Wire and destination.
- Using deprecated AssetId from an old sample; use AudioContent or the current Asset property.
- Hearing audio only in Studio; verify experience permissions for the published asset.
- Leaving outgoing music running at zero volume; stop and release it after the transition.
- Pooling unlimited voices; enforce a category cap and a clear replacement policy.

## Reference

- [Audio objects](https://create.roblox.com/docs/audio/objects).
- [AudioPlayer](https://create.roblox.com/docs/reference/engine/classes/AudioPlayer).
- [AudioEmitter](https://create.roblox.com/docs/reference/engine/classes/AudioEmitter).
