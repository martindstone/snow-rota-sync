# PagerDuty Sync -- ServiceNow-native port

Reads on-call config (`cmn_rota`/`cmn_rota_roster`/`cmn_rota_member`/`cmn_schedule_span`)
for enrolled groups and pushes it to PagerDuty as schedules + escalation policies,
built against PagerDuty's v3 "shift-based schedules" API (`schedules` -> `rotations`
-> `events`, RFC 5545 recurrence). All outbound HTTP goes through the officially
installed app's `x_pd_integration.PagerDuty_REST` Script Include, so this only works
on an instance that already has that app installed and configured.

## What's in this repo

| File | Record type | Where it lives |
|---|---|---|
| `PagerDutySync.js` | Script Include | System Definition > Script Includes. Name it `PagerDutySync`, uncheck "Client callable" (server-only), set Accessible from per your scope policy. |
| `pagerduty_sync_script_action.js` | Script Action | System Policy > Events > Script Actions. Also requires an Event Registry entry (see comment at the top of the file) named `pagerduty_sync.requested`. Handles manual syncs. |
| `ui_action_sync_all.js` | UI Action | System Definition > UI Actions. See the comment header in the file for exact field settings. |
| `ui_action_sync_this.js` | UI Action | Same, but create it on `cmn_rota` and (optionally) again on `sys_user_group`. |
| `ui_action_export_oncall_config.js` | UI Action | System Definition > UI Actions, on `sys_user_group`. Independent of the rest of this port -- doesn't require enrollment and doesn't call `PagerDutySync`. A one-click way for a non-technical group owner to hand you their group's on-call config (`cmn_rota`, `cmn_rota_roster`, `cmn_rota_member`, `cmn_schedule_span`; raw, unparsed, raw and display values) as a single JSON file attached to their Group record. |
| `business_rules_mark_pending.js` | Business Rules (x5) | System Definition > Business Rules, one per source table. Reference copy of the rule script and settings; `fix_script_create_sync_queue_rules_and_jobs.js` creates the same rules. |
| `scheduled_job_process_pending_syncs.js` | Scheduled Jobs (x2) | System Definition > Scheduled Jobs. Reference copy of the two jobs; the same fix script creates them. |
| `fix_script_create_sync_group_table.js` | Background script | Creates the enrollment/sync-state table. See "Fix scripts". |
| `fix_script_create_sync_queue_rules_and_jobs.js` | Background script | Creates the Business Rules and Scheduled Jobs for the debounced queue. See "Fix scripts". |

None of these files are meant to be uploaded/imported directly (there's no Update Set
here). The two `fix_script_*` files are pasted into **Scripts - Background** and create
records for you; for the rest, copy each script body into the corresponding record type,
using the settings in the file's header comment.

## Fix scripts

Two Scripts - Background (Global scope) scripts create the tables and rules this port
needs, so none of that is built by hand. Both follow the same conventions:

- **`DRY_RUN = true` by default.** A dry run only prints what it *would* do; set it to
  `false` at the top of the script and run again to apply.
- **Safe to re-run.** Every step checks first; something that already exists is reported
  and left exactly as it is. Neither script edits or deletes anything.
- Both finish with a verification step (when applied) that confirms the records exist.

### `fix_script_create_sync_group_table.js`

Creates the `u_pagerduty_sync_group` table ("PagerDuty Sync Group"; not extendable, admin-only
by default -- add ACLs/roles to taste) and every column in the tables below. If the table
already exists (e.g. you made it by hand with just `u_group`) it adds only the missing columns.
It also creates a `before` insert/update Business Rule, "PagerDuty Sync Group - Unique Group",
that rejects a second row for the same group. After applying, it checks that `GlideRecord` can see every column; if it can't, the table cache
may need a moment -- re-run to re-check.

Not covered: a form/list layout. Configure one (at minimum `u_group` and the `u_last_*`
columns) and hide `u_claim_token`. Then add one row per group to manage.

### `fix_script_create_sync_queue_rules_and_jobs.js`

Creates the debounced-sync-queue plumbing (see "Debounced sync queue"). Records are matched
by name.

Business Rules (`sys_script`) -- all `before` insert/update/delete, order 100, Active, advanced.
They only call `markPendingForRecord(current, previous)`, never PagerDuty, so they are safe to
leave active:

| Name | Table | Condition |
|---|---|---|
| PagerDuty Sync Pending - Rota | `cmn_rota` | |
| PagerDuty Sync Pending - Roster | `cmn_rota_roster` | |
| PagerDuty Sync Pending - Member | `cmn_rota_member` | |
| PagerDuty Sync Pending - Schedule Span | `cmn_schedule_span` | |
| PagerDuty Sync Pending - Coverage | `roster_schedule_span` | `type=on_call` |

