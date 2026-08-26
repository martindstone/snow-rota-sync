# PagerDuty Sync -- ServiceNow-native port

## What's in this repo

| File | Record type | Where it lives |
|---|---|---|
| `PagerDutySync.js` | Script Include | System Definition > Script Includes. Name it `PagerDutySync`, uncheck "Client callable" (server-only), set Accessible from per your scope policy. |
| `pagerduty_sync_script_action.js` | Script Action | System Policy > Events > Script Actions. Also requires an Event Registry entry (see comment at the top of the file) named `pagerduty_sync.requested`. |
| `ui_action_sync_all.js` | UI Action | System Definition > UI Actions. See the comment header in the file for exact field settings. |
| `ui_action_sync_this.js` | UI Action | Same, but create it on `cmn_rota` and (optionally) again on `sys_user_group`. |
| `business_rule_sync_on_change.js` | Business Rule | System Definition > Business Rules, on `cmn_rota`. **Ships inactive.** |

None of these files are meant to be uploaded/imported directly (there's no Update Set
here) - copy each script body into the corresponding record type, using the settings
documented below and in the script file's header.

## Which groups get managed

Enrollment is indicated by the presence of a `sys_user_group` in a small table:

| Table | `u_pagerduty_sync_group` |
|---|---|
| Field | `u_group` -- Reference to `sys_user_group`, **Mandatory**, **Unique** |

One row per group whose PagerDuty on-call config should be sourced from ServiceNow.
Presence in this table means `PagerDutySync` owns that group's schedules/escalation
policies and will overwrite them on every sync; absence means the group is never
touched, no matter what's in `cmn_rota` for it. This is deliberately opt-in, not
auto-discovered from "any group with a rotation" -- so enrolling a group is always a
specific, visible, reversible (delete the row) decision, and there's no risk of
sweeping in a group already managed some other way (e.g. via the core app's own
`x_pd_integration_pagerduty_schedule`/`x_pd_integration_pagerduty_escalation`
auto-provisioning fields on `sys_user_group`, which is a different, simpler mechanism
this port doesn't touch or need to know about).

`PagerDutySync.isEnrolled(groupName)` is the one place that knows what "enrolled"
means -- the Business Rule and contextual UI Action condition scripts call it
directly, so there's a single source of truth instead of three copies of the same
check.

## Naming convention

Every schedule and escalation policy this port creates or updates gets a
`[ServiceNow Sync] ` name prefix (e.g. `[ServiceNow Sync] Global SQLDBA ADMIN - EMEA -
Primary`) and a `description` noting it's managed by this sync and will be
overwritten. Two reasons: anyone scanning PagerDuty's schedule/EP list can tell at a
glance which objects are ServiceNow-managed (and, since PagerDuty sorts alphabetically,
they cluster together instead of being scattered through the list), and it stays
distinct from the core app's own auto-provisioned naming (`SN-<group>` / `SN:<group>`),
so the two mechanisms can't accidentally collide on name if a group is ever under both.
This is defined once, as `SYNCED_NAME_PREFIX`/`SYNCED_DESCRIPTION` in
`PagerDutySync.initialize()` -- change it there if you want different wording.

## One-time setup

1. **Script Include**: create `PagerDutySync` from `PagerDutySync.js`.
2. **Table**: create `u_pagerduty_sync_group` (System Definition > Tables > New) with
   the single `u_group` field described above, then add one row per group you want
   this port to manage.
3. **Event Registry entry**: `pagerduty_sync.requested` (System Policy > Events >
   Registry). See the comment in `pagerduty_sync_script_action.js` for the exact
   fields.
4. **Script Action**: create from `pagerduty_sync_script_action.js`, wired to the event
   above.
5. **UI Actions**: create both, using the field settings documented in each file's
   header.
6. **Business Rule**: create from `business_rule_sync_on_change.js`. Leave **Active
   unchecked** until you've validated the UI Action path.

## Recommended verification steps

1. Confirm `u_pagerduty_sync_group` has a row for the group you're about to test -
   `syncGroup()`/`syncAll()` silently skip anything not enrolled (see "Which groups
   get managed" above.)
2. From a Background Script (System Definition > Scripts - Background), run a dry run
   directly, bypassing the event queue entirely for fast iteration:
   ```javascript
   var sync = new PagerDutySync();
   var result = sync.syncGroup('Global OracleDBA ADMIN', true); // true = dry run
   gs.info(JSON.stringify(result, null, 2));
   ```
3. Examine the shape of that output - which schedules/EPs it says it would create vs.
   update, and the escalation rules/layers inside them.
4. Once a dry run looks right for every group you've enrolled (`sync.syncAll(true)`),
   test the UI Actions end-to-end.

## Known gaps / things worth double-checking

- **Depends on the official PagerDuty app being installed**: all outbound HTTP goes
  through `x_pd_integration.PagerDuty_REST`, so this port only works on an instance
  that has the official PagerDuty app installed and configured -- it is not a
  standalone script. If PagerDuty incident paging already works on this
  instance, that dependency is already satisfied.
- **Field names**: `PagerDutySync.js`'s GlideRecord queries assume the same field
  names the original CSV exports used (`schedule`, `schedule.time_zone`, `group`,
  `group.manager.email`, `catch_all`, `rota`, `roster`, `days_of_week`, `repeat_type`,
  etc.) are real field names, not just export column labels.
- **No debounce** on the Business Rule -- see the note at the bottom of
  `business_rule_sync_on_change.js`.
- **Rate limits**: a full `syncAll()` still makes on the order of 10 sequential
  PagerDuty API calls per group. `x_pd_integration.PagerDuty_REST` already retries a 429
 up to 3 times with backoff, so isolated rate-limit hits are handled automatically.
