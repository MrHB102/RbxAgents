## Full Reference


> **Code in this reference is illustrative. Adapt to your game and verify in Studio before production use.**

## 1. AnalyticsService API

All methods are called on the server via `game:GetService("AnalyticsService")`.

### Custom Events

Track any game-specific metric. Two forms: counter (no value) and valued.

```luau
local AnalyticsService = game:GetService("AnalyticsService")

-- Counter: tracks occurrence count + unique users automatically
AnalyticsService:LogCustomEvent(player, "MissionStarted")

-- With value: enables sum/mean/min/max aggregations
AnalyticsService:LogCustomEvent(player, "MissionCompletedDuration", 120)

-- With custom fields (up to 3): enables filtering/breakdown on dashboard
AnalyticsService:LogCustomEvent(player, "EnemyDefeated", 1, {
    [Enum.AnalyticsCustomFieldKeys.CustomField01.Name] = "Enemy - Zombie",
    [Enum.AnalyticsCustomFieldKeys.CustomField02.Name] = "Weapon - Sword",
    [Enum.AnalyticsCustomFieldKeys.CustomField03.Name] = "Wave - 5",
})
```

### Economy Events

Track virtual currency flow. Enables revenue analysis, inflation detection, economy health.

Three stages stay separate: the **attempted** transaction, the **committed**
result (what the authoritative mutation actually wrote), and the **reported**
balance (what the event carries). The mutation runs first and RETURNS the
committed balance; logging consumes that returned value unchanged. Never
recompute the reported balance from `leaderstats`: it is a UI replica that
already shows the committed grant, so adding the amount again reports a wrong
balance (100 + 50 commits 150; a recomputed sample logs 200). An idempotent
purchase does not make the telemetry exactly-once, so failed or refunded
attempts log nothing.

```luau
-- The authoritative mutation commits the durable balance and RETURNS it.
local function grantCoins(player, amount)
    local committed = CurrencyStore:Grant(player, "Coins", amount) -- durable write
    player.leaderstats.Coins.Value = committed -- UI replica; never the source of truth
    return committed
end

-- Player EARNED currency (source): log AFTER the grant commits
local committedBalance = grantCoins(player, 50)
AnalyticsService:LogEconomyEvent(
    player,
    Enum.AnalyticsEconomyFlowType.Source, -- Source = earned/gained
    "Coins",                               -- Currency name (max 10 resource types)
    50,                                    -- Amount
    committedBalance,                      -- Balance AFTER transaction (returned by the grant, unchanged)
    Enum.AnalyticsEconomyTransactionType.Gameplay.Name, -- Transaction type
    "QuestReward_Daily",                   -- Item SKU (what triggered it)
    {
        [Enum.AnalyticsCustomFieldKeys.CustomField01.Name] = "Quest - 001",
    }
)

-- Player SPENT currency (sink): the authoritative mutation returns the
-- committed balance; logging consumes it unchanged.
local function spendCoins(player, amount)
    local committed = CurrencyStore:Spend(player, "Coins", amount) -- durable write
    player.leaderstats.Coins.Value = committed -- UI replica only
    return committed
end

local committedBalance = spendCoins(player, 200)
AnalyticsService:LogEconomyEvent(
    player,
    Enum.AnalyticsEconomyFlowType.Sink, -- Sink = spent/consumed
    "Coins",
    200,
    committedBalance, -- Balance AFTER transaction (returned by the spend, unchanged)
    Enum.AnalyticsEconomyTransactionType.Shop.Name,
    "SpeedBoost_30min"
)
```

Transaction types: `IAP`, `Shop`, `Gameplay`, `ContextualPurchase`, `TimedReward`, `Onboarding`.

### Funnel Events

Track step-by-step progression through a flow. Max 10 funnels, 100 steps each.