Scheduled Jobs (`sysauto_script`):

| Name | Runs | Script | Created |
|---|---|---|---|
| PagerDuty Sync - Process Pending | every minute | `new global.PagerDutySync().processPending();` | **Inactive** -- activating it is what lets edits reach PagerDuty |
| PagerDuty Sync - Nightly Catch-All | daily at `NIGHTLY_RUN_TIME` (default `02:00:00`, in the job's time zone setting) | `new global.PagerDutySync().markAllPending();` | Active (only marks groups pending) |

The scripts call `global.PagerDutySync` and the records are created explicitly in Global scope, so they work whatever application scope your session is in (a job created while the PagerDuty app's scope was selected fails with "PagerDutySync undefined, maybe missing global qualifier").

Requires `PagerDutySync` (v23+) and the sync-state columns to exist before the rules are
useful, though creating the records doesn't depend on them.

## Which groups get managed

Enrollment is indicated by the presence of a `sys_user_group` in a small table:

| Table | `u_pagerduty_sync_group` ("PagerDuty Sync Group", Global scope) |
|---|---|

| Column | Label | Type | Notes |
|---|---|---|---|
| `u_group` | Group | Reference to `sys_user_group` | **Mandatory**, display column. Kept unique by the Business Rule "PagerDuty Sync Group - Unique Group" (see "Fix scripts"), not a unique index -- ServiceNow won't set the Unique flag over a reference column's automatic index. |

One row per group whose PagerDuty on-call config should be sourced from ServiceNow.
Presence in this table means `PagerDutySync` owns that group's schedules/escalation
policies and will overwrite them on every sync; absence means the group is never
touched, no matter what's in `cmn_rota` for it. This is deliberately opt-in, not
auto-discovered from "any group with a rotation," and separate from the core app's
own `x_pd_integration_pagerduty_schedule`/`x_pd_integration_pagerduty_escalation`
auto-provisioning fields on `sys_user_group`, which is a different mechanism this
port doesn't touch or need to know about.

`PagerDutySync.isEnrolled(groupName)` is the one place that knows what "enrolled"
means -- the Business Rules and contextual UI Action condition scripts call it
directly, so there's a single source of truth.

## Debounced sync queue

`u_pagerduty_sync_group` also carries the per-group sync state, so there is no
separate queue table. `fix_script_create_sync_group_table.js` creates these columns
(all Global scope, none mandatory):

| Column | Label | Type | Meaning |
|---|---|---|---|
| `u_pending_since` | Pending since | Date/Time | When the first un-synced change arrived. Empty = nothing waiting. |
| `u_last_change` | Last change | Date/Time | When the most recent change arrived (what the quiet period waits on). |
| `u_running_since` | Running since | Date/Time | Lock. Empty = not syncing; a lock older than `STALE_LOCK_SECONDS` (15 min) is treated as stale. |
| `u_claim_token` | Claim token | String (40) | Confirms which run won the lock. Internal -- hide it from forms. |
| `u_retry_after` | Retry after | Date/Time | Backoff after a failure. Empty = no backoff. |
| `u_last_attempt` | Last sync attempt | Date/Time | When the last sync started. |
| `u_last_result` | Last sync result | String (40) with choice list: `success`, `failed`, `skipped` | Outcome of the last attempt. Audited. |
| `u_last_message` | Last sync message | String (4000) | Error text, or a one-line summary of what was written. Audited. |
| `u_last_success` | Last successful sync | Date/Time | When the last successful sync finished. Audited. |
| `u_consecutive_failures` | Consecutive failures | Integer | Drives the retry backoff. Reset to 0 on success. |

The script turns on **Audit** for `u_last_result`, `u_last_message` and `u_last_success`,
which gives a history of syncs for free. `PagerDutySync` logs an error and does nothing if
any column is missing, rather than silently ignoring writes to it.

How it works:

1. The five Business Rules (see "Fix scripts") call
   `markPendingForRecord(current, previous)`, which sets `u_last_change` (and
   `u_pending_since`, if empty) on the enrolled group's row. Records of groups that
   aren't enrolled are ignored.
2. The every-minute job calls `processPending()`. A group is *due* once its last
   change is `QUIET_PERIOD_SECONDS` (120) old, or `MAX_WAIT_SECONDS` (600) have
   passed since the first un-synced change (so continuous edits can't defer a sync
   forever), and it is not locked or backing off. Due groups are synced one at a time,
   oldest first, until `MAX_RUN_SECONDS` (240) is used up.
3. Each sync takes the row's lock, runs a live `syncGroup()` inside a `try/catch`, and
   writes `u_last_*`. If anything changed *during* the sync the group stays pending
   and syncs again; otherwise `u_pending_since` is cleared.
4. A failure leaves the group pending and retries after 5, then 15, then 60 minutes
   (`RETRY_BACKOFF_MINUTES`). A fresh edit does not shorten a backoff; a manual sync does.
5. The UI Actions / Script Action (`syncGroupTracked`, `syncAllTracked`) use the same
   lock and history. If a sync of that group is already running, the request is queued
   (marked pending) instead of run concurrently. Dry runs skip all of this.
6. A nightly job marks every enrolled group pending (`markAllPending`) to pick up
   changes no edit announces: a member's `from`/`to` date arriving, a `repeat_until`
   expiring.

Limits: the lock is claim-then-confirm, not a true atomic compare-and-set (ServiceNow
has none), so two runs claiming the same group within a few milliseconds could both
proceed; syncs are idempotent upserts, so the worst case is a redundant sync. The
queue does not delete a PagerDuty schedule when a roster or rota is deleted, and
there are no notifications on failure beyond `u_consecutive_failures` and the system
log -- wire a notification to `u_consecutive_failures >= 3` if you want one.

## Naming convention

Every schedule and escalation policy this port creates or updates gets a
`[ServiceNow Sync v3] ` name prefix and a `description` noting it's managed by this
sync and will be overwritten on the next run. This lets anyone scanning PagerDuty's
UI tell at a glance which objects are ServiceNow-managed (and, since PagerDuty sorts
lists alphabetically, they cluster together), and keeps it distinct from the core
app's own auto-provisioned naming (`SN-<group>` / `SN:<group>`) so the two mechanisms
can't collide if a group is ever under both. Defined once as
`SYNCED_NAME_PREFIX`/`SYNCED_DESCRIPTION` in `PagerDutySync.initialize()`.

A group's escalation policy has **one stable name whatever the group's
classification is**. A `needs_review` group used to get a `... (NEEDS REVIEW)` name
suffix, so any classification change (e.g. a rota losing its coverage window) changed
the policy's identity and a second, duplicate policy was created instead of updating
the first. The flag now lives in the policy's *description* ("NEEDS REVIEW: ...").
Policies created under the old suffixed name are adopted and renamed in place on the
next sync (`_upsertEscalationPolicy` -> `_findByName(..., alternateNames)`); if both
the plain and the suffixed name already exist, the plain one is updated, the other is
left alone, and the log says it looks like a stale duplicate. **Schedules are not yet
covered by this:** follow_the_sun names them by role (`<group> - Primary`), best-effort
by level (`<group> - level 100`), so a classification flip still forks a second set of
schedules -- it just no longer forks the policy or (for expired rotas) happens at all.

## Rotation phase alignment

`cmn_rota_roster.rotation_start_date`/`rotation_start_time` is sent to PagerDuty as
an event's `effective_since`, on the assumption that field controls which member
shows as currently on-call. **It doesn't.** Confirmed against PagerDuty's own v3
API reference for `POST .../events`: `effective_since` is documented as "When this
event starts producing shifts" (a visibility floor) with "past values are clamped
to now" -- and confirmed live, separately, that resyncing an event (which always
gets a fresh `effective_since` stamped to the sync's own run time) does not change
who's actually shown on-call. Phase is governed entirely by `start_time` +
`recurrence`, which this port derives from the coverage window's own span anchor
(`window.anchorUtcIso`) -- a value with no configured relationship to
`rotation_start_date` at all. Nothing forces the two to agree, and in real data
they usually don't (confirmed against a real customer export: two of five regions
in one group landed exactly on a half-cycle boundary -- a permanent, deterministic
member-position swap, not an intermittent glitch).

Fixed by rotating the `assignment_strategy.members` array (in `_buildEvent`, via
`_rotationMemberOffset`/`_rotateForPhase`) by however many shift-blocks separate
the two anchors, so occurrence 0 at `start_time` lines up with whichever member
should really be first as of `rotation_start_date`. A blank `rotation_start_date`
leaves the array unrotated (same "no real anchor to align to" fallback
`_rotationPhaseAnchorIso` already applies to `effective_since`). Deliberately
**not** applied in `_buildAlternatingEvent` (the paired week-on/week-off path) --
that function already anchors purely to the shared coverage window on purpose,
since there's no single side's `rotation_start_date` that would be the "right" one
to pick for a merged pair.

This offset-from-`rotation_start_date` math is now only a *fallback* -- see
"Ground-truth on-call lookup" below for what runs first and why the date-math
estimate alone isn't safe once a roster's membership has ever changed.

Validated two ways before deploying: isolated unit tests against known values
(including the exact case that first surfaced this, and a DST-crossing case that
caught a second bug in an earlier version of the local-date resolution), and an
exhaustive check against a real 8-group/68-roster customer export, using each
member's own `rotation_schedule` (ServiceNow's own system-generated per-member
on-call computation) as independent ground truth: 0 regressions, 15 confirmed real fixes (only 2 of which had been
reported; the rest were latent). The remaining unrotated cases in that export
were all accounted for, not just unverified -- 17 resolved to the
`_buildAlternatingEvent` path (confirmed via matching coverage-window shapes at
the same order value, which is exactly what that function's own pairing detection
looks for) and 1 to an already-diagnosed unrelated data issue (a blank
`cmn_rota_member.member` reference).

