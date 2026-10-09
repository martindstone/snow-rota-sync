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

    var sync = new global.PagerDutySync();

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