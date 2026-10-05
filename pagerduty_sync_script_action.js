// Record type: sysevent_script_action (System Policy > Events > Script Actions)
// Name: PagerDuty Sync - Script Action
// Event name: pagerduty_sync.requested   <-- must match the Event Registry entry below
// Active: true
//
// This handles MANUAL syncs: the UI Actions only ever queue an event -- they never call
// PagerDutySync directly -- so the actual PagerDuty API calls run asynchronously on the
// event queue, off the UI Action's request thread. This is what makes the UI Actions safe
// from the ~60-90-sequential-API-call timeout risk that a synchronous call would have.
// (Automatic, edit-driven syncs do NOT come through here: the Business Rules in
// business_rules_mark_pending.js only mark a group pending, and the scheduled job
// "PagerDuty Sync - Process Pending" syncs it once edits have gone quiet.)
//
// A manual live sync bypasses the debounce but shares the queue's per-group lock and
// history: the outcome lands in u_last_attempt / u_last_result / u_last_message on the
// group's u_pagerduty_sync_group row, and a group that is already syncing is marked pending
// to run again afterwards rather than synced concurrently. If the sync-state columns
// haven't been added yet it falls back to an untracked sync (logged as a warning).
//
// event.parm1 = "all" (sync every group enrolled in u_pagerduty_sync_group) or a
//               specific group name
// event.parm2 = "live" or "dryrun" (defaults to dryrun if anything else/blank --
//               deliberately fails safe, since a typo here should never silently go live)
//
// You must also create the Event Registry entry this listens for:
//   System Policy > Events > Registry > New
//     Name: pagerduty_sync.requested
//     Table: (leave blank, or set to the table event.getRecord() would target if you
//             later want the event tied to a specific record -- not required here
//             since we pass everything via parm1/parm2)
//     Fired by: (leave default)
//
// NOTE ON EVENT QUEUE LATENCY: gs.eventQueue() drops onto sysevent and is picked up by
// the event processor on its normal schedule (seconds, typically) -- not instant. For
// ad hoc testing where you want an immediate result, just call
// `new PagerDutySync().syncAll(true)` directly from a Background Script instead of
// going through the event at all.

(function() {
    // event.parm1/parm2 are GlideElement objects, not plain JS strings -- confirmed
    // live: posting parm2='live' via the event queue still produced a dry run,
    // because `mode !== 'live'` (strict inequality) never coerces a GlideElement to
    // a string for comparison, so a GlideElement is never === a string literal no
    // matter its content. That made `dryRun = (mode !== 'live')` unconditionally
    // true -- the event-driven path could never actually go live. String(...) forces
    // the coercion before comparing. Same trap applies to groupScope === 'all' below.
    var groupScope = String(event.parm1 || '');
    var mode = String(event.parm2 || '');
    var dryRun = (mode !== 'live');

    var sync = new PagerDutySync();

    try {
        if (dryRun) {
            // Dry runs never touch PagerDuty, so they skip the lock and leave the
            // sync history on u_pagerduty_sync_group alone.
            if (!groupScope || groupScope === 'all') {
                sync.syncAll(true);
            } else {
                sync.syncGroup(groupScope, true);
            }
        } else if (!groupScope || groupScope === 'all') {
            // Live runs go through the same lock + history as the scheduled job
            // (see PagerDutySync.processPending). A group already syncing is queued
            // to run again afterwards instead of being synced concurrently.
            sync.syncAllTracked();
        } else {
            sync.syncGroupTracked(groupScope);
        }
    } catch (e) {
        gs.error('pagerduty_sync.requested script action failed for scope="' + groupScope +
            '" mode="' + mode + '": ' + e);
        // Deliberately not re-thrown -- this runs on the event queue with no user
        // waiting on a response. Live syncs already record their own failures on the
        // group's row (u_last_result = failed, u_last_message); this catch is only for
        // something unexpected outside that (System Logs > Error shows it).
    }
})();
