---
name: localization
description: >
  Implements Roblox localization keys, dynamic translations, locale-aware layouts, and safe fallback behavior. Use when asked to "translate my game", "localize dynamic text", "fix missing translations", "support RTL text", "handle plural messages", or "adapt content by locale".
---

# Roblox Localization

## When to use

- Building a stable source-string catalog and translation workflow.
- Formatting dynamic counts, rewards, and contextual messages.
- Fixing translated text overflow and right-to-left presentation.
- Choosing localized images, audio, and safe source-language fallbacks.

## When NOT to use

- Designing a responsive menu without translation work; that belongs to gui.
- Determining purchase eligibility from policy; that belongs to monetization.
- Filtering player-generated text; that belongs to security and TextService integration.

## Core instructions

### 1. Separate meaning from display text

1. Use stable semantic keys rather than the English sentence as application logic.
2. ALWAYS supply context and an example for ambiguous words or parameterized strings.
3. NEVER concatenate translated fragments to construct a sentence.
4. Keep internal item IDs separate from localized names and descriptions.
5. Use LocalizationService and Translator for supported localization workflows.
6. NEVER use deprecated GetTranslatorForPlayer in new code; use its async replacement.
7. Translation does not filter user-generated text or determine legal purchase eligibility.
8. Do not infer a player's country, identity, or policy restrictions from their language.

### 2. Author a coherent catalog

- Keep placeholders stable and named according to their meaning.
- Translate complete messages so word order can change.
- Maintain source fallback text even when a cloud translation is missing.
- Avoid runtime catalog rewrites; LocalizationTable changes can replicate the whole table.
- Use separate semantic keys for messages that need genuinely different grammatical forms.
- Have a qualified reviewer validate important store, safety, and tutorial text.

This edit-time example creates a small standalone table with explicit context.
It refuses to overwrite an existing catalog.
Merge entries through the project's reviewed translation workflow for existing games.

```luau
--!strict
local LocalizationService = game:GetService("LocalizationService")
assert(not LocalizationService:FindFirstChild("ExampleCatalog"), "Catalog already exists")

local catalog = Instance.new("LocalizationTable")
catalog.Name = "ExampleCatalog"
catalog.SourceLocaleId = "en-us"
catalog:SetEntries({
    {
        Key = "Quest.RewardCoins",
        Source = "Reward: {amount} coins",
        Context = "Quest completion reward label",
        Example = "Reward: 25 coins",
        Values = {
            ["pt-br"] = "Recompensa: {amount} moedas",
            ["es-es"] = "Recompensa: {amount} monedas",
        },
    },
    {
        Key = "Menu.Continue",
        Source = "Continue",
        Context = "Resume playing after closing the pause menu",
        Values = {["pt-br"] = "Continuar"},
    },
})
catalog.Parent = LocalizationService
assert(#catalog:GetEntries() == 2)
```

### 3. Load translators with bounded impact

- GetTranslatorForPlayerAsync can yield or fail; wrap it in pcall.
- Do not block all gameplay or initial UI on translation availability.
- Cache the translator for its intended owner and refresh when that owner changes.
- Check view lifetime after an async translator request completes.
- Catch missing-key or formatting failures and preserve readable source fallback text.
- NEVER display raw exception strings to the player.

This LocalScript obtains a translator and formats one complete message.
Use the same parameter names as the catalog's placeholders.

```luau
--!strict
local Players = game:GetService("Players")
local LocalizationService = game:GetService("LocalizationService")
local player = Players.LocalPlayer

local ok, translator = pcall(function()
    return LocalizationService:GetTranslatorForPlayerAsync(player)
end)

local function rewardText(amount: number): string
    local fallback = string.format("Reward: %d coins", amount)
    if not ok then return fallback end
    local formatted, result = pcall(function()
        return translator:FormatByKey("Quest.RewardCoins", {amount = amount})
    end)
    if formatted and type(result) == "string" then
        return result
    end
    return fallback
end

print(rewardText(25))
```

### 4. Handle grammar, numbers, and direction deliberately

- Do not apply English singular/plural rules to every language.
- Verify the current formatting features before relying on a plural expression syntax.
- If needed, select a locale-reviewed semantic variant through a tested locale rule set.
- NEVER claim one universal `count == 1` branch handles all plural categories.
- Use supported locale formatting for numbers and dates; avoid manually replacing separators.
- Set TextDirection.Auto for mixed-script text unless a reviewed layout requires a fixed direction.
- Mirroring a UI is separate from ordering characters; test icons and navigation too.
- Preserve digits, punctuation, player names, and item IDs in mixed-direction messages.

This label factory allows text growth and automatic script direction.
It returns an unparented label so the caller's existing layout retains ownership.

```luau
--!strict
local function newLocalizedLabel(text: string): TextLabel
    local label = Instance.new("TextLabel")
    label.BackgroundTransparency = 1
    label.Size = UDim2.new(1, 0, 0, 0)
    label.AutomaticSize = Enum.AutomaticSize.Y
    label.TextWrapped = true
    label.TextSize = 20
    label.TextDirection = Enum.TextDirection.Auto
    label.TextXAlignment = Enum.TextXAlignment.Left
    label.AutoLocalize = false
    label.Text = text
    return label
end

local label = newLocalizedLabel("Continue")
assert(label.TextWrapped and label.AutomaticSize == Enum.AutomaticSize.Y)
label:Destroy()
```

### 5. Verify locale behavior

- Test missing keys, unavailable translators, bad placeholder names, and source fallbacks.
- Use long translations, preferred text size, and narrow screens to reveal clipping.
- Test Arabic or Hebrew mixed with digits and Latin item names.
- Review singular, zero, few, and many cases for each supported language's actual rules.
- Confirm localized asset IDs remain allowlisted and have experience permissions.
- Keep policy checks on the server through PolicyService rather than language or UI state.
- Disable AutoLocalize on already-formatted dynamic labels to avoid double translation.
- Log aggregate missing-key counts without collecting players' private text.

## Common mistakes

- Concatenating translated nouns and verbs; translate one parameterized sentence.
- Assuming language implies country or eligibility; use the relevant server policy API.
- Shrinking text to fit the English layout; allow wrapping and content-sized containers.
- Reversing RTL strings manually; use supported text direction and test mixed scripts.
- Failing when a key is absent; return a readable source-language fallback.

## Reference

- [Localize with scripting](https://create.roblox.com/docs/production/localization/localize-with-scripting).
- [LocalizationTable](https://create.roblox.com/docs/reference/engine/classes/LocalizationTable).
- [Translator](https://create.roblox.com/docs/reference/engine/classes/Translator).