**Only the DATE decides whether a roster has a rotation start.** `000000` is a
real time (midnight) -- all-day rotations store exactly that -- so a real
`rotation_start_date` with a `000000` time is used as-is (`_hasRotationStart`,
`_rotationStartTime`). An earlier version treated an all-zero *time* as ServiceNow's
"unset" sentinel too, which silently skipped alignment for every such roster; a
customer's SQLDBA APAC-1 Primary (8 members, real start date, midnight time) came
out exactly one shift-block off because of it -- 14 rosters in that export had the
same shape, and correcting it took the confirmed-fix count from 7 to 15. Only an
all-zero *date* means unset.

### Ground-truth on-call lookup

The array-rotation approach above (the date-math branches in `_rotationAlignment`)
estimates who's first by recomputing occurrence-count from `rotation_start_date`
using the roster's *current* member count and order values -- implicitly assuming
that count has never changed. **It isn't a safe assumption.** Reported live by a
customer: after adding a member to Major Incident's NA/EMEA Primary rosters and
resyncing, the new member showed up in PagerDuty "in a different order" than
ServiceNow.

Read ServiceNow's actual on-call engine to understand why
(`OnCallRosterSNC.getActiveMembersOrdered`, fired synchronously by a business
rule whenever roster membership changes): on the older engine it does **not**
recompute the whole rotation's history when a member is added or removed. It finds
whoever was on call the day before, then continues the round-robin from there --
the next member is whichever remaining member has the next-higher `order`, wrapping
around. That's a fundamentally different algorithm from "occurrence-count mod
current N," and the two only coincide when the member count has been constant since
`rotation_start_date`. (The 2024 engine behaves differently again: it hands off to
"next by order" immediately at the moment of the edit, truncating whoever was
mid-turn.) Either way, date-math alone can't be trusted.

