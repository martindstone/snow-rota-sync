// Record type: sysevent_script_action (System Policy > Events > Script Actions)
// Name: PagerDuty Sync - Script Action
// Event name: pagerduty_sync.requested   <-- must match the Event Registry entry below
// Active: true
//
// This is the ONE place that actually calls into PagerDutySync. Both UI Actions and
// the (optional, inactive-by-default) Business Rule only ever queue an event -- they
// never call PagerDutySync directly -- so the actual PagerDuty API calls always run
// asynchronously on the event queue, off the UI Action's request thread. This is what
// makes the UI Actions safe from the ~60-90-sequential-API-call timeout risk that a
// synchronous call would have.
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
    var groupScope = event.parm1;
    var mode = event.parm2;
    var dryRun = (mode !== 'live');

    var sync = new PagerDutySync();

    try {
        if (!groupScope || groupScope === 'all') {
            sync.syncAll(dryRun);
        } else {
            sync.syncGroup(groupScope, dryRun);
        }
    } catch (e) {
        gs.error('pagerduty_sync.requested script action failed for scope="' + groupScope +
            '" mode="' + mode + '": ' + e);
        // Deliberately not re-thrown -- this runs on the event queue with no user
        // waiting on a response; the gs.error() above is what surfaces the failure
        // (System Logs > Error, or wire up an Email Notification on this error if
        // you want to be paged when a sync fails).
    }
})();
