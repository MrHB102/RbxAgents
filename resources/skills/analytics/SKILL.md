---
name: analytics
description: >
  Implements Roblox server telemetry, economy events, funnels, experiment attribution, and actionable metric definitions. Use when asked to "track onboarding", "log an economy event", "debug missing analytics", "build a funnel", "measure an A/B test", or "reduce telemetry spam".
---

# Roblox Analytics and Telemetry

## When to use

- Instrumenting meaningful gameplay, onboarding, shop, and economy outcomes.
- Defining KPI numerators, denominators, cohorts, and observation windows.
- Debugging missing, duplicated, or high-cardinality events.
- Evaluating a controlled design experiment with explicit guardrails.

## When NOT to use

- Persisting authoritative rewards; that belongs to data or monetization.
- Choosing the core gameplay loop; that belongs to game-design.
- Sending general backend webhooks; that belongs to cloud.

## Core instructions

### 1. Define an event contract

1. State the question, event trigger, owner, schema, expected rate, and dashboard interpretation.
2. ALWAYS log server-observed outcomes for valuable actions.
3. NEVER accept arbitrary event names or numeric values from a client remote.
4. Keep event names stable and move bounded variation into approved custom fields.
5. Distinguish attempted, rejected, completed, and durably saved actions.
6. Do not put usernames, raw chat, credentials, or private payloads into custom fields.
7. Check current event quotas and rate limits before instrumenting high-frequency actions.
8. Analytics MUST NOT be a dependency for completing a legitimate gameplay transaction.

### 2. Track onboarding at real milestones

- Use LogOnboardingFunnelStepEvent for one-time onboarding milestones.
- Define a stable increasing step order that matches actual player actions.
- NEVER log tutorial completion merely because a tutorial panel was opened.
- Avoid changing a funnel's meaning in place; version the contract when necessary.
- Published server execution is required for AnalyticsService event delivery.
- Studio tests can verify invocation logic but cannot prove dashboard ingestion.

This server helper allowlists onboarding steps and guards obvious local duplicates.
Call it after the authoritative action succeeds.
Local deduplication is not durable player progress and does not replace the saved tutorial state.

```luau
--!strict
local AnalyticsService = game:GetService("AnalyticsService")
local Players = game:GetService("Players")
local names = {"Joined", "FirstAction", "FirstReward"}
local highest: {[Player]: number} = {}

local function onboarding(player: Player, step: number): boolean
    if step % 1 ~= 0 or step < 1 or step > #names then return false end
    if step <= (highest[player] or 0) then return false end
    local ok = pcall(function()
        AnalyticsService:LogOnboardingFunnelStepEvent(player, step, names[step])
    end)
    if ok then highest[player] = step end
    return ok
end

Players.PlayerRemoving:Connect(function(player)
    highest[player] = nil
end)

return onboarding
```

### 3. Use a stable session ID for recurring funnels

- Generate one funnel session ID per checkout, crafting sequence, or comparable repeated journey.
- Reuse that ID across its steps; do not generate a different GUID at every event.
- NEVER put a GUID or UserId in the event name itself.
- Explain whether intermediate steps can be skipped and how the platform interprets that.
- Keep custom-field values bounded and meaningful for segmentation.
- Track abandoned flows through analysis rather than synthesizing success events on departure.

This server factory provides one recurring funnel instance.
The shop service owns its lifetime and calls each step after its corresponding action.

```luau
--!strict
local AnalyticsService = game:GetService("AnalyticsService")
local HttpService = game:GetService("HttpService")

local function newCheckout(player: Player)
    local sessionId = HttpService:GenerateGUID(false)
    local highest = 0
    local steps = {"Opened", "ViewedItem", "PurchaseConfirmed"}
    return function(step: number): boolean
        if step % 1 ~= 0 or step <= highest or step > #steps then return false end
        local ok = pcall(function()
            AnalyticsService:LogFunnelStepEvent(
                player, "ShopCheckout_v1", sessionId, step, steps[step]
            )
        end)
        if ok then highest = step end
        return ok
    end
end

return newCheckout
```

### 4. Distinguish economy and custom events

- Economy amounts are positive; flow type identifies source or sink.
- Log the resulting authoritative balance after a successful mutation.
- Use Enum.AnalyticsEconomyTransactionType values through their `.Name` string when appropriate.
- NEVER log a purchase attempt as a successful currency sink.
- Use LogCustomEvent for bounded gameplay metrics that are not economy flows or funnel steps.
- Record experiment variant in a stable approved custom field or analysis dimension.
- Keep assignment deterministic or persisted; NEVER reroll a player's variant every join.
- Explain that analytics delivery and a DataStore commit do not form an atomic transaction.

This server helper records a completed, server-owned gameplay reward.
Call it once from the successful mutation path with the actual resulting balance.
The caller's reward operation handles idempotency; analytics is observational.

```luau
--!strict
local AnalyticsService = game:GetService("AnalyticsService")

local function recordReward(player: Player, amount: number, balance: number): boolean
    assert(amount > 0 and amount < math.huge)
    assert(balance >= 0 and balance < math.huge)
    local ok = pcall(function()
        AnalyticsService:LogEconomyEvent(
            player,
            Enum.AnalyticsEconomyFlowType.Source,
            "Coins",
            amount,
            balance,
            Enum.AnalyticsEconomyTransactionType.Gameplay.Name,
            "QuestReward"
        )
        AnalyticsService:LogCustomEvent(player, "QuestCompleted", 1)
    end)
    return ok
end

return recordReward
```

### 5. Validate collection and interpretation

- Test call counts with a fake logger before using a published staging experience.
- Verify event names, amount signs, balances, session IDs, and step ordering.
- Use Creator Hub event inspection to confirm actual ingestion where available.
- Do not retry an entire group of events after a partial failure without considering duplicates.
- Define D1/D7 retention windows, timezone, and eligible cohort before comparing rates.
- Separate unique players from event counts and sessions from people.
- Report sample size and uncertainty; avoid repeatedly stopping a test when a metric briefly rises.
- Guard against instrumentation changes masquerading as gameplay improvements.
- Sample high-volume diagnostics through a documented policy rather than dropping arbitrary outcomes.

## Common mistakes

- Logging from LocalScripts; send validated gameplay intent and log observed outcomes on the server.
- Generating a new funnel GUID for each step; reuse one ID for the whole repeated journey.
- Using item IDs in event names; use stable names and bounded dimensions.
- Logging before a mutation succeeds; record the committed gameplay outcome and resulting balance.
- Calling a dashboard change causal proof; verify cohorts and keep a controlled comparison.

## Reference

- [AnalyticsService](https://create.roblox.com/docs/reference/engine/classes/AnalyticsService).
- [Funnel events](https://create.roblox.com/docs/production/analytics/funnel-events).
- [Event types and limitations](https://create.roblox.com/docs/production/analytics/event-types).