**The fix**: before falling back to date-math, `_rotationAlignment` asks
ServiceNow directly, via `_groundTruthMemberIndex`, who it has on call. That calls
`OCRotationV2.getSpans()` (the same live computation ServiceNow's own on-call
calendar uses, via `_getSpansForRota`) at `asOf` -- the sync's own run time -- and
keeps the `cmn_rota_member` entries. `OCRotationV2` decides internally which
schedule engine the rota is on, so this code never has to. If nothing is on call at
that exact instant (e.g. regions whose coverage windows leave a daily gap),
`_getSpansForRotaForward` searches the nearest *future* occurrence instead -- forward
only, since a past read risks predating a membership change, while anything ServiceNow
reports about the future is computed fresh. `_offsetForGroundTruth` then back-solves
the array rotation that reproduces that member in the matching PagerDuty slot.
Results are memoized per (rota, instant) per `PagerDutySync` instance.

Two earlier approaches were tried and dropped: reading each member's
`cmn_rota_member.rotation_schedule` through `GlideSchedule` (can silently answer
wrong, and is permanently `null` on 2024-engine rotas), and reading
`cmn_rota_roster.rotation_payload` (a write-on-compute cache that isn't durably
persisted, so a cold read usually sees it blank).

Time off and "Provide coverage" do **not** disturb this lookup (tested live on a PDI,
both engines): the pick stayed the same user at the same instant with a coverage
span or a time-off span for the on-call member in place. Coverage comes back as its
own `roster_schedule_span` row, which the `table === 'cmn_rota_member'` filter drops,
and time off as a separate `timeoff` row while the member's own `cmn_rota_member`
span stays in place -- so the lookup reports the *nominal* rotation, not a
substitute. One gap: on the old engine a time-off span inserted by script did not
appear even after its schedules were regenerated, so time off created through the UI
on an old-engine rota is not confirmed -- it was not observed to move the pick either.

**Falls back** to the date-math estimate when `getSpans()` resolves nothing for the
roster (a brand-new roster with no computed schedule, an error, or an on-call user who
isn't among the roster's active members) -- logged, not silent. When ground truth
*is* found but disagrees with the date-math estimate, that disagreement is logged too
(a useful signal that membership has changed since `rotation_start_date`).

**Scope**: only the plain one-roster-per-event path (`_buildEvent`). Deliberately not
applied to `_buildAlternatingEvent` or `_buildEveryMemberEvent` -- both build member
order from something other than a single roster's own rotation math, so there is no
single roster's ground truth that would be the right one to check.

