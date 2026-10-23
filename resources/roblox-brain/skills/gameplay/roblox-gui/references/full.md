# roblox gui: full reference

> Code examples are illustrative. Adapt them to your project and verify in Studio before production use.

The most reliable Roblox UI is layout-driven, state-aware, and tested at more than one aspect ratio. The examples below use native UI objects and do not require a UI framework.

## 1. Choose the container

- `ScreenGui`: a 2D overlay attached to a player's screen.
- `SurfaceGui`: controls rendered on a part or attachment.
- `BillboardGui`: a camera-facing label or panel in the 3D world.
- `ViewportFrame`: a UI region that renders a 3D model preview.

Set `DisplayOrder` deliberately when multiple `ScreenGui` instances overlap. For UI templates in `StarterGui`, set `ResetOnSpawn = false` and keep the `ScreenGui` a direct child of `StarterGui` to clone it once and preserve it across character respawns. Templates with `ResetOnSpawn = true` (the default), or nested indirectly under `StarterGui`, are deleted and re-cloned on respawn. This describes StarterGui template cloning, not every dynamically created `ScreenGui`. Do not set `IgnoreGuiInset` globally without checking how the layout interacts with Roblox's top-bar and safe-area behavior.

## 2. Build from containers

Give each visual region a container with one responsibility: header, content, footer, or modal. Put a layout object inside the container that owns repeated children.

```luau
local panel = Instance.new("Frame")
panel.Name = "InventoryPanel"
panel.AnchorPoint = Vector2.new(0.5, 0.5)
panel.Position = UDim2.fromScale(0.5, 0.5)
panel.Size = UDim2.fromScale(0.8, 0.75)
panel.BackgroundColor3 = Color3.fromRGB(25, 28, 36)
panel.Parent = screenGui

local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 16)
padding.PaddingBottom = UDim.new(0, 16)
padding.PaddingLeft = UDim.new(0, 16)
padding.PaddingRight = UDim.new(0, 16)
padding.Parent = panel

local list = Instance.new("UIListLayout")
list.Padding = UDim.new(0, 8)
list.SortOrder = Enum.SortOrder.LayoutOrder
list.Parent = panel
```

Use `LayoutOrder` as data, not as a visual afterthought. If children are created dynamically, assign their order in the view model or row constructor.

## 3. Scale and offset

`UDim2` combines proportional `Scale` with fixed `Offset`. A common pattern is scale for the outer region and offset for internal padding:

```luau
local card = Instance.new("Frame")
card.AnchorPoint = Vector2.new(0.5, 1)
card.Position = UDim2.fromScale(0.5, 0.94)
card.Size = UDim2.new(0.86, 0, 0, 120)

local sizeLimit = Instance.new("UISizeConstraint")
sizeLimit.MinSize = Vector2.new(260, 96)
sizeLimit.MaxSize = Vector2.new(720, 220)
sizeLimit.Parent = card
```

Use `UIAspectRatioConstraint` for shapes that must remain square or maintain a fixed ratio. Keep text containers bounded so a translated or long string cannot expand the entire screen unexpectedly.

## 4. Text and images

Choose one sizing policy for each text region:

- fixed `TextSize` plus a layout constraint when the content is controlled;
- `TextScaled` only when the allowed range is bounded by `UITextSizeConstraint`;
- `AutomaticSize` when the parent has room to grow and the layout can respond.

Test long strings, empty strings, and missing images. A missing asset should produce a useful placeholder, not a layout collapse. Avoid putting essential game state only in color or iconography.

### Truncation and overflow policy

`TextWrapped` wraps text within the element; `TextTruncate` then controls what happens when even wrapped text does not fit:

- `Enum.TextTruncate.None` (default): overflow is clipped silently.
- `Enum.TextTruncate.AtEnd`: replaces overflow with `...`, cutting at a word boundary where possible.
- `Enum.TextTruncate.SplitWord`: replaces overflow with `...` mid-word, using the space better for narrow cells.

Truncation is per-line, not per-paragraph: with wrapping enabled it truncates the final visible line. Combine policies deliberately — e.g. a fixed-size inventory slot uses `TextWrapped = true` + `TextTruncate = AtEnd` so a long item name degrades gracefully, while a heading may use `TextScaled` bounded by `UITextSizeConstraint` instead. `TextFits` tells you whether the current text overflows, and `MaxVisibleGraphemes` can hard-limit displayed graphemes without reflowing the layout. Localized strings run longer than English on average; test truncation with a long translated string, not just with the source string.

### RichText is a rendering mode, not a data format

Enable `RichText` per object (`TextLabel`, `TextButton`, `TextBox`) and write markup into `Text` (`<b>`, `<i>`, `<font color="#FF7800">`, `<br/>`, escapes `&lt;`/`&amp;` for literal angle brackets). Two trust rules:

- Never enable `RichText` for strings containing player input or other untrusted text. Markup tags in such strings render as styling, not characters — a player can inject `<font color="...">` to imitate system messages. Escape (`&lt;`) or strip before display; store plain text and apply tags only at render time from trusted code.
- Localization strips rich-text tags from translated strings: re-apply tags to localized variants manually, or the formatting silently disappears in non-English locales.

## 5. Scrolling content

A `ScrollingFrame` needs a clear canvas policy. For a vertical list, put a `UIListLayout` inside it and use `AutomaticCanvasSize = Enum.AutomaticSize.Y` when the project does not need to calculate canvas size manually.

```luau
local scroll = Instance.new("ScrollingFrame")
scroll.Size = UDim2.fromScale(1, 1)
scroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
scroll.CanvasSize = UDim2.fromScale(0, 0)
scroll.ScrollBarThickness = 6
scroll.Parent = content

local list = Instance.new("UIListLayout")
list.Padding = UDim.new(0, 6)
list.SortOrder = Enum.SortOrder.LayoutOrder
list.Parent = scroll
```

