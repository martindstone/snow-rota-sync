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
| `business_rule_sync_on_change.js` | Business Rule | System Definition > Business Rules, on `cmn_rota`. **Ships inactive.** |
| `fix_script_verify_assumptions.txt`, `fix_script_q6_q7.txt` | Background Script | Read-only diagnostics used during development, not part of the sync path. Safe to ignore/delete. |

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
means -- the Business Rule and contextual UI Action condition scripts call it
directly, so there's a single source of truth.

## Naming convention

Every schedule and escalation policy this port creates or updates gets a
`[ServiceNow Sync v3] ` name prefix and a `description` noting it's managed by this
sync and will be overwritten on the next run. This lets anyone scanning PagerDuty's
UI tell at a glance which objects are ServiceNow-managed (and, since PagerDuty sorts
lists alphabetically, they cluster together), and keeps it distinct from the core
app's own auto-provisioned naming (`SN-<group>` / `SN:<group>`) so the two mechanisms
can't collide if a group is ever under both. Defined once as
`SYNCED_NAME_PREFIX`/`SYNCED_DESCRIPTION` in `PagerDutySync.initialize()`.

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
- **Every sync deletes and recreates every event this port manages**, rather than
  patching in place -- v3 only allows changing `effective_until` on an already-active
  event via `PUT`, so a plain in-place update can't reliably apply a roster/shape
  change. Tradeoff: no continuity of PagerDuty event id across syncs. An event whose
  `effective_until` is already in the past is left alone rather than deleted (v3
  rejects deleting those).

## One-time setup

1. **Script Include**: create `PagerDutySync` from `PagerDutySync.js`.
2. **Table**: create `u_pagerduty_sync_group` in Global scope (System Definition >
   Tables > New) with the single `u_group` field described above, then add one row
   per group you want this port to manage.
3. **Event Registry entry**: `pagerduty_sync.requested` (System Policy > Events >
   Registry). See the comment in `pagerduty_sync_script_action.js` for the exact
   fields.
4. **Script Action**: create from `pagerduty_sync_script_action.js`, wired to the
   event above.
5. **UI Actions**: create both, using the field settings documented in each file's
   header.
6. **Business Rule**: create from `business_rule_sync_on_change.js`. Leave **Active
   unchecked** until you've validated the UI Action path.

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

## Known limitations

- **`cmn_rota.catch_all`**: only the `group_manager` value is implemented. `all`
  ("Notify All") and `individual` ("Notify Individual") are detected and logged but
  not yet built into a rule.
- **`GlideScheduleDateTime` is undocumented** (absent from ServiceNow's official
  scoped `GlideDateTime` API reference) but is what `_localizedIso`/
  `_tzOffsetSecondsFromUtc` rely on for DST-aware local-to-UTC conversion, since
  `session.setTimeZoneName()` and `gs.dateDiff()` are both blocked by function
  fencing in this scoped app. A hardcoded `STANDARD_UTC_OFFSET_SECONDS` table
  (standard-time only) is kept as a fallback if it ever throws or misbehaves for a
  given zone.
- **No debounce** on the Business Rule -- see the note at the bottom of
  `business_rule_sync_on_change.js`.
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