### Handoff weekday (`dow_for_rotate`)

Rotating the array changes who is first, not which weekday a handoff lands on --
that comes from `start_time`'s weekday. The roster form's **"Day of week for
rotation"** (`cmn_rota_roster.dow_for_rotate`, 1=Mon..7=Sun; the sibling
`rotation_start_dow` is a constant `1` and is ignored) is the weekday ServiceNow
actually hands off on. Confirmed by experiment on a PDI: with a Wednesday
`rotation_start_date` and rotate-on Monday, ServiceNow's own per-member schedules
start the first member's turn on the Monday on/before the start date and run
Monday-to-Monday from there -- the first member owns that whole block.

`_rotationAlignment` replaces the plain offset for **weekly-interval rosters whose
window covers every day of the week**: it snaps the block grid to the
`dow_for_rotate` weekday on/before `rotation_start_date`, then moves the event's
`start_time` back by whole local days (DST-safe, via `_shiftAnchorLocalDays`) to the
grid-aligned date at or before the window's own anchor and rotates the members for
the blocks crossed. Blank/invalid `dow_for_rotate` falls back to the start date's own
weekday, i.e. no handoff-day change. The log notes when a `start_time` is moved.

**Scope:** daily-interval rosters and windows restricted to specific days (BYDAY
patterns such as weekdays-only) keep the previous offset-only behavior -- their
handoff weekday is not shifted. Checked offline against a real customer export by
simulating which member/weekday PagerDuty would show at every ServiceNow turn start:
no regressions (111 of 122 turn starts matched before and after; the rest are
pre-existing mismatches unrelated to the weekday), and the one roster whose
configured `dow_for_rotate` differed from the window's anchor weekday (Global
Middleware Support) had its `start_time` weekday moved from Monday to Thursday to
match, with member/turn agreement unchanged.

## Coverage overrides ("Provide coverage")

ServiceNow stores a one-off "Provide coverage" shift as a `roster_schedule_span`
(`type=on_call`, `roster` + `user` set, living on the covering user's own schedule),
so none of the rota/roster queries can see it. Read from ServiceNow's own on-call
resolver (`OnCallRotationSNC._checkForOverrideMemberByRoster`), it is an **override**:
while the span is active, that user *replaces* whoever the roster's rotation says is
on call for that roster -- they need not be a roster member. (Found from a real
customer export: one span, Joy Navarra, on the Major Incident NA Primary roster
for Monday 2026-10-26 12:00:30-21:00:30Z -- exactly one occurrence of the NA window --
created 2026-09-24. She belongs to the EMEA rota, not NA Primary.)

The sync writes each such span as a **v3 override** on the rotation built for that
roster (`POST v3/schedules/{id}/overrides` with `rotation_id` + `overriding_member`).
Confirmed live against PagerDuty: an override replaces the scheduled person during
its overlap with that rotation's shifts and does nothing outside them, so a span
wider or narrower than the rotation window behaves like ServiceNow's. After the
schedule's events are rebuilt, `_reconcileOverrides` lists the schedule's unfinished
overrides and makes them equal the desired set -- creating missing ones, deleting ones
whose span is gone or changed. Verified on a PDI: created, idempotent on a second
sync (it survives the event delete/recreate), and removed when the span was deleted.

- Only spans that haven't ended yet are synced; past ones are ignored (PagerDuty
  won't delete past overrides anyway, and deleting an in-flight one just truncates it
  to now, which the reconcile step ignores).
- **An override added by hand in PagerDuty on a synced schedule is removed on the
  next sync**, same "the sync owns this schedule" rule as its rotations.
- The covering user must have a PagerDuty user with the same email; otherwise the span
  is skipped with a warning (an override to the fallback user would be wrong).
- Failures here are logged and don't abort the group's sync.

**Not synced (each logged as a warning, never silently dropped):**
- `type=time_off` spans. ServiceNow skips the person who is off and pages the *next*
  member in roster order instead; that isn't a plain override and isn't implemented.
- Repeating coverage spans (`repeat_type` set).
- Spans with no roster (a group-wide fallback in ServiceNow).
- Rosters with no rotation of their own in PagerDuty: a single named person, or a
  roster folded into a simultaneous (every_member) event, where an override would
  have to say which member it replaces.

## Architecture notes

- **One schedule per escalation tier, one rotation per logical event within it.** A
  v3 rotation can only hold a single event (one timeline) -- PagerDuty rejects a
  second overlapping event in the same rotation regardless of whether their
  day/time patterns actually conflict, checking only the effective_since/
  effective_until window. So each distinct shift pattern this port needs to express
  gets its own rotation inside the schedule, not its own schedule.
