---
name: growth-design
description: >
  Designs measurable Roblox discovery, invitations, referral attribution, shareable moments, and community growth loops. Use when asked to "improve discovery", "add friend invites", "design a referral system", "make shareable moments", "plan a community event", or "diagnose weak conversion from visits".
---

# Roblox Growth Design

## When to use

- Diagnosing the path from impressions to visits to successful play.
- Adding voluntary friend invitations and cooperative joining experiences.
- Designing shareable gameplay outcomes and community events.
- Measuring campaign attribution and referral conversion without trusting arbitrary launch data.

## When NOT to use

- Fixing the underlying core activity; that belongs to game-design.
- Configuring revenue products; that belongs to monetization.
- Claiming guaranteed ranking or undocumented recommendation-system behavior.

## Core instructions

### 1. Diagnose the constrained stage

1. Separate impression click-through, join success, first-session activation, return play, and invitations.
2. ALWAYS compare consistent cohorts, acquisition sources, device classes, and time windows.
3. NEVER buy more traffic before checking crashes, broken onboarding, and misleading packaging.
4. Match thumbnails and descriptions to the actual first playable experience.
5. Treat discovery mechanisms and platform eligibility as changing documented constraints.
6. Design one testable growth hypothesis at a time with a primary metric and guardrails.
7. Distinguish attributed joins from incremental growth caused by an experiment.
8. Keep campaign IDs bounded and avoid collecting unnecessary personal information.

### 2. Make invitations contextual and voluntary

- Offer an invite after a moment where playing with a friend has a clear benefit.
- Use SocialService platform prompts rather than imitating Roblox system dialogs.
- ALWAYS check CanSendGameInviteAsync before opening an invite prompt.
- NEVER prompt repeatedly on join or block the core experience behind an invitation.
- Handle eligibility failure, prompt dismissal, and unavailable platform support.
- Do not treat prompt closure or selected recipients as confirmed completed joins.

This client helper should be called only from an explicit invite button action.
It prevents overlapping prompt requests and returns a result to the interface.
The prompt's actual delivery and friend join remain platform-managed outcomes.
Call the returned module's Destroy function when removing this feature.

```luau
--!strict
local Players = game:GetService("Players")
local SocialService = game:GetService("SocialService")
local busy = false
local closed = SocialService.GameInvitePromptClosed:Connect(function(player)
    if player == Players.LocalPlayer then busy = false end
end)

local function invite(): boolean
    if busy then return false end
    busy = true
    local player = Players.LocalPlayer
    local ok, allowed = pcall(function()
        return SocialService:CanSendGameInviteAsync(player)
    end)
    if not ok or not allowed then
        busy = false
        return false
    end
    local prompted = pcall(function()
        SocialService:PromptGameInvite(player)
    end)
    if not prompted then busy = false end
    return prompted
end

return {invite = invite, Destroy = function() closed:Disconnect() end}
```

### 3. Treat attribution as untrusted metadata

- Use supported share-link and launch-data mechanisms from current documentation.
- Parse Player:GetJoinData on the server when join context is needed.
- NEVER accept launch data as proof of a purchase, referral eligibility, or authorization.
- Bound its size, validate its schema, and allowlist campaign identifiers.
- Signed campaign tokens still need expiry and replay handling if they can grant value.
- Keep attribution and reward authorization as separate contracts.

This server parser extracts a bounded campaign label and nothing more.
Unknown or malformed launch data maps to an unattributed join.
It does not grant a referral reward.

```luau
--!strict
local HttpService = game:GetService("HttpService")
local campaigns: {[string]: boolean} = {AutumnEvent = true, CreatorSpotlight = true}

local function campaignFor(player: Player): string?
    local data = player:GetJoinData()
    local launch = data.LaunchData
    if type(launch) ~= "string" or #launch > 512 then return nil end
    local ok, decoded = pcall(function()
        return HttpService:JSONDecode(launch)
    end)
    if not ok or type(decoded) ~= "table" then return nil end
    if decoded.version ~= 1 or type(decoded.campaign) ~= "string" then return nil end
    if not campaigns[decoded.campaign] then return nil end
    return decoded.campaign
end

return campaignFor
```

### 4. Build a safe social loop

- Joining friends should preserve progress and provide a clear destination or shared objective.
- Handle full servers, failed teleports, age/region restrictions, and friends leaving.
- Referral rewards need durable inviter/invitee identity and an idempotent operation ID.
- NEVER reward solely for a client claiming it invited someone.
- Define self-referral, repeat-join, duplicate-account, and reward-cap behavior explicitly.
- Shareable moments should reflect earned gameplay, not fabricated achievements.
- For user-created content, define filtering, moderation, storage, and removal ownership.
- Community events need a real schedule, staffing, rollback, and post-event cleanup plan.

### 5. Make experiments interpretable

- Assign variants once per player or cohort and preserve membership across the experiment.
- Avoid changing thumbnail, tutorial, reward, and pricing simultaneously in one small test.
- Include a guardrail for join failures and poor first-session activation.
- Track invite exposure, prompt attempt, actual join, and activated referred player separately.
- Do not call increased prompt frequency a successful growth result without downstream evidence.

This pure conversion helper keeps denominators explicit.
It returns nil when a rate cannot be estimated from the available exposure count.

```luau
--!strict
type GrowthCounts = {exposed: number, activatedJoins: number}

local function activationRate(counts: GrowthCounts): number?
    assert(counts.exposed >= 0 and counts.exposed % 1 == 0)
    assert(counts.activatedJoins >= 0 and counts.activatedJoins % 1 == 0)
    assert(counts.activatedJoins <= counts.exposed)
    if counts.exposed == 0 then return nil end
    return counts.activatedJoins / counts.exposed
end

assert(activationRate({exposed = 100, activatedJoins = 12}) == 0.12)
assert(activationRate({exposed = 0, activatedJoins = 0}) == nil)
```

### 6. Verify the complete joining flow

- Test eligible and ineligible invitation states with supported devices.
- Confirm dismissal does not reopen a prompt automatically.
- Join using valid, malformed, stale, and tampered launch data.
- Test referred players arriving after the inviter leaves.
- Inspect the actual landing place and first objective for campaign traffic.
- Report sample size, exposure window, and attribution limits with experiment results.

## Common mistakes

- Treating visits as successful activation; measure the first meaningful gameplay outcome.
- Showing an invite prompt at every join; offer a voluntary contextual action.
- Granting referral currency from LaunchData; authorize through a durable server workflow.
- Using misleading thumbnails; align the promise with the playable experience.
- Reporting attributed joins as causal uplift; keep a control or explain the limitation.

## Reference

- [SocialService](https://create.roblox.com/docs/reference/engine/classes/SocialService).
- [Player invite prompts](https://create.roblox.com/docs/production/promotion/invite-prompts).
- [Analytics](https://create.roblox.com/docs/production/analytics).
