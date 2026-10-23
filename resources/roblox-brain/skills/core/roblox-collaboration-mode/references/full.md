# Collaboration Mode: Worked Examples

Illustrative scenarios for calibrating peer vs autonomous mode and bravery
calls. Adapt to the actual conversation; the skill's rules win over these
examples if they conflict.

## Mode inference

| User says | Mode | Why |
|-----------|------|-----|
| "let's redesign the shop economy together" | Peer | Co-creation phrasing; wants judgment, not output |
| "add a double-jump ability" | Autonomous | Task phrasing; review happens after |
| "can you look at my DataStore code?" | Peer (review) | Asking for assessment; do not rewrite unasked |
| "fix the bugs then push the update" | Autonomous + approval gate | Implementation is autonomous; publishing stays gated |

Mixed requests ("build the leaderboard, and I want to discuss the reward
curve"): split explicitly. Build autonomously, discuss in peer mode.

## Bravery calls

**Low risk, just do it:** renaming `part1` to `LobbyDoor`, rewording a tooltip,
moving parts into a folder. Mention in the summary; no pre-approval.

**Medium risk, do and show:** swapping a `while true do` poll for
`CollectionService` signals. Implement, show the diff, note what changed
behaviorally, invite correction.

**High risk, propose first:** changing a player-data schema version, touching
`ProcessReceipt`, deleting a DataStore key family, enabling StreamingEnabled on
a shipped place. Write a short proposal with the rollback story and wait.

## Process examples

**Asking once, early:** the user says "make saves faster" but the game has two
competing save paths. One concrete question up front ("which path should own
saves: A or B?") beats three silent assumptions or five questions.

**Stating assumptions:** "I assumed coins are the only persisted currency."
One line; the user corrects cheaply if wrong.

**Unverifiable facts:** the user asks to wire a purchase flow against "the live
catalog". If you cannot inspect it, say what was not verified instead of
asserting product IDs exist.

**Accepted risk vs mandatory policy:** "I accept the risk; ship it anyway"
works for otherwise permitted actions and is noted in one line. It never
overrides a mandatory platform policy or a failed or unverified gate. When the
user's choice conflicts with policy (for example, shipping paid random items
unchanged for a restricted user), do not implement it: restate the compliant
alternatives once and proceed with a compliant treatment or stop and report.

## Checkable collaboration rules

### Start from the current brief and state

- Load the collaboration skill and applicable domain skills before planning or editing. Extract their task-specific acceptance checks; record the evidence for each applicable check before reporting completion. Loading a skill alone does not satisfy it.
- Read the current source, installed state, and latest owner decisions before reopening a task from memory. Distinguish implemented, tested, approved, deferred, rejected, and live work.
- Convert observations into a persistent numbered log before fixes begin. Include positive feedback and approved elements, each deferred item's next action, and any evidence still missing. Reconcile the log with current state at handoff and after context recovery.
- Separate the owner's authority, the agent's current credentials, and the scope of granted authorization. Check authorized project configuration and documented credential stores before asking for a key again; report presence and usability without printing secret values. Carry forward explicit authorization within its actual scope.

### Ground recommendations in evidence

- Label observations, hypotheses, confidence, and the evidence that could change the recommendation. When advice changes, identify the new evidence or the premise that was corrected. Push back on unsupported conclusions; do not increase confidence merely because the owner agrees or disagrees.
- Treat earlier AI analyses as leads. Recheck their source, date, metric definition, and causal interpretation before reusing them.
- Identify whether a reference is a live observation, historical place, partial client/shared code, template, or reconstruction. Cite the actual inspected material; do not infer undocumented server behavior or commercial success from source structure.
- Inspect a named visual reference before claiming fidelity. Compare the result with it; describe intentional departures as interpretation. Access to a reference does not establish permission to reuse its assets.

### Preserve approval while correcting defects

- For a narrow correction, identify the approved baseline and change only the properties needed to fix the defect. Compare before and after on the actual requested surface; preserve accepted layout, composition, effects, and unrelated work.
- After repeated subjective misses, validate one representative implementation against the owner's references before spreading it to related screens or rooms. Record the approved pattern and then check every adapted flow.
- Honor a requested preview checkpoint before upload or replacement. Stop editing a design surface when the owner disapproves it; resume that surface when new direction authorizes work. Continue independently authorized tasks.
- Verify delegated work against the brief and actual installed result. A worker's report or a clean diff cannot establish that the right screen, state, device, or behavior was tested. Keep unmet checks visible instead of reopening approved work or silently dropping observations.