- **`assignment_strategy` replaces two v2-model workarounds natively**:
  `rotating_member_assignment_strategy` (with `shifts_per_member`) expresses
  alternating-team rotations (e.g. week-on/week-off pairs), and
  `every_member_assignment_strategy` expresses "these people should page together."
- **Escalation policies stay on the classic v2 API**; only the schedules they target
  are v3, referenced via `type: 'schedule_v3_reference'`.
- **Every sync ends every active event on a schedule and creates a replacement**,
  rather than patching in place -- v3 only allows changing `effective_until` on an
  already-active event via `PUT`, so a plain in-place update can't reliably apply a
  roster/shape change. Ending (not deleting) keeps the schedule's past. Nothing is
  matched by event name to decide what to keep, so a rename, typo or duplicate name
  can't strand a layer; the replacement goes into the same rotation when one is free
  (preferring one that held the same event name), so rotations don't pile up. Empty
  rotations (leaked layers, no history) are deleted, upcoming overrides first --
  PagerDuty orphans an override whose rotation is deleted and then won't delete it.
  Tradeoffs: no continuity of PagerDuty event id across syncs, and each rotation
  accumulates one ended event per sync (57 in a row worked in testing; no cap found).
  An event is ended by `PUT` with the event body as `GET` returns it; if that fails
  the event is deleted instead.

## Packaging as an update set

Everything is Global scope. The update set is **built from this repo** by the packager (`packager/`, see
`packager/PACKAGER.md`): `npm install` once, then `npm run package` writes `update_set/PagerDuty Sync v<version>.xml`.
Import it via System Update Sets > Retrieved Update Sets > Import Update Set from XML, then Preview and Commit.

It carries the `u_pagerduty_sync_group` table (dictionary, labels, choice list, ACLs, role, menu/module and layouts), the Script
Include, the Script Action and Event Registry entry, six Business Rules (five mark-pending rules plus the unique-group rule), the four
UI Actions (Sync All, Sync This on `cmn_rota` and on `sys_user_group`, Export On-Call Config), and the two Scheduled Jobs
("Process Pending" **Inactive**, "Nightly Catch-All" Active).

- **Scripts** are taken from the top-level `.js` files (`npm run sync-src` copies them into `src/`; `npm test` fails if `src/` is stale).
- **Other settings** live in `src/**/*.yaml`; bump `version` in `src/defaults.yaml` for each release.
- The scheduled-job records are new in the packaged set and **not yet proven by an import**: the earlier export taken from a dev instance
  contained no jobs. If they don't arrive, `fix_script_create_sync_queue_rules_and_jobs.js` (`DRY_RUN = false`) creates them by name.
- After importing, add the enrollment rows (one per group in `u_pagerduty_sync_group`) -- update sets carry the table, not its data.
- `update_set/pagerduty_sync_v24.xml` is the earlier instance-exported set that was already imported successfully on a clean instance;
  keep it until `PagerDuty Sync v24.1.xml` has been imported the same way.
- Activate "Process Pending" only after validating a manual live sync (and `sync.syncAll(true)` dry runs) on the target instance.

## One-time setup

1. **Script Include**: create `PagerDutySync` from `PagerDutySync.js`.
2. **Table**: run `fix_script_create_sync_group_table.js` in Scripts - Background
   (Global scope; it defaults to a dry run -- set `DRY_RUN = false` to apply). It
   creates `u_pagerduty_sync_group` with `u_group` and every sync-state column below, or
   adds only the missing columns to a table you already made by hand. It does not create
   a form/list layout -- configure one, and hide `u_claim_token`. Then add one row per
   group you want this port to manage.
3. **Event Registry entry**: `pagerduty_sync.requested` (System Policy > Events >
   Registry). See the comment in `pagerduty_sync_script_action.js` for the exact
   fields.
4. **Script Action**: create from `pagerduty_sync_script_action.js`, wired to the
   event above.
5. **UI Actions**: create both, using the field settings documented in each file's
   header.
6. **Sync-state columns**: already created by step 2's script (the columns are listed
   under "Debounced sync queue").
7. **Business Rules** and 8. **Scheduled Jobs**: run
   `fix_script_create_sync_queue_rules_and_jobs.js` (dry run by default; set
   `DRY_RUN = false` to apply). The rules only mark groups pending, so they can be Active
   straight away. Leave the every-minute job **Inactive** until you've validated the UI
   Action path with a dry run and a manual live sync; activating it is what lets edits
   reach PagerDuty.

## Recommended verification steps

1. Confirm `u_pagerduty_sync_group` has a row for the group you're about to test --
   `syncGroup()`/`syncAll()` silently skip anything not enrolled.
2. From a Background Script (System Definition > Scripts - Background), run a dry
   run directly, bypassing the event queue for fast iteration:
   ```javascript
   var sync = new PagerDutySync();
   var result = sync.syncGroup('Global OracleDBA ADMIN', true); // true = dry run
   gs.info(JSON.stringify(result, null, 2));
   ```