```luau
-- Onboarding funnel: track where players drop off
AnalyticsService:LogOnboardingFunnelStepEvent(player, 1, "WelcomeScreen")
-- ... player progresses ...
AnalyticsService:LogOnboardingFunnelStepEvent(player, 2, "PickCharacter")
-- ... player progresses ...
AnalyticsService:LogOnboardingFunnelStepEvent(player, 3, "FirstBattle")
-- ... player progresses ...
AnalyticsService:LogOnboardingFunnelStepEvent(player, 4, "CompleteTutorial")

-- Recurring shop funnel: keep one ID for this checkout attempt
local HttpService = game:GetService("HttpService")
local checkoutSessionId = HttpService:GenerateGUID(false)
AnalyticsService:LogFunnelStepEvent(player, "ShopPurchase", checkoutSessionId, 1, "OpenedShop")
AnalyticsService:LogFunnelStepEvent(player, "ShopPurchase", checkoutSessionId, 2, "ViewedItem")
AnalyticsService:LogFunnelStepEvent(player, "ShopPurchase", checkoutSessionId, 3, "ClickedBuy")
AnalyticsService:LogFunnelStepEvent(player, "ShopPurchase", checkoutSessionId, 4, "ConfirmedPurchase")
```

Use the same session ID for every step of one recurring funnel attempt. If a
step is skipped, Analytics treats the intermediate step as completed.

---

## 2. Rate Limits and Batching

| Constraint | Limit |
|-----------|-------|
| Total AnalyticsService calls/minute | 120 + (20 × CCU) |
| Custom event names | 100 |
| Economy resource types | 10 |
| Funnels | 10 |
| Steps per funnel | 100 |
| Custom fields per event | 3 |
| Unique values per custom field | Unlimited, but after 8,000 **combined** values across all custom fields they are grouped as "Other" |

### Batching Strategy

For high-frequency events such as kills or pickups, aggregate counters in the
project's canonical analytics owner and flush on its existing scheduler.
Preserve failed sends for a later retry; do not clear the whole batch after a
partial failure. Do not hide a permanent task loop inside a reference module's
top-level `require`; startup, player cleanup, and shutdown need an explicit
owner in the consuming project.

---

## 3. Event Taxonomy (Recommended)

Use consistent naming. Custom fields for breakdown, not separate event names.

### DO: Use custom fields for variants

```luau
-- ONE event, broken down by weapon type via custom field
AnalyticsService:LogCustomEvent(player, "EnemyKill", 1, {
    [Enum.AnalyticsCustomFieldKeys.CustomField01.Name] = tostring(weaponType),
    [Enum.AnalyticsCustomFieldKeys.CustomField02.Name] = tostring(enemyType),
})
```

### DON'T: Create separate events per variant

```luau
-- BAD: burns through your 100 event limit fast
AnalyticsService:LogCustomEvent(player, "EnemyKill_Sword")
AnalyticsService:LogCustomEvent(player, "EnemyKill_Bow")
AnalyticsService:LogCustomEvent(player, "EnemyKill_Magic")
```

### Common Event Taxonomy

**Retention signals:**
- `SessionStart` - counter, fire on PlayerAdded
- `SessionDuration` - value (seconds), fire on PlayerRemoving
- `DayNReturn` - counter with custom field for day number (Day1, Day7, Day30)

**Engagement:**
- `FeatureUsed` - custom field 1 = feature name
- `QuestCompleted` - custom field 1 = quest ID
- `LevelReached` - value = level number

**Monetization funnel:**
- Funnel "Purchase": OpenedShop → ViewedItem → ClickedBuy → Confirmed → Granted
- Economy source: IAP, QuestReward, DailyLogin, Trade
- Economy sink: ShopPurchase, Upgrade, Trade

**Progression:**
- Funnel "Onboarding": each tutorial step
- Funnel "BossAttempt": Started → Phase1 → Phase2 → Defeated

---

## 4. Validation and Debugging

### Real-time event validation

1. Navigate to Creator Hub → Analytics → Custom/Economy/Funnel
2. Click "View Events" at the top
3. Events appear in near real-time (seconds, not the 24-hour dashboard delay)
4. Refresh to see new events

### Common mistakes

- Logging on attempt instead of success (inflates metrics)
- Logging from client (exploiters can spam fake events)
- Exceeding rate limits silently (events get dropped, no error)
- Using too many unique event names (100 limit, then new ones are ignored)
- Firing funnel steps out of order (skipped intermediate steps are automatically back-filled as completed, so the visualization still works, but the data may not reflect the actual player journey)
- Not logging economy balance (makes inflation analysis impossible)

---

## 5. Creator Rewards and analytics

Creator Rewards is not an `AnalyticsService` event and should not be reconstructed from client telemetry. The platform determines qualifying users, attribution, and reward amounts. Use server-side analytics to measure the product signals you control:

- session duration and the 10-minute engagement milestone;
- onboarding and first-session completion;
- referral or share-link landing flows when your product exposes them;
- retention and return behavior;
- economy sources and sinks separately from platform rewards.

