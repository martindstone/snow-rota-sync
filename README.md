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
| `pagerduty_sync_script_action.js` | Script Action | System Policy > Events > Script Actions. Also requires an Event Registry entry (see comment at the top of the file) named `pagerduty_sync.requested`. |
| `ui_action_sync_all.js` | UI Action | System Definition > UI Actions. See the comment header in the file for exact field settings. |
| `ui_action_sync_this.js` | UI Action | Same, but create it on `cmn_rota` and (optionally) again on `sys_user_group`. |
| `business_rules_mark_pending.js` | Business Rules (x5) | System Definition > Business Rules, one per source table (see the file header). They only mark the group pending -- they never call PagerDuty -- so they're safe to leave active. |
| `scheduled_job_process_pending_syncs.js` | Scheduled Jobs (x2) | System Definition > Scheduled Jobs. The every-minute job does the actual syncing (**leave inactive until validated**); the nightly one marks every group pending. |
| `ui_action_export_oncall_config.js` | UI Action | System Definition > UI Actions, on `sys_user_group`. Independent of the rest of this port -- doesn't require enrollment, doesn't call `PagerDutySync` at all. A one-click way for a non-technical group owner to hand you their group's full on-call config (all four source tables, raw/unparsed) as a single JSON file attached to their Group record, instead of walking them through table names and dot-walked list filters. **Narrower than `export_oncall_config.txt` below** -- doesn't yet pull `cmn_rota_member.rotation_schedule` or the extra `cmn_rota_roster` day-of-week/payload fields; update it to match if you need those from a UI-Action-driven export too. |
| `export_oncall_config.txt` | Standalone script | A Python script saved as `.txt` so mail filters let it through -- rename to `.py` to run it. Not installed in ServiceNow at all -- runs on whoever's own machine, against their own instance, with their own credentials (never shared with whoever's asking for the export). Same read-only export as the UI Action above, plus `cmn_rota_member.rotation_schedule` (ServiceNow's own system-generated per-member on-call computation -- see the script's docstring), the extra `cmn_rota_roster` day-of-week/payload fields, who each span is *for* and what it overrides (`user`/`parent`/`show_as`/`notes`), each rota's `based_on` calendar, an `other_schedules` sweep of everything else attached to the group's rotas/rosters/members, and a `roster_schedule_spans` / `roster_schedule_span_proposals` sweep -- `roster_schedule_span` ("Roster Schedule Entry", a `cmn_schedule_span` subclass keyed by `roster`, or by `group` for time off, and living on the covering *user's* schedule rather than any rota's) is where ServiceNow stores one-off "Provide coverage" shifts (`type=on_call`, shown in its calendar as "<user> (<roster> Coverage)") and time off, so none of the schedule-based queries can see them. PagerDutySync syncs the one-off `type=on_call` coverage spans as v3 overrides (see "Coverage overrides" below); time off is still not synced. That sweep degrades to a warning if the account can't read those tables. Stdlib only, nothing to `pip install`. See its own docstring for usage. |

None of these files are meant to be uploaded/imported directly (there's no Update Set
here) -- copy each script body into the corresponding record type, using the settings
documented below and in the script file's header.

## Which groups get managed

Enrollment is indicated by the presence of a `sys_user_group` in a small table:

| Table | `u_pagerduty_sync_group` (Global scope) |
|---|---|
| Field | `u_group` -- Reference to `sys_user_group`, **Mandatory**, **Unique** |

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
separate queue table. Add these columns (all Global scope, none mandatory):

| Column | Type | Meaning |
|---|---|---|
| `u_pending_since` | Date/Time | When the first un-synced change arrived. Empty = nothing waiting. |
| `u_last_change` | Date/Time | When the most recent change arrived (what the quiet period waits on). |
| `u_running_since` | Date/Time | Lock. Empty = not syncing; a lock older than 15 min is treated as stale. |
| `u_claim_token` | String (40) | Confirms which run won the lock. Hide it from forms. |
| `u_retry_after` | Date/Time | Backoff after a failure. Empty = no backoff. |
| `u_last_attempt` | Date/Time | When the last sync started. |
| `u_last_result` | Choice: `success`, `failed`, `skipped` | Outcome of the last attempt. |
| `u_last_message` | String (4000) | Error text, or a one-line summary of what was written. |
| `u_last_success` | Date/Time | When the last successful sync finished. |
| `u_consecutive_failures` | Integer | Drives the retry backoff. Reset to 0 on success. |

Turn on **Audit** for `u_last_result`, `u_last_message` and `u_last_success` if you
want a history of syncs for free. `PagerDutySync` logs an error and does nothing if
any column is missing, rather than silently ignoring writes to it.

How it works:

1. The five Business Rules in `business_rules_mark_pending.js` call
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
on-call computation -- see `export_oncall_config.txt`'s docstring) as independent
ground truth: 0 regressions, 15 confirmed real fixes (only 2 of which had been
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

The array-rotation approach above (`_rotationMemberOffset`/the date-math branches
in `_rotationAlignment`) estimates who's first by recomputing occurrence-count
from `rotation_start_date` using the roster's *current* member count and order
values -- implicitly assuming that count has never changed. **It isn't a safe
assumption.** Reported live by a customer: after adding a member to Major
Incident's NA/EMEA Primary rosters and resyncing, the new member showed up in
PagerDuty "in a different order" than ServiceNow.

Read ServiceNow's actual on-call engine to understand why
(`OnCallRosterSNC.getActiveMembersOrdered`, fired synchronously by a business
rule -- `Update Rotation Schedules (Member)`/`(Roster)` -- whenever roster
membership changes): it does **not** recompute the whole rotation's history when
a member is added or removed. It finds whoever was on call the day before, then
continues the round-robin from there -- the next member is whichever remaining
member has the next-higher `order` value, wrapping around. Nothing before the
edit is touched. That's a fundamentally different algorithm from "occurrence-count
mod current N," and the two only coincide when the roster's member count has been
constant since `rotation_start_date` -- which a real "someone joined/left" edit
is, by definition, exactly the case where it hasn't.

Confirmed live on a PDI both ways: adding a 3rd member to a static 2-member
weekly roster (Hardware US Primary, unchanged since 2018) happened to coincide
with what the date-math estimate would have predicted (a coincidence of that
roster's specific parity, not a general guarantee) -- and, separately, a unit
test that deliberately forces the two to disagree, plus a full live rerun of the
same 3rd-member experiment through the real deployed sync, confirmed the fix
reproduces ServiceNow's actual answer (`David` through Sep 27, `Fred` Sep
28-Oct 4, `Beth` Oct 5-11, `David` again from Oct 12) rather than the old
estimate.

**The fix**: before falling back to date-math, `_rotationAlignment` asks
ServiceNow directly, via whichever of its two on-call engines the rota is
actually on (see "The 2024 schedule engine" below for the second one).
On the older engine, `_groundTruthMemberIndex` checks each active member's own
`cmn_rota_member.rotation_schedule` (the same live, system-computed schedule
already used as this file's own validation ground truth, and by ServiceNow's own
resolver -- `OnCallRotationSNC._checkForOverrideMemberByRoster` evaluates the
same table the same way) via `GlideSchedule.isInSchedule`, to find who
ServiceNow really has on call *right now* (`asOf`, the sync's own run time --
see below for why not `rotation_start_date`). `_offsetForGroundTruth` then
back-solves the array rotation that reproduces that member in the matching
PagerDuty slot. Time off and "Provide coverage" do **not** disturb this lookup
(tested live on a PDI, both engines, with `fix_script_pc_timeoff_ground_truth.txt`):
the pick stayed the same user at the same instant with a coverage span or a
time-off span for the on-call member in place. On the 2024 engine a coverage span
comes back as its own `roster_schedule_span` override row, which the
`table === 'cmn_rota_member'` filter drops, and time off comes back as a separate
`timeoff` row while the member's own `cmn_rota_member` span stays in place -- so the
lookup reports the *nominal* rotation, not a substitute. (ServiceNow does split the
member's span where the coverage or time-off interval ends; same user, harmless.) On
the old engine neither showed up in `getSpans()` at all. One gap: a time-off span
inserted by script did not appear on the old engine even after its schedules were
regenerated, so time off created through the UI on an old-engine rota is not
confirmed -- it was not observed to move the pick either.

**Why `asOf` ("now"), not `rotation_start_date`:** after a membership change,
ServiceNow caps the *old* segment's `repeat_until` at the date of the edit and
starts a new, open-ended segment from there -- so a historical anchor date can
fall inside a since-capped segment that no longer evaluates as "on call" at
all, while "now" is always inside whichever segment is currently open.

**Falls back** to the pre-existing date-math estimate when no ground-truth
source resolves anything -- a brand-new roster ServiceNow hasn't computed a
schedule for yet, a `GlideSchedule`/JSON-parse error, or (old engine only) no
active member has an evaluable `rotation_schedule` -- logged, not silent. When
ground truth *is* found but disagrees with what the date-math estimate would
have said, that disagreement is logged too (a useful signal that a roster's
membership has changed since `rotation_start_date`).

**Scope**: only the plain one-roster-per-event path (`_buildEvent`, used by
every classification shape for an ordinary roster). Deliberately not applied to
`_buildAlternatingEvent` or `_buildEveryMemberEvent` -- both already build their
member order from something other than a single roster's own rotation math (see
above for why `_buildAlternatingEvent` doesn't use `rotation_start_date` at
all), so there's no single roster's ground truth that would be the right one to
check.

#### The 2024 schedule engine

ServiceNow has **two** separate on-call computation systems, selected per rota
by `cmn_rota.schedule_engine`. The older one (blank/`old_schedule_engine`,
everything above this subsection) materializes each member's own turns into
`cmn_rota_member.rotation_schedule`. The newer one (`2024_schedule_engine`)
**never populates that field at all** -- confirmed against a real customer
instance: every member of every roster in an entire group (`Major Incident
(Global)`) had `rotation_schedule` permanently `null`, even though ServiceNow's
own on-call calendar for those rosters clearly rendered a working rotation.
Its ground truth lives in `cmn_rota_roster.rotation_payload` instead -- a JSON
field with no public ServiceNow documentation; its shape here was
reverse-engineered from a real customer's own live payload and confirmed
correct against three dates they independently reported seeing on ServiceNow's
own calendar:

```
{ "memberPlans": {
    "member_sys_ids": [<cmn_rota_member sys_id>, ...],
    "plans": [{"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"|null,
               "members_in_order": [<index into member_sys_ids>, ...]}, ...] },
  "memberSpanCache": { "spans": [
    ["YYYY-MM-DD HH:MM:SS", "YYYY-MM-DD HH:MM:SS", <index into member_sys_ids>], ...
  ] } }
```

`_groundTruthMemberIndexNewEngine`/`_newEngineMemberSysIdAt` read this in two
tiers: **(1)** `memberSpanCache.spans` is a literal, ServiceNow-computed
day-by-day answer covering roughly the next ~10 days -- exact, used whenever it
covers `asOf`. **(2)** past the cache's end, extrapolate forward in whole
shift-blocks from the *start* of the cache's final member's block (not its last
cached day -- the cache is per-day, so its last entry can land exactly on a
block's last day, which undercounts by a whole block if used directly as the
anchor; found and fixed via a unit test built from the real payload below)
through whichever `plans[]` entry currently applies.

**Confirmed by decoding a real customer's actual `rotation_payload`** (Major
Incident (Global) / NA / Primary, captured live) against what they
independently reported ServiceNow's calendar showing after adding a member
(Bruno starting Sep 28, Miguel Oct 5, Eduardo Oct 12 -- both tiers reproduce all
three exactly) that this engine's real algorithm, unlike the old engine's, does
**not** let a member's current turn run to its natural end before inserting a
newly-added member -- it hands off to "next by order" *immediately* at the
moment of the edit, truncating whoever was mid-turn, and only settles into a
clean, full-length round-robin from the next block boundary onward. That's a
genuinely different algorithm from the old engine's continuity rule above, not
a variant of it -- confirmed by hand-decoding the real payload's two `plans[]`
entries (a 4-day truncated first block, then a 3-day makeup block, then clean
7-day blocks from there), not inferred.