3. Examine the shape of that output -- which schedules/EPs it says it would
   create vs. update, and the rotations/events/escalation rules inside them.
4. Once a dry run looks right for every group you've enrolled (`sync.syncAll(true)`),
   test the UI Actions end-to-end.

**Every run logs its own version and exact server start time** (`PagerDutySync
syncGroup(...) starting -- version vN-..., server time ...`) as the very first
line, before anything else executes -- so a run's own log always says
unambiguously which copy of this file actually ran and when, independent of a
Script Include's `sys_updated_on` (which reflects when it was last *saved*, not
which version a given run actually executed -- the two can diverge if there's a
stale duplicate Script Include, or a run was kicked off before an edit was
actually saved). `VERSION` (in `initialize()`) is bumped by hand on every real
change to this file -- there's no other version control visible from inside a
customer's instance to check against.

## Coverage window repeat types

`cmn_schedule_span.repeat_type` is a choice field with 10 real values; only some are
readable by `_computeCoverageWindow`'s `days_of_week`/weekly-BYDAY translation, since
that translation only has a representation for a plain "N specific days of the week,
one time-of-day window" shape.

| value | label | supported? |
|---|---|---|
| `daily` | Daily | yes |
| `weekly` | Weekly | yes |
| `weekdays` | Every Weekday (Mon-Fri) | yes |
| `weekends` | Every Weekend (Sat, Sun) | yes |
| `weekMWF` | Every Mon, Wed, Fri | yes |
| `weekTT` | Every Tue, Thu | yes |
| `NULL_OVERRIDE` | Does not repeat | no |
| `monthly` | Monthly | no |
| `yearly` | Yearly | no |
| `specific` | Specific | no |

The "yes" rows are all the same day-of-week-bitmask shape (`_decodeDaysOfWeek` on
`days_of_week`, regardless of which of these six values got the row there -- the
label just reflects which UI preset was clicked, not a different underlying
representation), so they're accepted together in `_computeCoverageWindow`'s
`repeat_type IN (...)` query. **A span whose `repeat_type` isn't in that query is
silently invisible** -- not skipped-with-a-warning, just never read at all -- and
every caller then treats the rota as having no coverage window and substitutes
`_defaultAlwaysOnWindow`'s 24/7-every-day default. Confirmed live: this is exactly
what happened to Hardware (US) (`weekdays`) and, via a second bug
(`MAX_RESTRICTED_WINDOW_HOURS`, see below), Hardware (Weekend) (`weekly` but a
~48.5h span) before both were fixed -- an 8.5h/day window and a weekly Friday
handoff both silently became "on call 24/7, rotating daily," with nothing in the
sync log calling it out.

The "no" rows are a genuinely different shape (month-of-year, day-of-month, or an
explicit date list, not a day-of-week set) that `_decodeDaysOfWeek` and the
weekly-BYDAY RRULE builder (`_rruleForWindow`) have no representation for --
supporting them isn't a one-line query change like the six "yes" values were,
it needs real design work on how a monthly/yearly/one-off pattern maps to a v3
rotation's `recurrence` RRULE. As of this writing, no real on-call rota's schedule
in this instance actually uses `monthly`/`yearly`/`specific`/`NULL_OVERRIDE` --
those three values *do* have real rows in `cmn_schedule_span` elsewhere (20
`yearly`, 1 `monthly`), but only on schedules unrelated to any `cmn_rota` (SLA/
maintenance-window schedules, not on-call), which this sync never reads regardless.

Also worth knowing: `MAX_RESTRICTED_WINDOW_HOURS` (currently 72) caps how long a
single span's computed duration can be before `_computeCoverageWindow` discards it
as probable bad data (misordered start/end producing a nonsensical multi-day
span). A genuinely longer intentional window -- a long-weekend block spanning more
than 3 days, say -- would hit this same silent-discard-to-24/7 failure mode again.

**`repeat_until`**: a real `cmn_schedule_span` field (compact `YYYYMMDD`,
`'00000000'` sentinel for "no end date"). Someone ending a rotation by setting it
in the past (rather than deactivating the rota/roster, which stays `active=true`)
used to have that pattern read as an ongoing recurrence forever. A span whose
`repeat_until` has passed is now excluded, and **a rota whose usable recurring
spans have all expired is dropped from the sync entirely** (`_dropExpiredRotas`,
logged as `skipping rota "<name>": every recurring span ... has a repeat_until in
the past`) -- it is deliberately *not* treated like a rota with no window
configured. The first version of this fix did fall through to
`_defaultAlwaysOnWindow`'s 24/7 default, and a customer's real data showed why
that's wrong: the ended regions kept paging around the clock, *and* a missing
window flips the whole group to `needs_review` (`_classifyGroup`), which used to
rename its escalation policy and schedules and fork a duplicate set in PagerDuty.
Any PagerDuty rotation an expired rota left on a schedule found by name is removed
by `_upsertScheduleV3`'s "no longer produced by this sync" cleanup. If every rota
in a group has expired, the group is left untouched that run (logged as a warning)
rather than pushing an empty policy.