Use Creator Dashboard as the authority for Creator Rewards eligibility, rewarded active spenders, signups, reactivations, and estimated payout. Do not label a local event as "Creator Reward Granted" or promise a Robux amount based on it.

---

## 6. Economy Health Signals (Decision Layer)

**Instrument before you need it.** Complex-economy games fail without telemetry: when the economy breaks (inflation, sink collapse, whale concentration) the diagnosis is only as good as the events you started logging months earlier. Log economy events from day one, not when something goes wrong. You cannot backfill history.

### Which events to log for a complex economy

For every currency (max 10 resource types), log the full loop:

- **Sources (earned):** quest rewards, daily login, gameplay drops, trades in, IAP top-ups. Use distinct SKUs so you know *which* source inflates ("QuestReward_Daily" vs "QuestReward_Event").
- **Sinks (spent):** shop purchases, upgrades, repairs, trade fees, consumables. Same SKU discipline: a missing sink is the classic hidden deflation/inflation culprit.
- **Balance AFTER transaction:** always pass `balanceAfterTransaction` so you can reconstruct balances over time and detect hoarding or loss. Take the value from what the authoritative mutation RETURNED when it committed; do not recompute it from the `leaderstats` UI replica or re-apply the amount to it.
- **Item/feature acquisition:** custom event "ItemUnlocked" with item ID field; lets you see which content drives spending.
- **Conversion funnel:** "Purchase" funnel (OpenedShop → ViewedItem → ClickedBuy → Confirmed → Granted) plus economy sink events. This links monetization health to the purchase funnel.

### Economy health signals

