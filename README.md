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
  work than the single-field lookup `individual` needed. If a group's rotas
  disagree on `catch_all` type across regions, `group_manager` wins over
  `individual` (matching this function's pre-existing single-winner behavior);
  `catch_all_wait_time` (falls back to a 30-minute default when blank) sets the
  delay for whichever rule gets built.
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
