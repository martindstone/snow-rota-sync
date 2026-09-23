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