## Custom escalation

`cmn_rota.use_custom_escalation` is read and honored (skip that rota's `catch_all`
entirely when computing `_buildCatchAllRule`), but there is no additional data
behind it to sync. Confirmed via the `cmn_rota` form's UI Policies rather than
guessed: the "Custom Escalation Hide Fields" policy (`use_custom_escalation=true`)
only hides the `catch_all` field -- it's presented as an *alternative* to
`catch_all`, not an additional structured ruleset. The likely-sounding
`cmn_rota_escalation` table is a red herring: it's part of ServiceNow's generic
event-notification framework (fields like `event_name`/`script_name`/`trigger`),
unrelated to on-call rotas, not referenced by `cmn_rota` anywhere, and empty in
this instance. So when a rota has `use_custom_escalation=true`, its real escalation
logic -- whatever it is -- lives entirely outside ServiceNow (a manual process, an
external system, tribal knowledge) and this sync has no data to read for it; the
best it can do, and now does, is not apply a stale/irrelevant `catch_all` value
that ServiceNow's own form no longer surfaces as active configuration once that
checkbox is on.

## Known limitations

- **`cmn_rota.catch_all`**: `group_manager` and `individual` are implemented.
  `all` ("Notify All") is detected and logged but not yet built into a rule -- it
  needs `catch_all_roster`'s members resolved and turned into an
  `every_member_assignment_strategy`-style "page together" target (confirmed via
  the form's own UI Policy that `all` means everyone in one specific,
  explicitly-chosen roster, not the group's whole membership), which is more
  work than the single-field lookup `individual` needed. ServiceNow scopes a
  catch-all to the rota it is configured on (the escalation plan comes from
  whichever rota is in force, and the catch-all step from that rota's own fields
  -- `OCEscalationPathUtilSNC._getCatchAllDetails`). For follow-the-sun groups
  `_buildScopedCatchAllRule` mirrors that: a `<group> - catch-all` schedule with
  one event per catch-all rota, restricted to that rota's coverage window, with
  that rota's catch-all person as sole member; rotas with no catch-all add no
  event, so nobody is paged at that step during their window (e.g. NA =
  `group_manager`, EMEA = none -> manager only during NA hours). Single-region
  and needs-review groups still use the flat always-on `_buildCatchAllRule`
  (single-winner: `group_manager` over `individual`). `catch_all_wait_time`
  (30-minute default when blank) sets the rule's delay; across several
  catch-all rotas in one group the largest wins, since one PagerDuty rule has
  one delay.
- **`GlideScheduleDateTime` is undocumented** (absent from ServiceNow's official
  scoped `GlideDateTime` API reference) but is what `_localizedIso`/
  `_tzOffsetSecondsFromUtc` rely on for DST-aware local-to-UTC conversion, since
  `session.setTimeZoneName()` and `gs.dateDiff()` are both blocked by function
  fencing in this scoped app. A hardcoded `STANDARD_UTC_OFFSET_SECONDS` table
  (standard-time only) is kept as a fallback if it ever throws or misbehaves for a
  given zone.
- **Debounce**: handled by the pending-sync queue on `u_pagerduty_sync_group` (see
  "Debounced sync queue"). A rota moved between groups marks both only if the Business
  Rule sees `previous`; a record whose group can't be resolved (e.g. already deleted) is
  not marked.
- **Event id churn**: every sync gives each managed event a fresh PagerDuty id (see
  "Architecture notes" above) -- nothing downstream should depend on a stable event
  id across syncs.
- **Rate limits**: a full `syncAll()` makes on the order of 10 sequential PagerDuty
  API calls per group. `x_pd_integration.PagerDuty_REST` already retries a 429 up to
  3 times with backoff.
- **PagerDuty's `?query=` search parameter doesn't reliably match names containing
  `[`/`]`** (every name this port creates has brackets, per the naming convention
  above) -- `_findByName`/`_findScheduleV3ByName` don't use it; they page through
  the full list and rely on an exact client-side match instead.
- **Ground-truth on-call lookup adds one `OCRotationV2.getSpans()` call per rota per
  sync** (memoized across that rota's rosters; a second call per roster only when
  nothing is on call at the exact instant) -- not expected to be significant next to the
  PagerDuty API calls a sync already makes, but not separately measured against a large
  rota either.