| Signal | Formula / source | Healthy | Problem |
|--------|------------------|---------|---------|
| **Sink/source ratio** | total sinks ÷ total sources per currency | near 1.0 over a period | ≪1 = inflation (currency piling up), ≫1 = deflation (players can't afford items) |
| **Inflation** | units per active player climbing over weeks | flat/stable | players earn faster than they can spend; prices need sinks or rebalancing |
| **Whale concentration** | share of revenue from top N% payers | diversified | >75% from top 5% = revenue fragility, exploit risk, and unrepresentative feedback |
| **Price elasticity** | purchases vs price changes (experiment or segmented A/B) | meaningful response | no response = either price too low (leaving money) or poor value communication |
| **Sink sufficiency** | active sinks per player per session | players use sinks | no sinks = hoarding, then massive inflation once a sink opens |
| **D1/D7 cohort cross-link** | retention by acquisition cohort vs spend | new cohorts monetize similarly | a cohort with low retention + high spend = one-time whales, not a healthy base |

### Diagnose with telemetry (workflow)

When the economy or retention breaks, run this before touching balance numbers:

1. **Check you have the events.** Is every currency tracked as source AND sink with SKUs? Do you have balance-after-transaction? Purchase funnel? If not, that absence is itself the finding; instrument first, then wait for data (24h dashboard lag; use "View Events" for real-time spot checks).
2. **Check logging correctness.** Logged AFTER success, not attempt? Server-side only? Is the reported balance the value the authoritative mutation returned at commit, not a recomputation from the `leaderstats` replica? If a sink was never logged (e.g. repair costs omitting tracking), apparent inflation may be a measurement gap.
3. **Read the health signals above.** Pick the narrowest broken ratio first: sink/source, then concentration, then cohort cross-links.
4. **Act on the smallest lever.** One balance change (sink price, source rate) at a time, with a hypothesis and a guardrail. Re-check the same signals after the change; the data loop is the point.

Telemetry tells you the economy is broken and whether a fix worked; it does not decide what to do. The user owns the design choice. Your job is to surface what the numbers mean and flag when the data is insufficient to decide.

**Source note.** Roblox documents `CurrencySources - CurrencySinks` as an economy-health metric and flags high ARPPU with low ARPDAU as revenue concentrated among fewer payers. The ratio and concentration thresholds in the table are starting points, not Roblox targets; compare them with your game's distributions.

---

## 7. Best Practices

- Log server-owned facts after confirmation; client UI hints remain untrusted.
- Economy events describe committed changes, not attempted purchases.
- Diagnostic events can record attempts, failures, and cancellations.
- Keep names stable and use fields for dimensions.
- Aggregate high-frequency events through the existing analytics owner.
- Track currency sources and sinks; instrument funnels before launch, since history cannot be backfilled.
- Test with "View Events" before relying on the delayed dashboard.

## 8. Per-player onboarding traces (first-session telemetry)

`AnalyticsService` funnels are aggregate counters. A per-player **onboarding trace** is
complementary: one small data-store record per player that preserves the ordered
sequence of a first session (join → milestones → first meaningful action), so you can
inspect individual journeys, not just aggregate drop-off. Traces record **what
happened, not why**: they are evidence of sequence and timing, never proof of player
intent, and never a substitute for playtesting or design judgment.

### Scope and eligibility

- **First session only.** Use an explicit first-visit marker or a successful
  new-profile result from the canonical profile owner. A failed profile read is not
  a new player. NEVER use "trace key not found" as the trigger: a deleted,
  failed, or never-saved trace is retention/save loss, not a new player, and re-tracing
  on that signal corrupts your new-player population.
- **Bounded duration.** Stop recording at first-session completion or at a 10–15 minute
  cap, whichever comes first. The trace exists to answer "what did a new player do
  first", not to log their whole career. Log join, spawn, tutorial steps, round
  entry/start, role, key actions, death, shop interaction, and leave as relevant.
  Completion, timeout, leave, and shutdown are distinct terminal reasons. Record
  the build/cohort context needed to avoid mixing incompatible onboarding versions.
- **One record per player.** On rejoin, do not overwrite or append: if the save
  succeeded the trace exists; if it failed, that session is lost by design. Handle
  overlapping sessions (same user on two servers) by writing from one owner only,
  idempotently — never double-write.

### Recording and saving

- Keep an **in-memory buffer** during the session. Write the data store **once**,
  idempotently, at completion, time cap, `PlayerRemoving`, or `BindToClose` — the same
  save boundaries as the profile store. `BindToClose` gives a 30-second best-effort
  window; a hard crash loses the trace. Accept that loss instead of adding live writes;
  optionally keep a small number of bounded mid-session checkpoints, each itself
  idempotent.
- **Key naming:** `trace_<UserId>` (or `<prefix>_<UserId>`), scoped like your other
  player keys so it stays inside your existing identity scheme.
- **Size:** keep the serialized payload far below the 4,194,304-character per-key limit
  (`HttpService:JSONEncode` measures serialized length). Enforce a bounded total:
  cap event count and serialized size. Preserve join/onboarding milestones; drop
  noisy repeats first and mark truncation or dropped-event counts so absence is
  not mistaken for inaction. Do not keep evicting the beginning of a first-session trace.

### What goes in a trace

- **Compact event codes + elapsed time.** Use a versioned schema: a version field plus
  a version→code dictionary kept with the project's schema docs, so old traces stay
  readable after renames. Numeric codes are optional, not mandatory — short stable
  strings are fine while they stay bounded.
- **Server events are trusted.** If the client reports UI steps (menus opened, buttons
  clicked), expose one remote carrying a **whitelist** of finite signal IDs, batched,
  with server-enforced size/count/rate caps. Never let a remote trigger data-store
  writes directly. Validate dense batch shape, event IDs, finite numbers, and
  cumulative limits; see `roblox-networking`. Server receipt time orders batches,
  not the original clicks: preserve within-batch order and label client elapsed
  times untrusted rather than pretending batched receipt times measure UI timing.
- **Device category** (e.g. phone/tablet/desktop) may be recorded as an optional,
  coarse, untrusted client hint for slicing only — never as authoritative platform
  attribution.
- **Population anchors:** record join and the server population at join, plus elapsed
  time to the **first meaningful action** — the first action your design defines as
  engagement, not merely spawning or loading.
- **Attempts, failures, and cancellations are trace-worthy** — a cancelled tutorial or
  a failed attempt IS the signal. **Economy inside a trace is restricted:** log only
  confirmed mutations and their receipts, matching the economy-event rules in §1;
  never log prompts or impressions as economy events.
- **Privacy:** no free text, chat content, usernames, or display names. The trace is
  user-linked data: keep it inside your RTBF coverage and inside any offline
  exports/copies of user data.

### Retention and deletion

Choose a short retention period for launch diagnosis (for example, 30 days is
operator guidance, not a platform requirement). Store capture time, define the
cleanup owner/schedule, and delete expired records and user-linked exports. Exclude
Studio and configured tester IDs; do not exclude genuine users based on client claims.

- Register an RTBF key template for the trace store (e.g. `trace_{UserId}`) via Data
  Stores Manager or the Configs API so automated right-to-be-forgotten processing
  covers traces. Up to 100 templates are allowed; the `{UserId}` token is
  case-sensitive and must appear in the key name or scope.
- If traces feed an offline export or analysis pipeline, deleting the in-game key is
  not enough: user-linked copies in exports must be included in the same deletion flow.

### Inspecting traces offline

The Cloud v2 entries API lists keys without values: `GET
/cloud/v2/universes/{universe_id}/data-stores/{data_store_id}/entries` (scope
`universe-datastores.objects:list`) returns `path`/`id` only — paginate with
`pageToken` (maxPageSize up to 256, default 10) and use the `id.startsWith(...)`
filter to page through `trace_` keys. Fetch each value with `GET
.../entries/{entry_id}` (scope `universe-datastores.objects:read`). Follow the
returned resource paths and actual scope representation; do not assume every
entry ID is just the key. Use `roblox-cloud` for least-privilege API keys and
request handling. Compute time-to-step distributions, inspect early leavers, and
segment by build and population at join to test empty-server bounce hypotheses.
Capped/completed traces do not establish total session duration. Missing saves
are lost observations, not successful sessions; report coverage before conclusions.

> Design choices in this section — first-visit eligibility, the 10–15 minute
> cap, buffer-then-save, whitelist size — are guidance from practice, not Roblox
> statements. The official facts (30-second `BindToClose` window, 4,194,304-character
> key limit, RTBF templates, Cloud v2 endpoints and scopes) are sourced in the skill's
> frontmatter and verified against current creator docs.

## Analysis and observability integrity

### Establish what the data can observe

- Record source generation time, collection health, history depth, cadence, missing intervals, and metric/schema version before diagnosis. A successful query is not a freshness check. Declare the useful age limit for the decision; warn, return unavailable, or use a verified fallback when it is exceeded.
- Inspect score distributions and baseline coverage before acting on trend rankings. Compare equivalent time-of-day windows when daily cycles can affect the signal. Recompute after method changes and keep conclusions provisional while coverage is inadequate.
- Define when a session or bounded trace becomes observable. Immediately after a release, finished-session samples can overrepresent short sessions while longer sessions remain active. Use a declared maturity window or censoring-aware method; report eligible joins, observed completions, still-active sessions, capped traces, and lost observations separately.
- Preserve the denominator. Continuation among players who completed a round describes a selected group; report all entrants, early eliminations, and exits before completion alongside it. Do not infer newcomer core-loop success from survivors alone.

### Match labels to events and metrics

- Distinguish exposure, attempt, success, skipping, and exit for optional tasks. Do not interpret unordered task completion as ordered funnel abandonment. Roblox funnels can complete skipped earlier steps automatically; reproduce the suspected interaction and inspect its event path before changing difficulty or rewards.
- Record the cause of an exit from active play separately from the state change: elimination, disconnect while alive, practice completion, and cleanup are different events. Version changed semantics and rebuild comparable cohorts before calling a movement a gameplay regression.
- Keep exact-day retention separate from any later observed return. State cohort eligibility, dates, timezone convention, follow-up window, and which saved history can identify the required return day. Do not label a later last-visit timestamp as D1 unless the records establish next-day return.
- Name proxies literally. Friend presence is social context, not proof of paid or organic acquisition; reference art ranked by concurrent players is a popularity sample, not measured creative click performance. Obtain the actual source or creative metric separately where available.

### Verify the collection-to-report path

- Audit client and server observations through collection, bounded storage, retrieval, and the report used for decisions. Inject a controlled diagnostic event and confirm its stored and displayed form. A clean server log cannot establish client health, and a collected counter omitted from the report cannot support an operational decision.
- When a telemetry replay is requested, list its captured channels, sampling resolution, truncation, final-flush behavior, and missing channels. Test capture through retrieval and viewer rendering. Treat the viewer as a reconstruction with known blind spots; do not infer intent or causal reasons for quitting from it.
- For custom concurrent experiments, log eligibility, assigned arm, and actual exposure separately. Test assignment stability, balance, nearby-ID correlation, and exact agreement with the analysis implementation across representative and boundary inputs. Do not assume an untested hash is random or that implementations in different languages agree. Use a validated statistical plan; no session count is a universal stopping rule.
