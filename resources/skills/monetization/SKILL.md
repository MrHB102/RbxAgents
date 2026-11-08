---
name: monetization
description: >
  Implements Roblox passes, developer products, durable receipt grants, policy eligibility, and honest purchase UI. Use when asked to "sell a game pass", "fix missing purchased coins", "process a developer product", "show current prices", "add paid random items", or "integrate rewarded ads".
---

# Roblox Monetization

## When to use

- Adding one-time entitlements, repeatable products, or supported subscription flows.
- Repairing duplicate grants, unprocessed receipts, and missing entitlements.
- Displaying current product information and purchase eligibility.
- Reviewing paid randomness, marketplace assets, or ad integration requirements.

## When NOT to use

- Designing general resource progression; that belongs to game-design.
- Building an entire profile lifecycle; that belongs to data and server-data.
- Choosing acquisition campaigns; that belongs to growth-design.

## Core instructions

### 1. Identify the product and promise

1. Distinguish passes, developer products, subscriptions, marketplace items, and ads.
2. ALWAYS state what is granted, whether it persists, and what happens on failure.
3. NEVER grant a developer product from PromptProductPurchaseFinished.
4. ProcessReceipt is the authoritative developer-product fulfillment boundary.
5. Keep one owner for ProcessReceipt and route product IDs through an allowlisted server catalog.
6. Use UserOwnsGamePassAsync on the server for pass entitlement checks.
7. Fetch current display metadata with GetProductInfoAsync rather than deprecated GetProductInfo.
8. Do not assume cross-experience product sales or platform eligibility remain supported; verify current docs.

### 2. Make developer-product grants durable and idempotent

- Store the receipt ID and its grant in the same atomic player record.
- A duplicate receipt MUST return PurchaseGranted only when the original grant is confirmed durable.
- NEVER grant in memory and then separately save a receipt flag.
- A failed call can have committed; retry the same receipt ID instead of awarding again.
- Return NotProcessedYet when the player, product, policy, or required storage is unavailable.
- Unknown product IDs require investigation; do not acknowledge them without fulfillment.
- Never prune receipt history casually; define a recoverable retention strategy before record growth becomes a limit.
- Integrate through an existing session owner's mutation API when that owner manages the wallet.

This standalone server example uses a dedicated wallet with no cached session writer.
ALL mutations to this wallet MUST use atomic UpdateAsync transforms.
Do not paste it beside a ProfileService/ProfileStore writer for the same balance.
Set CoinPackProductId on ServerStorage to the actual configured developer-product ID.
The bounded ledger stops fulfillment safely at capacity and requires operational follow-up.

```luau
--!strict
local MarketplaceService = game:GetService("MarketplaceService")
local DataStoreService = game:GetService("DataStoreService")
local ServerStorage = game:GetService("ServerStorage")
local Players = game:GetService("Players")
local walletStore = DataStoreService:GetDataStore("AtomicPurchaseWallet_v1")
local productId = ServerStorage:GetAttribute("CoinPackProductId")
assert(type(productId) == "number" and productId > 0 and productId % 1 == 0)
local grants: {[number]: number} = {[productId] = 100}
-- shortcut: this ledger holds 5,000 purchases, migrate with replay protection before capacity.

MarketplaceService.ProcessReceipt = function(receipt)
    local player = Players:GetPlayerByUserId(receipt.PlayerId)
    local amount = grants[receipt.ProductId]
    if not player or not amount then
        return Enum.ProductPurchaseDecision.NotProcessedYet
    end
    local ok, saved = pcall(function()
        return walletStore:UpdateAsync("u_" .. receipt.PlayerId, function(old, keyInfo)
            if old == nil then old = {coins = 0, receipts = {}} end
            if type(old) ~= "table" or type(old.coins) ~= "number" then return nil end
            if old.coins % 1 ~= 0 or old.coins < 0 or old.coins > 1_000_000_000 then return nil end
            if type(old.receipts) ~= "table" then return nil end
            local count = 0
            for id, granted in old.receipts do
                count += 1
                if type(id) ~= "string" or granted ~= true or count > 5_000 then return nil end
            end
            local userIds = if keyInfo then keyInfo:GetUserIds() else {receipt.PlayerId}
            local metadata = if keyInfo then keyInfo:GetMetadata() else {}
            if old.receipts[receipt.PurchaseId] == true then
                return old, userIds, metadata
            end
            if count >= 5_000 or old.coins + amount > 1_000_000_000 then return nil end
            local nextWallet = table.clone(old)
            nextWallet.receipts = table.clone(old.receipts)
            nextWallet.receipts[receipt.PurchaseId] = true
            nextWallet.coins += amount
            return nextWallet, userIds, metadata
        end)
    end)
    if ok and type(saved) == "table" and saved.receipts[receipt.PurchaseId] == true then
        return Enum.ProductPurchaseDecision.PurchaseGranted
    end
    warn("Purchase fulfillment deferred", receipt.ProductId)
    return Enum.ProductPurchaseDecision.NotProcessedYet
end
```