Do not nest an automatically growing scroll region inside another automatic scroll region unless the interaction is intentional and tested.

## 5a. Grids of uniform cells (UIGridLayout)

`UIListLayout` stacks children in one row or column. When cells should wrap and every cell shares one size, use `UIGridLayout` (inventory slots, icon palettes, card walls). Illustrative layout; test actual viewport sizes and content in Studio:

```luau
local grid = Instance.new("UIGridLayout")
grid.CellSize = UDim2.new(0, 64, 0, 64)
grid.CellPadding = UDim2.new(0, 8, 0, 8) -- default {0,5},{0,5}
grid.SortOrder = Enum.SortOrder.LayoutOrder
grid.Parent = inventoryFrame
```

`UIGridLayout` takes control of child `Size` and `Position`; per-child sizes are ignored unless a `UIConstraint` on the child overrides the grid's `CellSize` (a `UISizeConstraint` with a larger `MinSize` makes an element span multiple cells). Other knobs:

- `FillDirectionMaxCells`: max cells per row/column before wrapping (0 = fill the parent's space; 1 = collapses the grid into a UIListLayout-like single column/row).
- `StartCorner` (`Enum.StartCorner`): which corner layout starts from (default TopLeft; BottomRight for RTL or docked-right panels).
- `FillDirection` (inherited from `UIGridStyleLayout`): `Horizontal` (default) or `Vertical`.

Read-only `AbsoluteCellCount` and `AbsoluteCellSize` report the resolved layout. For true tabular data where a mid-row break is wrong (aligned columns of values), use `UITableLayout` instead; grids are for cells where wrapping after any item is acceptable.

## 6. UI state and server state

The UI should render a snapshot or view model. It may request an action, but the server response determines the final display.

```luau
local HttpService = game:GetService("HttpService")

local state = {
    requestId = nil, -- non-nil while a purchase is pending or its outcome is unknown
    selectedId = nil,
    -- True once the timeout window closed without a correlated answer. The
    -- request stays recorded (requestId holds) so the UI blocks a FRESH
    -- same-intent purchase that could double-spend a purchase that may
    -- still have committed. Reconciliation can still settle it.
    unresolved = false,
}

local function render()
    local busy = state.requestId ~= nil
    -- While a request is recorded (pending OR unresolved), a fresh
    -- same-intent purchase must stay blocked. Only a correlated result or
    -- snapshot may release it.
    buyButton.Active = not busy and not state.unresolved and state.selectedId ~= nil
    spinner.Visible = busy and not state.unresolved
end

local REQUEST_TIMEOUT = 8 -- seconds; bounds both the request and the refresh

buyButton.Activated:Connect(function()
    if state.requestId or not state.selectedId then
        return
    end
    state.requestId = HttpService:GenerateGUID(false)
    local myId = state.requestId -- token: only THIS purchase's timers act
    render()
    BuyItem:FireServer(myId, state.selectedId)

    -- Bound the pending state: silence can mean a lost request OR a
    -- committed purchase whose response never arrived.
    task.delay(REQUEST_TIMEOUT, function()
        -- Token check: if this purchase already resolved, or a NEWER
        -- purchase is now pending, this old timer must do nothing.
        if state.requestId ~= myId then
            return
        end
        statusLabel.Text = "Purchase outcome unknown. Refreshing..."
        RefreshPurchases:FireServer(myId) -- reconcile; never blind-retry
        -- Bound the refresh too: if no correlated answer arrives, stop the
        -- spinner but DO NOT discard the operation. The request id stays
        -- recorded and unresolved=true keeps Buy blocked, because the
        -- original purchase may still have committed, and a fresh same-intent
        -- purchase could double-spend. Reconciliation (a correlated
        -- PurchaseResult or echoed InventorySync) can still settle it.
        task.delay(REQUEST_TIMEOUT, function()
            if state.requestId == myId then
                state.unresolved = true
                statusLabel.Text = "Purchase outcome unknown. Check your inventory later."
                render()
            end
        end)
    end)
end)

PurchaseResult.OnClientEvent:Connect(function(id, ok, message)
    if id ~= state.requestId then
        return -- stale, duplicate, or already-reconciled result
    end
    state.requestId = nil
    state.unresolved = false
    statusLabel.Text = message
    render()
end)

-- Authoritative state wins, but only when it is actually NEWER than the
-- pending request: an unrelated background snapshot (fired before the
-- purchase committed) must not clear the pending state. The server echoes
-- the reconciled request id in the snapshot it sends in response to
-- RefreshPurchases; only that correlation settles a pending request,
-- including one already marked unresolved.
InventorySync.OnClientEvent:Connect(function(snapshot)
    if state.requestId then
        if snapshot.reconciledRequestId ~= state.requestId then
            return -- older or unrelated snapshot: leave the pending state alone
        end
        state.requestId = nil -- correlated reconciliation settles the request
        state.unresolved = false
    end
    statusLabel.Text = snapshot.ownsItem and "Purchased" or "Not purchased"
    render()
end)
```

Do not grant currency, inventory, or ownership because a local button handler ran. The UI is an input surface, not a trust boundary. Correlate each request with an id, treat "no response yet" as a bounded unknown rather than a failure to retry, and reconcile against authoritative server state: a timed-out purchase may still have committed, so a blind retry can double-spend. In Server Authority projects, the client may briefly render predicted state that is later corrected by rollback. Keep durable displays tied to confirmed server or synchronized state, and mark optimistic feedback as pending when the distinction matters.

## 7. Input and interaction

Use `Activated` for buttons when possible. Use `ContextActionService` for UI-only actions that should map across keyboard, gamepad, and touch. For gameplay-affecting input in a Server Authority project, use `InputAction`/`InputContext` and the synchronized simulation path. Use `UserInputService` when you need raw device details or gesture tracking.

Every interactive control needs:

- a visible state for hover, press, disabled, and focus where the platform supports it;
- a clear label or tooltip;
- a route that works without precise mouse aiming;
- a debounced action that cannot issue duplicate requests while busy.

### Reliable hover (MouseEnter/MouseLeave pitfalls)

Native `GuiObject.MouseEnter`/`MouseLeave` only re-check hover when the mouse moves, so they can miss when content scrolls under a stationary cursor (e.g. inside a `ScrollingFrame`) or occasionally fail to fire `MouseLeave`. For reliable hover, poll the cursor each frame and fire your own enter/leave on state transitions. This is a practitioner pattern (DevForum lead: "REAL MouseEnter/MouseLeave for GuiObjects", 7eoeb, https://devforum.roblox.com/t/real-mouseentermouseleave-for-guiobjects-they-actually-fire/3980310). Prefer `PlayerGui:GetGuiObjectsAtPosition()` over hardcoded top-bar offsets, and clean up the signals with the owning UI's lifetime.

The two coordinate spaces differ: `UserInputService:GetMouseLocation()` returns raw pixels that do **not** account for `Enum.ScreenInsets`, while `BasePlayerGui:GetGuiObjectsAtPosition()` expects x/y relative to the top-left corner **after** the GUI inset is applied (per its docs, see `GuiService:GetGuiInset()`). Convert by subtracting the top-left inset before the hit test — the example below documents that conversion, but the exact on-screen offset behavior (especially with `ScreenGui.IgnoreGuiInset = true`, top-bar variants, or mobile) has **not been live-verified in Studio**; illustrative only, verify against the real target layout before relying on it. Do not assume raw `GetMouseLocation()` coordinates are correct for `IgnoreGuiInset = true` ScreenGuis without measuring.

```luau
-- ILLUSTRATIVE: inset conversion not live-verified in Studio; see note above.
local Players = game:GetService("Players")
local RS = game:GetService("RunService")
local UIS = game:GetService("UserInputService")
local GuiService = game:GetService("GuiService")

local playerGui = Players.LocalPlayer:WaitForChild("PlayerGui")

local hovered = false
RS.RenderStepped:Connect(function()
    local pos = UIS:GetMouseLocation()
    -- GetGuiObjectsAtPosition expects inset-adjusted coordinates; subtract
    -- the top-left inset (first GetGuiInset return) before the hit test.
    local inset = GuiService:GetGuiInset()
    local isOver = false
    for _, obj in playerGui:GetGuiObjectsAtPosition(pos.X - inset.X, pos.Y - inset.Y) do
        if obj == frame then isOver = true break end
    end
    if isOver and not hovered then
        hovered = true
        onEnter()
    elseif not isOver and hovered then
        hovered = false
        onLeave()
    end
end)
```

## 7a. Text entry: focus lifecycle and mobile submit

A `TextBox` takes focus by click, tap, or gamepad selection; only then does keyboard input reach it.

- `Focused` fires on gain (user input or `CaptureFocus()`); `FocusLost(enterPressed, inputThatCausedFocusLoss)` fires on loss — `enterPressed` distinguishes Enter-submission from clicking away. `:IsFocused()` and `UserInputService:GetFocusedTextBox()` check current state.
- `:CaptureFocus()` when a dialog opens so the player need not tap the field first; `:ReleaseFocus()` (optionally `:ReleaseFocus(true)` to make the subsequent `FocusLost` report `enterPressed = true`) when something more important must reclaim keyboard input. `CaptureFocus` only works on the client — call it from a `LocalScript`.
- `ClearTextOnFocus` defaults to true, which wipes existing text on refocus; set false for editable fields. `PlaceholderText`/`PlaceholderColor3` prompt the expected format. `MultiLine` lets Enter insert newlines (and thus never submits on Enter alone).
- Mobile/console: `ReturnPressedFromOnScreenKeyboard` may also fire. Route it and Enter-submission from `FocusLost` through one deduplicated submit path; do not send the same request twice.

Operator guidance: allow one submission per active edit/dialog attempt, reset that guard when a new attempt starts, and disable submission while a request is in flight. Test hardware Enter, on-screen Return, clicking away, and programmatic focus release on actual target devices.

Filtering duty: any text sent to other players (chat, names, signs) must pass through `TextService:FilterStringAsync()` server-side before display to its intended audience; saved text must be filtered again when displayed — a `TextBox`'s `Text` is unfiltered player input. Never set `RichText = true` on a field that renders player-entered text: with `RichText` enabled the user edits the raw markup string, and unfiltered `<font ...>` tags become a spoofing vector, not a formatting feature.

## 8. Gamepad focus and selection

Gamepad support is not complete when a button merely reacts to `Activated`. The player also needs a predictable focus path:

```luau
local GuiService = game:GetService("GuiService")

playButton.Selectable = true
settingsButton.Selectable = true

-- Set this when opening the menu, not every frame.
GuiService.SelectedObject = playButton
```

For larger menus, group related controls and define explicit directional behavior where automatic selection is ambiguous. Test selection entering and leaving nested containers, covered elements, modal dialogs, and a changing list. Roblox's current directional-selection behavior includes ancestor grouping, covered-element handling, and improved analog-stick navigation. The official `focus-navigation` repository is a read-only mirror and is best treated as an optional reference rather than a mandatory dependency.

React Luau is another optional reference for state-driven, declarative UI. Do not introduce it into a small native UI merely to avoid writing a few render functions.

### Focus ownership

Most controller bugs are focus bugs, not missing bindings. Give every view one owner of `GuiService.SelectedObject` and apply these rules:

- **Entry:** when a view opens on gamepad, select a control that is visible in the *current* sub-view, such as the active tab's first actionable item, not a fixed "Claim" or "Buy" button that a tab switch may have hidden. Re-check after every tab switch, page change and list rebuild.
- **Boundary:** set `SelectionGroup = true` on a window's root and `SelectionBehaviorUp/Down/Left/Right = Enum.SelectionBehavior.Stop` on the edges where focus must not escape. With the default `Escape`, directional navigation can leave the window and land on HUD buttons behind it.
- **Rebuilt lists:** when a list is destroyed and recreated (equip, purchase, favorite, filter), remember the selected item's id first. Afterwards, select the matching new row, or a visible fallback, and keep the scroll position. Otherwise the action the player just pressed throws their focus away.
- **Back:** B/Circle unwinds one layer at a time: an inner overlay or picker closes before its window, and the window closes before gameplay. Non-modal panels that take input (results, spectate controls, offers) need their own Back route too.
- **Exit:** on close, restore the control that opened the view if it still exists and is visible, otherwise clear the selection. When the player switches away from gamepad (`PreferredInput` changes), clear stale game selection.
- **No stealing:** automatic panels (offers, notifications, spectate target changes) must not move focus while another view owns it.
- **Stray selection blocks gameplay:** while `SelectedObject` is set, gamepad buttons drive UI navigation and activation. A selection left on a HUD button after a menu closes can swallow the attack or jump press. Clear it when gameplay resumes (round start, menu close), and include "is a GUI selected?" in the gameplay input gate (`roblox-input`).
- **Third-party top-bar libraries** can bind global gamepad keys. One popular top-bar library binds D-pad Up to select its icons, which pulls focus out of any open window. Check the library's settings for its controller bindings, and keep D-pad Up inside your windows.

Make the main destinations reachable in a few presses. Console navigation is sequential, so add shortcuts for key actions (for example, a bumper that opens the main menu) instead of making players traverse the whole HUD.

## 9. Animation and cleanup

Tween a small set of properties and cancel or replace the previous tween when state changes. Keep connections and tweens owned by the screen or row they affect. Destroy temporary UI when the owning feature closes.

```luau
local TweenService = game:GetService("TweenService")
local modal = screenGui.Modal -- CanvasGroup
local openTween = TweenService:Create(
    modal,
    TweenInfo.new(0.18, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
    { GroupTransparency = 0 }
)

openTween:Play()
```

If the object can be destroyed before the tween completes, connect cleanup to the owner's lifetime rather than assuming `Completed` will always run.

### Deprecated tween/transparency APIs and their replacements

Older code often animates UI with the deprecated `GuiObject` methods and mixed property. Migrate:

- `TweenPosition`, `TweenSize`, `TweenSizeAndPosition` → `TweenService:Create()` on `Position`, `Size`, or both in one property table. `TweenService` is object-oriented and event-based (`Completed` event, cancellable, tweenable with `EasingStyle`/`EasingDirection`); the old methods return only a boolean and offer a completion callback at most.
- `GuiObject.Transparency` → set `BackgroundTransparency` (background+border) and, for labels/buttons/text boxes, `TextTransparency` separately. The deprecated property mixes background and text transparency; avoid relying on its legacy coupling.
- Also deprecated on the same class: `Draggable` → `UIDragDetector`; `BackgroundColor`/`BorderColor` (BrickColor) → `BackgroundColor3`/`BorderColor3`; `FontSize` → `TextSize`.

```luau
-- Before: frame:TweenPosition(UDim2.fromScale(0.5, 0.2), Enum.EasingDirection.Out, Enum.EasingStyle.Quad, 0.25, true)
-- After:
local TweenService = game:GetService("TweenService")
TweenService:Create(
    frame,
    TweenInfo.new(0.25, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
    { Position = UDim2.fromScale(0.5, 0.2) }
):Play()
```

`TweenService` also handles what the old methods could not: tweening `BackgroundTransparency` and `TextTransparency` together for a true fade, or `CanvasGroup.GroupTransparency` for the whole subtree.

## Reactive UI libraries: scope, lifetime, and lists

Native instances (everything above) are the default. Some projects use a reactive UI library instead — [Fusion](https://elttob.uk/Fusion/0.3/) (dphfox/Fusion, 0.3 line), [Vide](https://github.com/centau/vide), [Fluid](https://github.com/ffrostfall/fluid) (Vide-derived, MIT, v0.6.5), or React-Luau. Follow the project's existing choice; do not introduce one into a native-UI project to avoid writing a few render functions. The rules below are library-neutral; the per-library notes were verified against each repo and its docs (2026-10).

### Two lifetimes: session state vs screen state

- Session-length state (player stats, settings, currency display) lives in a module created once per session. Screens consume it; they do not own it.
- Per-open UI (menus, shop, HUD screens) gets a fresh reactive scope/root each time it opens and is destroyed on close.
- Putting mutable game state inside a screen's scope destroys it on the first close. Putting screen widgets in a session/root scope leaks them.

### Who cleans up what (the differences are the decision)

- **Fusion (0.3):** every constructor registers a destructor into the scope you pass it, and scope cleanup (`doCleanup`) destroys contents in reverse order (docs: Scopes tutorial, `Computed` API). `Hydrate` inserts the target instance into the scope (verified in `src/Instances/Hydrate.luau`), so hydrating a designer-built instance means scope cleanup destroys it — clone the instance first if it must survive the scope.
- **Vide:** `cleanup()` accepts functions and supported destroy/disconnect resources, and runs it when the scope reruns or is destroyed. The docs state instances "do not need to be explicitly destroyed for their memory to be freed, they only need to be parented to `nil`", so instance teardown stays a manual idiom: a screen teardown should still unparent its root.
- **Fluid:** `root()`'s returned destructor tears down the reactive graph — cleanups, dependencies, child nodes — but does **not** destroy Instances created by `create()`; verified in fluid source (`src/reactive/root.luau`, `src/instances/create.luau` register no instance teardown). A screen opened in a loop leaks instances unless an explicit `cleanup(instance)` (which does call `:Destroy()`) or a manual unparent sits at the tree root.
- General rule for any library: name the single root teardown call per screen, and verify instances are actually removed on close.

### Derived state vs effects

- A value that is a pure function of other state should be derived (computed), not stored and written by three code paths that can drift.
- Conversely, do not wrap constants in reactive machinery.
- Side effects do not belong in derived computations. Fusion's docs state recalculations "might be postponed or cancelled if the value of the computed isn't being used" and warn against using computeds "for things like playing sound effects". Put side effects in explicit observers/effects (Fusion `Observer:onChange`/`:onBind`), and expect their callbacks to fire at surprising times — during scope teardown, before the tree is parented — a fatal-throw bug class.

### Keyed list rendering

- Per-entry scopes must be keyed by identity, not array position, or a reorder destroys and rebuilds rows that should have moved.
- Visible order must come from an explicit layout property (`LayoutOrder`); hash-map output ordering is arbitrary.
- Duplicate keys misbehave: Vide's `values()` errors on duplicate values under strict mode (`"table source passed to 'values()' contains duplicate values"`) and its docs warn duplicates "can cause unexpected behavior" otherwise. Deduplicate or index before rendering.
- Exit animations need an explicit leaving-grace (delayed destruction while the tween plays), not an ad-hoc debounce.

### The reopen leak test

Any screen that opens and closes should survive this checklist (original procedure):

1. Record the descendant count of the screen's container at baseline.
2. Open and close the screen 10 times in a loop.
3. Assert the count returns to baseline. A growing count means leaked instances; a growing connection count means leaked signals.
4. Repeat with the screen closed mid-animation and mid-network-response — the two states that expose teardown-order bugs.

Run it from the command bar or as an engine test (see roblox-tooling's test-runner doctrine). It is the reactive-library equivalent of the UI checklist rule that every temporary connection, tween, and row has an owner lifetime.

## 10. Shops, dialogs, and notifications

A practical UI flow is:

1. render a neutral/loading state;
2. load or receive the data model;
3. allow one action at a time per row or transaction;
4. show a success, failure, or retry state;
5. refresh from authoritative state after the action.

Do not close a purchase dialog merely because a prompt was opened. Wait for the purchase or server result, and handle cancellation.

## 11. Mobile-first layout and cross-device review

Roblox's mobile input guide states that the majority of Roblox sessions are played on mobile devices. Design every screen for a small landscape phone first, then let it grow for tablet, desktop and TV. A layout designed at 1080p and shrunk to a phone ends up with tap targets and text too small to use. A phone layout that grows still works.

### 11.1 Design order

1. **Smallest supported landscape phone** (iPhone SE/7 class, about 667×375 points), with the touch controls showing.
2. **Common phones** (about 780–850 × 360–390, for example mid-range Android and current iPhones). Notches and home-bar insets live here.
3. **Tablet** (1024×768 and 960×600 class). Check that the layout grows instead of stretching.
4. **Desktop** with mouse and keyboard.
5. **Console/TV** with a controller at 1080p and 4K (§11.7).

Fix each layout before moving to the next. A fix made for one size can break a smaller one, so re-check the phone after every change.

### 11.2 What Roblox already occupies

Your UI shares the screen with engine UI. Reserve it explicitly rather than guessing:

| Region | Owner | How to read it |
|---|---|---|
| Top bar | Roblox menu, chat and backpack buttons | `GuiService:GetGuiInset()` for the inset; `GuiService.TopbarInset` (a `Rect`) for the free strip beside Roblox's buttons. It changes at runtime, so listen with `GetPropertyChangedSignal("TopbarInset")`. |
| Device cutouts | Notch, camera hole, rounded corners | `ScreenGui.ScreenInsets` (§11.3) |
| Movement zone | Thumbstick (the dynamic thumbstick accepts touches across a large part of the left side) | Treat the lower-left area as reserved; no buttons there |
| Jump button | Bottom-right | Measure it from `PlayerGui.TouchGui` when present (see `roblox-input`), not a hardcoded offset |
| Chat window and player list | Upper-left and upper-right on desktop | Leave room for them, or move your HUD when they are open |

Anything else you add to the lower-right competes with the jump button and with camera drags, which players do with their right thumb.

### 11.3 Safe-area containers

`Enum.ScreenInsets` per `ScreenGui`:

- `CoreUISafeInsets`: avoids device cutouts **and** Roblox core UI. The docs recommend it for interactive and important UI (buttons, status).
- `DeviceSafeInsets`: avoids cutouts only. Use it when you deliberately place content beside the top-bar buttons.
- `TopbarSafeInsets`: the free strip in the top bar. Use it for top-bar entries.
- `None`: the full screen. Use it only for non-interactive content such as backgrounds, vignettes and screen flashes.

`ScreenGui.ClipToDeviceSafeArea` defaults to `true`, which clips descendants at the safe area. `ScreenGui.SafeAreaCompatibility` defaults to `FullscreenExtension`; the docs recommend choosing `ScreenInsets` per container instead for new work. `GetGuiInset()` offsets apply only to ScreenGuis with `IgnoreGuiInset = false`. When you compare positions across ScreenGuis with different `IgnoreGuiInset` values, convert to one coordinate space first.

### 11.4 Place by measurement, not by offset

On a crowded phone, a fixed offset that clears its neighbour at one size overlaps it at another. Read the neighbour's real bounds (`AbsolutePosition` and `AbsoluteSize`) and position against them. Re-run the placement while the element is visible: the neighbours move with screen size, input mode and game state.

```luau
local GuiService = game:GetService("GuiService")

-- Screen-space top edge of a GuiObject, whatever its ScreenGui's IgnoreGuiInset.
local function screenTop(object: GuiObject): number
	local screen = object:FindFirstAncestorWhichIsA("ScreenGui")
	local offset = if screen and not screen.IgnoreGuiInset then GuiService:GetGuiInset().Y else 0
	return object.AbsolutePosition.Y + offset
end

-- Keep `element` (bottom-anchored, AnchorPoint.Y = 1) at least `gap` pixels above `below`.
local function keepAbove(element: GuiObject, home: UDim2, below: GuiObject, gap: number)
	local screen = element:FindFirstAncestorWhichIsA("ScreenGui")
	if not screen or not below.Visible then
		element.Position = home
		return
	end
	local origin = if screen.IgnoreGuiInset then 0 else GuiService:GetGuiInset().Y
	local limit = screenTop(below) - origin - gap
	local homeBottom = screen.AbsoluteSize.Y * home.Y.Scale + home.Y.Offset
	if homeBottom > limit then
		element.Position = UDim2.new(home.X, UDim.new(0, math.floor(limit)))
	else
		element.Position = home
	end
end
```

The same idea works sideways. When a bottom bar and a corner control would meet on a narrow screen, slide the bar toward the free side by exactly the overlap (bounded so it never enters the thumbstick zone), rather than shrinking everything.

### 11.5 Overlap comes from state combinations

Screens rarely overlap in their default state. They overlap when a new feature shows two elements together for the first time: a held weapon's touch button plus the out-of-round menu, a spectate bar plus the hotbar, a toast plus a timer warning. For each feature:

- List the HUD states it can appear in (lobby, alive in a round, eliminated, spectating, results, a window open) and which elements show in each.
- Check every pair that can be visible at the same moment, on the smallest phone with touch controls showing.
- After adding a state, re-run the device matrix (§11.8) for the states it touches, not just the screen you edited.

### 11.6 Windows, text and touch targets on small screens

- **Fit windows to the usable area:** the viewport minus the top inset and any reserved columns, not the whole screen.
- **Measure rendered sizes:** a single scale-to-fit factor shrinks every target and font together. A 900×580 window fitted to an 844×390 phone renders at roughly 0.6×, so a 58-pixel close button becomes about 34 pixels and 18-pixel text about 11. Check `AbsoluteSize` and the rendered text size at the smallest supported screen, not the authored values.
- **Reflow instead of shrinking:** when the scaled result is too small, use fewer grid columns, move a side preview into a detail view, stack tabs horizontally, scroll a `ScrollingFrame`, or put rarely used options one level deeper (progressive disclosure). Shrink decoration before you shrink tap targets.
- **Size text from real measurements:** use `TextService:GetTextBoundsAsync` with `GetTextBoundsParams.Font` set to the label's `FontFace`; the legacy `GetTextSize` takes a `Font` enum and can mis-size `FontFace` text. Leave room for `UIStroke`. Wrap to a second line rather than truncating or `TextScaled` shrinking.
- **`CanvasGroup` clips its descendants** to its bounds. An outline or shadow drawn outside the group's box is cut off, so inset the content inside the group.
- **Preload images through instances:** `ContentProvider:PreloadAsync` documents its list as instances to load. Pass image-bearing instances (for example `ImageLabel`s holding the ids), then check each asset's `Enum.AssetFetchStatus` in the callback. A failed or moderated image silently renders as nothing.

### 11.7 Console and TV

From Roblox's console guidelines and the `GuiService` reference:

- **Design for 8–10 feet away:** develop for lower resolutions first, scale with relative sizes and `UISizeConstraint`, and use `GuiService.ViewportDisplaySize == Enum.DisplaySize.Large` (most TVs) to decide when to scale text and targets up.
- **Keep content in the TV-safe area:** some TVs crop the edges, so inset interactive and important UI from every edge. Pick a margin and verify it on an actual TV.
- **Don't use `GuiService:IsTenFootInterface()` to detect a console.** It is deprecated and hardcoded to `true` on consoles regardless of how the player is interacting. Use `ViewportDisplaySize` for layout and `UserInputService.PreferredInput` for controls.
- **Disable the chat window** for console games.
- **Navigation:** every element must be reachable with the four directions plus select and back. Key actions should take only a few presses. Use progressive disclosure: go in and out of screens rather than fitting everything on one.
- **Button prompts must match the controller:** see `roblox-input` for `GetStringForKeyCode`, `GetImageForKeyCode` and `InputActionLabel`.
- **Accessibility:** respect `GuiService.PreferredTextSize` and `GuiService.ReducedMotionEnabled`.
- **Content maturity:** console releases need content maturity information.

### 11.8 Cross-device verification

Studio's **Device Simulator** switches the screen, platform and hardware your experience believes it's running on. Phone, tablet and console presets apply real safe areas and pixel densities, and the setting can change mid-playtest. **Controller Emulator** (Emulation tab) supplies Xbox and PlayStation gamepads, which you can connect and disconnect mid-session. Selecting a console device switches Controller Emulator to a matching controller.

A practical matrix for every UI change:

- smallest supported phone (667×375 class) with touch controls;
- a mid-range Android phone (about 780×360) and a current iPhone (about 844×390);
- a tablet (1024×768 or 960×600);
- desktop 1920×1080 with mouse;
- console at 1080p and 4K with an Xbox controller, then a PlayStation controller.

Practical notes:

- **Prefer device presets to raw resolution overrides.** Confirm `UserInputService.PreferredInput` is `Touch` before judging a touch layout: touch-only controls hide when the session believes a mouse is in use.
- **Measure, then look.** Read the `AbsolutePosition`/`AbsoluteSize` of the elements that could collide, then take screenshots to judge readability.
- **Test the states, not just the screen** (§11.5): open a window, get eliminated, spectate, show two toasts, open chat, and focus a text box so the on-screen keyboard is up.
- **Test phones at Entry-level pixel density,** and use the simulator's physical-size mode to judge tap targets.
- **Check what the simulator can't fake:** a real phone (thumb reach, the notch) and a real TV (overscan, sofa distance) before calling a release device-tested.

Also test: a long localized string, a missing or delayed asset, respawn and reopening, and low frame rate while a list updates. A layout that looks right at one Studio viewport is not finished.

## Custom loading flow

1. Create the replacement UI from a `LocalScript` in `ReplicatedFirst` before calling `RemoveDefaultLoadingScreen()`.
2. Treat `game:IsLoaded()` and `game.Loaded` as DataModel readiness, not proof that every asset is ready.
3. Use `ContentProvider:PreloadAsync()` only for a bounded critical set, with timeout and fallback behavior.
4. Gate controls and the first playable state explicitly. Do not move the character from the client as a loading lock.
5. Restore any changed controls, CoreGui state, camera state, and temporary connections on success, timeout, cancellation, and respawn.

## UI checklist

- [ ] Containers use layout objects and constraints instead of scattered pixel positions.
- [ ] Text growth, clipping, and scrolling have an explicit policy.
- [ ] Buttons expose disabled and busy states.
- [ ] UI actions are safe to repeat or are debounced.
- [ ] Server responses, not local optimism, determine durable state.
- [ ] Designed on the smallest supported landscape phone first; checked on the device matrix (§11.8) in every state the change touches.
- [ ] Interactive UI sits in `CoreUISafeInsets` (or a deliberate alternative) and clears the thumbstick zone, jump button and top bar by measurement.
- [ ] The interface works with touch, mouse, keyboard, and gamepad where relevant.
- [ ] Gamepad: visible entry focus, a selection boundary, layered Back, and focus restored after rebuilds and on close.
- [ ] All temporary connections, tweens, and rows have an owner lifetime.

## Existing style and visual verification

Follow the project's existing components, typography roles, colors, spacing, and interaction states. Do not impose a genre palette or invent a new design system for one screen. If there is no art direction, make the smallest readable provisional choice and show it to the owner; a working instance tree is not proof that the UI looks right.

Test the actual screen over bright and dark game scenes, not only a blank Studio canvas. Check clipping, contrast, gameplay visibility, and the rendered states that exist (such as active, selected, disabled, or purchase pending). Hover is not available on every input device; focus and touch must still work. Check `GuiService.ReducedMotionEnabled` before adding motion-heavy feedback. Layout and accessibility are engineering checks, not a prescribed visual style.

## Shared styling and flex, when needed

For an existing stylesheet-based project, extend its tokens and rules rather than setting conflicting per-instance properties. Roblox `StyleSheet` rules are attached to a UI tree with `StyleLink`; `StyleQuery` can adapt to size, preferred input, text size, or reduced motion. For a one-off UI, direct properties may be simpler. See the [official styling guide](https://create.roblox.com/docs/ui/styling) before adding a new sheet.

Flex is built into `UIListLayout` (`HorizontalFlex` or `VerticalFlex`); `UIFlexItem` customizes a child. There is no `UIFlexLayout` instance. Use it only when a row or column needs flexible space; otherwise ordinary list/grid layout is simpler. If items spread apart unexpectedly, inspect the layout's flex alignment before adding offsets. Keep `SortOrder = LayoutOrder` and set each child's `LayoutOrder` when order matters. See the [official list/flex guide](https://create.roblox.com/docs/ui/list-flex-layouts).

## Community ecosystem (leads, not sources)

Top-sorted DevForum canon for UI libraries. Verify status in-thread before recommending.

- [TopbarPlus v3](https://devforum.roblox.com/t/topbarplus-v340-construct-topbar-icons-with-ease-customise-them-with-themes-dropdowns-captions-labels-and-more/1017485): the topbar icon standard (4.4k likes).
- [Iris](https://devforum.roblox.com/t/iris-immediate-mode-ui-library-based-on-dear-imgui/2302802): Dear ImGui-style immediate mode, good for debug tools/dev UIs, not player-facing polish.
- [Screen3D](https://devforum.roblox.com/t/screen3d-a-3d-ui-framework-that-just-works/3273671) (2024); [Text+](https://devforum.roblox.com/t/text-custom-fonts-advanced-control/3521684) (2025) custom fonts.
- [Satchel](https://devforum.roblox.com/t/satchel-open-source-modern-backpack-system/2451549): open-source inventory/backpack, study-grade.
- [Vanilla 3](https://devforum.roblox.com/t/vanilla-3-the-pragmatic-icon-set-for-roblox-studio/935745): the pragmatic icon set.
- Chat: BetterChat V3 discontinued; [NovaChat](https://devforum.roblox.com/t/novachat-v107-chat-update-part-2-a-modern-feature-rich-chat-replacement-update/4513813) (2026) is the active replacement line; [ViewportFrame masking](https://devforum.roblox.com/t/viewportframe-masking/2964839) (2024) heavily cited for UI VFX.
- Design theory: [UI Design Starter Guide](https://devforum.roblox.com/t/ui-design-starter-guide/53461) (1.1k likes).
- [Mobile button placement tutorial](https://devforum.roblox.com/t/the-correct-way-to-design-mobile-buttons/2494558) illustrates collisions with the default thumbstick/jump controls and touchscreen-PC detection pitfalls. Treat its coordinates and per-frame script as dated examples, not a portable recipe; test on the game's target devices.

## Pagination (UIPageLayout)

A `UIPageLayout` parented to a `GuiObject` (usually a `Frame`) stacks its children as full-size pages; only the current page is visible. Members: `JumpTo(page)`, `JumpToIndex(index)`, `Next()`, `Previous()`, plus the `CurrentPage` property. Set `Circular = true` for wraparound looping and tune motion with `TweenTime`, `EasingStyle`, `EasingDirection` (`Animated = false` for instant snaps). The layout provides no buttons, so wire input yourself:

```luau
local layout = Instance.new("UIPageLayout")
layout.TweenTime = 0.25
layout.EasingStyle = Enum.EasingStyle.Quad
layout.Parent = pageContainer

nextButton.Activated:Connect(function() layout:Next() end)
prevButton.Activated:Connect(function() layout:Previous() end)
layout.PageEnter:Connect(function(page)
    updateDots(page) -- one dot per child; highlight CurrentPage
end)
```

`PageEnter`/`PageLeave` fire on page transitions and `Stopped` when a tween settles; that is the hook for a page-indicator/paginator pattern. `ScrollWheelInputEnabled`, `TouchInputEnabled`, and `GamepadInputEnabled` control the built-in pan input.

## Selection outlines (SelectionBox)

`SelectionBox` renders a 3D box outline around its `Adornee` (inherited from `InstanceAdornment`); it is purely visual and captures no input. Style with `LineThickness` (studs), `Color3` (outline color, from `GuiBase3d`), and `SurfaceColor3`/`SurfaceTransparency` (faces; surface transparency defaults to 1). Prefer the `Highlight` class when you need fill/outline effects over non-primitive geometry such as `MeshPart`.

```luau
local box = Instance.new("SelectionBox")
box.LineThickness = 0.05
box.Color3 = Color3.new(1, 1, 0)
box.SurfaceTransparency = 1
box.Parent = workspace

local mouse = Players.LocalPlayer:GetMouse()
mouse.Move:Connect(function()
    box.Adornee = mouse.Target -- nil when pointing at nothing
end)
```

## Decals (Decal, Texture)

`Decal` draws a single image on one face of a part (`Face = Enum.NormalId.Front`, etc.). The separate `Texture` class shares face placement and repeats/tiles the image via `StudsPerTileU/V` and `OffsetStudsU/V`; use `Texture` for tiled surfaces and `Decal` for posters and signs. The image property `Texture` (ContentId) is deprecated in favor of `ColorMap`/`ColorMapContent` but still functional. `Transparency`, `Color3`, and `Face` are runtime-writable: tween decals, or swap images in response to gameplay. User-uploaded image assets go through moderation; a failed review renders nothing, so ship a placeholder and handle it.

```luau
local decal = Instance.new("Decal")
decal.Face = Enum.NormalId.Front
decal.Texture = "rbxassetid://699259085"
decal.Parent = part
```

## Video (VideoFrame, VideoPlayer)

`VideoFrame` is the simple path: parent it to a `SurfaceGui` and set `Video` (ContentId) to a video-type asset; image IDs will not play. Control with `Play()`, `Pause()`, `Looped`, and `Volume`; wait for `IsLoaded` (or the `Loaded` event) before playing. `Ended`/`DidLoop` report playback progress.

`VideoPlayer` is the newer wire-based source: set `VideoContent` (Content), then connect `Wire` instances to a `VideoDisplay` inside a `SurfaceGui` for visuals and an `AudioEmitter` for sound. It adds `PlaybackSpeed`, `TimePosition`, `LoadAsync()`, and a `PlayFailed` event for fetch failures. Prefer `VideoFrame` unless you need the video/audio wire split.

```luau
local gui = Instance.new("SurfaceGui")
gui.Parent = screenPart

local video = Instance.new("VideoFrame")
video.Size = UDim2.fromScale(1, 1)
video.Looped = true
video.Video = "rbxassetid://5608359401"
video.Parent = gui

if not video.IsLoaded then
    video.Loaded:Wait()
end
video:Play()
```

## UI state ownership and exposure

- Route automatic opens, world-triggered opens, and manual buttons through the same window controller. Verify open state, close/back handlers, modal input, and focus on every entry path, including after rejoin and during round transitions.
- When temporarily hiding UI, record each affected element's prior state and restore only state still owned by that temporary mode. Do not re-enable every touched screen. Test completion, cancellation, respawn, and overlap with another mode so stale snapshots cannot reopen closed menus or hide a newer screen.
- For timed teaching, define when the instruction counts as exposed. Accrue time only while its intended presentation is actually available; pause or cancel deliberately behind menus, death screens, or other hiding states. Test hide/resume and verify the player receives the intended visible duration.
- Separate structural placement from active-input affordances. Update buttons, reticles, and hints for the current input without making navigation jump between opposite screen edges on hybrid input changes. Test input switching, controller connection, viewport changes, and an already-open window independently.
- Coalesce repeated updates for one countdown or event into an owned presentation rather than spawning a new toast for every tick. Bound simultaneous notices and verify a new urgent message remains readable while an existing countdown updates. Choose presentation density for the actual gameplay phase.
