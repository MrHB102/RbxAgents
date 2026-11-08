---
name: game-design
description: >
  Converts a Roblox concept into a testable core loop, onboarding, progression, difficulty curve, and session structure. Use when asked to "design a game loop", "fix a boring first session", "balance progression", "plan difficulty", "prototype a game mechanic", or "improve the tutorial".
---

# Roblox Game Design

## When to use

- Turning a concept into a small playable vertical slice.
- Improving the first meaningful action and first successful loop.
- Balancing progression, challenge, resource sinks, and session pacing.
- Designing experiments that distinguish confusion from lack of interest.

## When NOT to use

- Implementing a complete service framework; that belongs to architecture.
- Configuring paid products; that belongs to monetization.
- Diagnosing acquisition channels and invitations; that belongs to growth-design.

## Core instructions

### 1. State the player promise and smallest loop

1. Describe who acts, what decision they make, what changes, and why they repeat.
2. ALWAYS separate the core activity from menus, shops, and secondary progression.
3. Define an observable first-session success condition before building supporting systems.
4. NEVER treat a feature list as a playable loop.
5. Prototype the smallest version that can test the main decision and feedback.
6. Identify device constraints, player count, and required social interaction early.
7. Make assumptions explicit and attach a playtest observation that could disprove each one.
8. Do not promise retention improvements from a mechanic without evidence.

### 2. Make progression legible and bounded

- Define reward sources, resource sinks, unlock cadence, and maximum supported progression.
- Use units and a small simulation to inspect time-to-unlock before tuning live prices.
- NEVER hide a grind spike behind an unexplained exponential formula.
- Keep gameplay calculations server-authoritative even if clients preview them.
- Design catch-up and returning-player paths alongside the long-term curve.
- Account for cooperative rewards, repeated failures, and skilled players moving faster.

This pure progression helper supports bounded multi-level gains.
It belongs in a shared calculation module; the server owns actual XP mutations.

```luau
--!strict
local MAX_LEVEL = 50
local function required(level: number): number
    return 100 + (level - 1) * 25
end

local function addXp(level: number, xp: number, gain: number): (number, number)
    assert(level >= 1 and level <= MAX_LEVEL and level % 1 == 0)
    assert(xp >= 0 and xp < math.huge)
    assert(gain >= 0 and gain < math.huge)
    xp += gain
    while level < MAX_LEVEL and xp >= required(level) do
        xp -= required(level)
        level += 1
    end
    if level == MAX_LEVEL then xp = 0 end
    return level, xp
end

local level, xp = addXp(1, 0, 225)
assert(level == 3 and xp == 0)
assert(select(1, addXp(49, 0, 10_000)) == 50)
```

### 3. Structure sessions around readable goals

- Give players an actionable goal before introducing several currencies and menus.
- Teach through a safe action, clear feedback, and a chance to repeat independently.
- NEVER block progress on a social action when the experience can place a player alone.
- Define round entry, active play, results, and restart behavior.
- Include late joiners, disconnects, empty servers, and failed objectives in the design.
- Let players leave at reasonable stopping points without losing already-earned progress.
- Tie tutorial completion to server-observed success rather than a client button click.

This server round skeleton publishes a simple phase contract.
The phase transition owns deadlines; feature services consume the state.
Replace durations through measured playtests rather than treating these values as universal.

```luau
--!strict
local Workspace = game:GetService("Workspace")
type Phase = "Intermission" | "Playing" | "Results"
local duration: {[Phase]: number} = {Intermission = 15, Playing = 120, Results = 10}
local nextPhase: {[Phase]: Phase} = {
    Intermission = "Playing", Playing = "Results", Results = "Intermission",
}

local phase: Phase = "Intermission"
local deadline = Workspace:GetServerTimeNow() + duration[phase]
Workspace:SetAttribute("RoundPhase", phase)
Workspace:SetAttribute("RoundDeadline", deadline)

local function advance(now: number)
    if now < deadline then return end
    phase = nextPhase[phase]
    deadline = now + duration[phase]
    Workspace:SetAttribute("RoundPhase", phase)
    Workspace:SetAttribute("RoundDeadline", deadline)
end

return advance
```

### 4. Tune challenge through observable causes

- Separate mechanical skill, knowledge, resource availability, and random variance.
- Change one meaningful difficulty driver at a time during a small test.
- Use readable telegraphs and recovery opportunities before simply increasing enemy health.
- Track where failures happen and whether the player understands why.
- NEVER assume every short session means boredom; crashes, confusion, and social context differ.
- Include intended mastery paths and accessibility options in the design.

This pure calculation estimates deterministic upgrade pacing.
It exposes the assumptions instead of presenting a predicted outcome as a measured fact.

```luau
--!strict
local function loopsToAfford(cost: number, reward: number, starting: number): number
    assert(cost >= 0 and cost < math.huge)
    assert(reward > 0 and reward < math.huge)
    assert(starting >= 0 and starting < math.huge)
    return math.max(0, math.ceil((cost - starting) / reward))
end

local rewardPerLoop = 20
local loopSeconds = 45
local loops = loopsToAfford(150, rewardPerLoop, 30)
local estimatedSeconds = loops * loopSeconds

assert(loops == 6 and estimatedSeconds == 270)
assert(loopsToAfford(50, 10, 100) == 0)
print("Estimated upgrade time", estimatedSeconds)
```

### 5. Validate before expanding scope

- Observe fresh players without explaining every control in advance.
- Record time to first action, first success, first independent repeat, and first failure.
- Ask players to describe their next goal in their own words.
- Treat retention and conversion as cohort metrics with clear definitions and windows.
- Keep a stable baseline when comparing tutorial or progression variants.
- A design change MUST define its primary outcome and guardrails before rollout.
- Deliver the revised loop, tuning values, implementation boundaries, and test evidence.
- Defer secondary systems that do not help answer the current design question.

## Common mistakes

- Building a shop before the core action is enjoyable; test the loop first.
- Adding instructions instead of fixing confusing feedback; observe the point of confusion.
- Balancing around one expert tester; include new players and slower devices.
- Increasing grind to extend sessions; inspect whether the activity remains satisfying.
- Calling a small sample a proven uplift; document the sample and uncertainty.

## Reference

- [Design games on Roblox](https://create.roblox.com/docs/production/game-design).
- [Analytics overview](https://create.roblox.com/docs/production/analytics).
- [Funnel events](https://create.roblox.com/docs/production/analytics/funnel-events).