### 3. Verify pass ownership without trusting UI callbacks

- Check entitlement on join and after a relevant purchase prompt resolves.
- A prompt-finished callback triggers a fresh ownership check; it is not a universal grant token.
- Handle ownership API errors without selling or granting a contradictory state.
- Cache entitlement within an explicit freshness policy and invalidate after purchase.
- Distinguish a pass ID from an asset ID, place ID, and developer-product ID.

This server function returns nil for an unavailable entitlement check.
The caller must distinguish unavailable from a confirmed non-owner.

```luau
--!strict
local MarketplaceService = game:GetService("MarketplaceService")

local function ownsPass(player: Player, passId: number): boolean?
    assert(passId > 0 and passId % 1 == 0)
    local ok, result = pcall(function()
        return MarketplaceService:UserOwnsGamePassAsync(player.UserId, passId)
    end)
    if not ok or not player.Parent then
        return nil
    end
    return result
end

return ownsPass
```

### 4. Display current prices and respect eligibility

- Query product information on the client when current personalized price display requires it.
- NEVER hardcode a Robux price into a purchase button that can become inaccurate.
- Respect off-sale state, loading failure, cancellation, and insufficient eligibility.
- Use PolicyService:GetPolicyInfoForPlayerAsync on the server for applicable paid-random restrictions.
- Fail closed for restricted features when the policy check is unavailable.
- Paid random items MUST disclose every outcome and actual numerical odds under current Roblox rules.
- Apply the rules to currencies bought with Robux as well as direct Robux purchases.
- For rewarded ads, verify current AdService eligibility, lifecycle, and reward confirmation semantics.
- For UGC/catalog purchases, use the matching marketplace API; a developer-product receipt is a different contract.
- NEVER fabricate ad completion, marketplace ownership, or subscription state from a client claim.

This client helper obtains current metadata for a known developer product.
Its caller renders the price and opens a platform prompt only after an explicit button action.
Configure the product ID through public build configuration, not arbitrary player text.

```luau
--!strict
local MarketplaceService = game:GetService("MarketplaceService")

local function productLabel(productId: number): string?
    local ok, info = pcall(function()
        return MarketplaceService:GetProductInfoAsync(productId, Enum.InfoType.Product)
    end)
    if not ok or not info.IsForSale then return nil end
    if type(info.PriceInRobux) ~= "number" then return nil end
    return string.format("%s - %d Robux", info.Name, info.PriceInRobux)
end

return productLabel
```

### 5. Verify money-related failure cases

- Deliver the same receipt twice and concurrently; verify one durable increment.
- Simulate a response loss after a committed write and retry the same receipt.
- Test absent players, unknown products, record capacity, invalid old data, and backend failure.
- Rejoin after a grant and verify that the entitlement survives.
- Check personalized price display, restricted-user behavior, and cancellation on supported devices.
- Test purchases through published staging and approved test facilities before enabling a live listing.
- Monitor deferred receipts and define an owner and recovery process for fulfillment failures.

## Common mistakes

- Granting from a purchase-prompt event; fulfill developer products through ProcessReceipt.
- Saving grant and receipt in different keys; make them one atomic durable operation.
- Returning PurchaseGranted after a failed save; defer until fulfillment is confirmed.
- Mixing direct wallet writes with cached profiles; use one authoritative mutation owner.
- Reusing remembered prices or regional rules; query current metadata and policy eligibility.

## Reference

- [Developer products](https://create.roblox.com/docs/production/monetization/developer-products).
- [MarketplaceService](https://create.roblox.com/docs/reference/engine/classes/MarketplaceService).
- [Paid random items](https://create.roblox.com/docs/production/monetization/paid-random-items).