Which engine a rota is on isn't visible from `cmn_rota.schedule_engine` alone
if an instance-wide property forces one engine for everything --
`isShiftOnOldEngine`/`isShiftOnNewEngine` in ServiceNow's own
`OnCallRotationSNC` check `gs.getProperty('com.snc.on_call_rotation.
force_use_schedule_engine')` before falling back to the field. Not read by this
port; `rotaRow.schedule_engine` reflects the field only.

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

## One-time setup

1. **Script Include**: create `PagerDutySync` from `PagerDutySync.js`.
2. **Table**: run `fix_script_create_sync_group_table.txt` in Scripts - Background
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
   `fix_script_create_sync_queue_rules_and_jobs.txt` (dry run by default; set
   `DRY_RUN = false` to apply), or create them by hand from `business_rules_mark_pending.js`
   and `scheduled_job_process_pending_syncs.js`. The rules only mark groups pending, so
   they can be Active straight away. Leave the every-minute job **Inactive** until you've validated the UI Action path and
   `fix_script_verify_sync_queue.txt`; activating it is what lets edits reach PagerDuty.

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
- **Ground-truth on-call lookup adds one `GlideSchedule` evaluation per active
  member per roster per sync** (see "Ground-truth on-call lookup" above) -- not
  expected to be significant next to the PagerDuty API calls a sync already
  makes, but not separately measured against a large roster (e.g. Americas'
  14-member Primary/Secondary) either.
- **2024-schedule-engine ground truth (`rotation_payload`) doesn't check the
  `com.snc.on_call_rotation.force_use_schedule_engine` system property** -- if
  an instance forces every rota onto one engine regardless of its own
  `schedule_engine` field, `rotaRow.schedule_engine` (read from the field only)
  can disagree with which engine actually computed that rota, and ground truth
  is tried against the wrong one (falls back to date-math either way, not
  silently wrong, but not the fix either). Not known to be the case on the one
  customer instance this was built against.
- **`rotation_payload`'s tier-2 extrapolation (past `memberSpanCache`'s ~10-day
  window) assumes a clean, unchanging round-robin from the last cached block
  onward** -- correct once the transition period a membership change causes is
  over (which the cache itself, built after the edit, already covers), but a
  *second* membership change made after the last sync -- and after
  `rotation_payload`'s own cache goes stale -- before the next one runs would
  not be reflected; the extrapolation has no way to know about it. Re-running
  the sync soon after such a change (so `asOf` falls inside ServiceNow's own
  freshly-rebuilt cache window, tier 1) sidesteps this.
