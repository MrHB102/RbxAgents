---
name: building
description: >
  Builds and validates Roblox geometry, terrain, reusable models, procedural layouts, and spatial queries. Use when asked to "build a map", "generate terrain", "place procedural props", "fix mesh collisions", "align model pivots", or "find parts in an area".
---

# Roblox Building and World Geometry

## When to use

- Creating a graybox, map region, prop assembly, or procedural layout.
- Configuring parts and MeshParts for interaction and performance.
- Editing terrain with reproducible coordinates and bounded operations.
- Querying world geometry for placement, overlap, or clearance.

## When NOT to use

- Simulating a vehicle or constraint assembly; that belongs to physics.
- Designing light and atmospheric mood; that belongs to lighting.
- Selecting progression routes and difficulty; that belongs to game-design.

## Core instructions

### 1. Establish world-space requirements

1. Record footprint, stud scale, player clearance, style, and interaction requirements.
2. ALWAYS inspect existing geometry, pivots, tags, and collision groups before editing.
3. Identify which objects are authored and which are generated at runtime.
4. NEVER delete unrelated Workspace content or clear all terrain to make room.
5. Create new work under a named Model or Folder with a clear owner.
6. Keep a recoverable snapshot before terrain or large procedural edits.
7. Use deterministic seeds for reproducible procedural content.
8. Verify spawn access, route connectivity, camera clearance, and streaming behavior.

### 2. Build inspectable assemblies

- Use consistent pivots and `Model:PivotTo` for moving complete models.
- Keep decorative parts anchored unless simulation is part of the design.
- Configure CanCollide, CanTouch, and CanQuery according to actual gameplay needs.
- Use MeshParts for appropriate authored geometry; inspect collision shape separately from appearance.
- NEVER assume a visual opening exists in a coarse mesh collision hull.
- Reuse approved meshes and materials before creating many unique assets.
- Preserve asset ownership and permissions for every imported dependency.
- Use collision proxies when detailed visuals do not need detailed collision.

This edit-time generator creates a named graybox with deterministic variation.
It refuses to overwrite an existing result instead of silently deleting other work.

```luau
--!strict
local Workspace = game:GetService("Workspace")
assert(not Workspace:FindFirstChild("GeneratedPlatforms"), "Output already exists")

local random = Random.new(1947)
local model = Instance.new("Model")
model.Name = "GeneratedPlatforms"

for index = 1, 12 do
    local part = Instance.new("Part")
    part.Name = string.format("Platform_%02d", index)
    part.Size = Vector3.new(12, 2, 12)
    part.Anchored = true
    part.Material = Enum.Material.Concrete
    part.Position = Vector3.new(index * 14, random:NextInteger(0, 2), 0)
    part.Parent = model
end

model:SetAttribute("GenerationSeed", 1947)
model.Parent = Workspace
assert(#model:GetChildren() == 12)
```

### 3. Query space instead of scanning the entire world

- Use Workspace:Raycast for a directed intersection.
- Use GetPartBoundsInBox or GetPartBoundsInRadius for broad-phase candidates.
- Use GetPartsInPart when exact shape overlap is required and supported by the geometry.
- ALWAYS configure include/exclude filters and collision-group behavior explicitly.
- Bounding-box queries can include false positives for irregular meshes.
- Exclude the placement preview and the placing player's character.
- Recheck placement on the server before creating an authoritative object.

This server-side clearance helper searches a dedicated placement blocker folder.
Create `Workspace.PlacementBlockers` and put only relevant blocking parts inside it.

```luau
--!strict
local Workspace = game:GetService("Workspace")
local blockers = Workspace:WaitForChild("PlacementBlockers")
local overlap = OverlapParams.new()
overlap.FilterType = Enum.RaycastFilterType.Include
overlap.FilterDescendantsInstances = {blockers}
overlap.MaxParts = 1
overlap.RespectCanCollide = false

local function clearBox(pivot: CFrame, size: Vector3): boolean
    assert(size.X > 0 and size.Y > 0 and size.Z > 0)
    return #Workspace:GetPartBoundsInBox(pivot, size, overlap) == 0
end

local candidate = CFrame.new(0, 5, 0)
local size = Vector3.new(8, 8, 8)
print("Placement clear", clearBox(candidate, size))
```

### 4. Edit terrain within an explicit region

- Use Terrain:FillBlock, FillBall, or voxel operations for bounded changes.
- Voxel regions MUST align to the supported grid resolution.
- NEVER read, modify, and rewrite a huge terrain region for a small local change.
- Budget voxel array memory before constructing large nested tables.
- Preserve existing terrain materials and occupancy outside the requested area.
- Keep water surfaces, shore traversal, and character collision in the review.
- Test terrain operations in a disposable staging place before applying them to valuable work.

This edit-time sample stamps a small grass foundation in a designated staging area.
It intentionally modifies terrain; choose coordinates and save a snapshot first.
The size assertion limits accidental expansion from a bad parameter.

```luau
--!strict
local Workspace = game:GetService("Workspace")
local RunService = game:GetService("RunService")
assert(RunService:IsStudio(), "Terrain authoring sample is Studio-only")

local terrain = Workspace.Terrain
local center = Vector3.new(512, -8, 512)
local size = Vector3.new(64, 16, 64)
assert(size.X <= 64 and size.Y <= 16 and size.Z <= 64)

terrain:FillBlock(CFrame.new(center), size, Enum.Material.Grass)

local region = Region3.new(center - size / 2, center + size / 2):ExpandToGrid(4)
local materials, occupancy = terrain:ReadVoxels(region, 4)
assert(#materials > 0 and #occupancy > 0)
print("Terrain stamp inspected at", center)
```

### 5. Review playable and operational quality

- Walk and jump through the build with the intended avatar dimensions.
- Check invisible collision, trapped corners, thin floors, and unanchored pieces.
- Test streaming near region boundaries and important interactions.
- Inspect draw calls, texture memory, part count, and physics cost at representative scale.
- Use tags or attributes for gameplay discovery rather than fragile repeated name scans.
- Record generated seed, bounds, and cleanup ownership for runtime generators.
- A generated model MUST have a bounded lifetime or an explicit permanent owner.
- Test a second generation run to verify collision and overwrite behavior.

## Common mistakes

- Clearing Workspace before generating; create a scoped result and preserve unrelated objects.
- Moving model children individually; use a stable pivot and PivotTo.
- Trusting mesh visuals for collision; inspect the collision shape and add proxies if needed.
- Scanning every descendant for placement; use bounded spatial queries with filters.
- Running terrain writes with unchecked dimensions; validate bounds and back up the affected area.

## Reference

- [Terrain](https://create.roblox.com/docs/reference/engine/classes/Terrain).
- [Workspace spatial queries](https://create.roblox.com/docs/reference/engine/classes/WorldRoot).
- [Model pivots](https://create.roblox.com/docs/studio/pivot-tools).
