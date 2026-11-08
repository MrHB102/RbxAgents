---
name: player-psychology
description: >
  Designs understandable Roblox goals, fair rewards, social motivation, and respectful return incentives. Use when asked to "improve player motivation", "fix frustrating rewards", "design a daily bonus", "reduce tutorial anxiety", "review FOMO mechanics", or "understand why players quit".
---

# Roblox Player Motivation and Psychology

## When to use

- Diagnosing frustration, confusion, weak goals, and loss of perceived progress.
- Designing return rewards, mastery feedback, and cooperative incentives.
- Reviewing randomness, streaks, scarcity, and social pressure.
- Turning player feedback into testable design hypotheses.

## When NOT to use

- Selecting marketing acquisition channels; that belongs to growth-design.
- Implementing a Robux purchase flow; that belongs to monetization.
- Claiming clinical or universal psychological effects from gameplay metrics.

## Core instructions

### 1. Diagnose a concrete player experience

1. Identify the action, expected outcome, actual outcome, and player's available information.
2. ALWAYS separate observations, player statements, and inferred motivations.
3. NEVER label every departure as impatience, low skill, or a retention failure.
4. Review competence, choice, social belonging, predictability, and recovery as hypotheses.
5. Use fresh-player observation and direct feedback alongside analytics.
6. Explain consequences before irreversible choices, expensive upgrades, or resource consumption.
7. Make progress and failure understandable through immediate, proportionate feedback.
8. Avoid claims that a reward schedule guarantees engagement or retention.

### 2. Make goals and progress visible

- Give a player a small achievable objective and an understandable next step.
- Recognize mastery and experimentation, not only time spent or purchases.
- NEVER fake other players' activity or social approval to pressure an action.
- Separate cosmetic celebration from the authoritative reward transaction.
- Keep essential progression available to players who do not join a group or invite friends.
- Test whether the player can explain why a reward was earned.

This server helper exposes a bounded objective progress view through attributes.
The authoritative objective owner supplies the numbers after validating the action.
Attributes provide presentation state, not durable storage.

```luau
--!strict
local function publishObjective(player: Player, completed: number, target: number)
    assert(target >= 1 and target % 1 == 0 and target <= 1_000)
    assert(completed >= 0 and completed % 1 == 0)
    local shown = math.clamp(completed, 0, target)
    player:SetAttribute("ObjectiveCompleted", shown)
    player:SetAttribute("ObjectiveTarget", target)
    player:SetAttribute("ObjectiveReady", shown == target)
end

local Players = game:GetService("Players")
local function initialize(player: Player)
    publishObjective(player, 0, 5)
end

Players.PlayerAdded:Connect(initialize)
for _, player in Players:GetPlayers() do initialize(player) end
```

### 3. Use return incentives without punitive traps

- State claim windows and reset rules clearly in the interface.
- Prefer preserving earned progress over deleting it after an absence.
- NEVER show a fake countdown that secretly restarts to manufacture scarcity.
- Provide a clear stopping point and avoid disguising ordinary progress as an emergency.
- Compute eligibility from server time and durable claim history.
- A daily reward claim MUST be idempotent and serialized with the player's profile mutation.
- Time calculations alone do not implement a safe durable claim.

This pure eligibility rule uses rolling elapsed time, not a user's local calendar day.
The persistence owner must atomically save both the reward and the new claim timestamp.
If a calendar-based design is required, specify its timezone and reset semantics separately.

```luau
--!strict
local COOLDOWN = 24 * 60 * 60

local function secondsUntilClaim(lastClaim: number?, now: number): number
    assert(now >= 0 and now < math.huge)
    if lastClaim == nil then return 0 end
    assert(lastClaim >= 0 and lastClaim < math.huge)
    return math.max(0, lastClaim + COOLDOWN - now)
end

assert(secondsUntilClaim(nil, 100) == 0)
assert(secondsUntilClaim(1_000, 1_000) == COOLDOWN)
assert(secondsUntilClaim(1_000, 1_000 + COOLDOWN) == 0)

local authoritativeNow = os.time()
print("Current claim evaluation timestamp", authoritativeNow)
```

### 4. Make random rewards explainable

- Define the complete outcome table and how any guarantees change probabilities.
- Keep paid randomness subject to current Roblox policy and per-player eligibility.
- NEVER change paid odds secretly based on spending behavior.
- Log server reward outcomes for integrity and balancing without exposing private player data.
- Persist guarantee counters with the reward in one authoritative mutation.
- Do not treat a client animation, spinner, or reveal screen as the reward generator.
- For deterministic tests, inject the random draw instead of hoping a random sample covers a case.

This free gameplay reward example guarantees a rare outcome after bounded misses.
Its caller persists the updated miss counter and granted item together.
The free-reward example is not a substitute for paid-random-item policy requirements.

```luau
--!strict
local function chooseReward(misses: number, roll: number): (string, number)
    assert(misses >= 0 and misses <= 9 and misses % 1 == 0)
    assert(roll >= 0 and roll < 1)
    if misses == 9 or roll < 0.1 then
        return "Rare", 0
    end
    return "Common", misses + 1
end

local reward, nextMisses = chooseReward(9, 0.99)
assert(reward == "Rare" and nextMisses == 0)
assert(select(1, chooseReward(0, 0.05)) == "Rare")
assert(select(1, chooseReward(0, 0.5)) == "Common")
```

### 5. Evaluate player benefit and unintended pressure

- Check whether social mechanics help cooperation or create exclusion and harassment incentives.
- Offer recovery after failure without requiring an immediate purchase.
- Reward returning players without making absent players feel their prior effort was erased.
- Use honest scarcity tied to a real schedule and disclose what happens after an event ends.
- Keep a control cohort when testing rewards or onboarding changes.
- Measure complaints, failure loops, and long-session fatigue alongside engagement.
- Distinguish voluntary repeat play from repeated attempts caused by unclear UI or failed saves.
- Report uncertain interpretations as hypotheses with a next observation to collect.

## Common mistakes

- Diagnosing intent from one metric; combine behavior, context, and player feedback.
- Resetting all progress after a missed day; preserve earned value and state the claim rule.
- Using fake scarcity; tie countdowns to an actual server schedule.
- Keeping guarantee counters only on the client; persist them with the reward mutation.
- Testing only session length; include satisfaction and frustration guardrails.

## Reference

- [Roblox analytics](https://create.roblox.com/docs/production/analytics).
- [Paid random items](https://create.roblox.com/docs/production/monetization/paid-random-items).
- [Accessibility](https://create.roblox.com/docs/production/publishing/accessibility).
