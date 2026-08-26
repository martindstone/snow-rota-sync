// Record type: sys_script (Business Rule)
// Name: PagerDuty Sync on Rota Update
// Table: cmn_rota
// Active: FALSE  <-- deliberately shipped inactive. This fires a live PagerDuty write
//         automatically on every qualifying update with no human in the loop -- that's
//         a meaningfully bigger blast radius than a UI Action someone clicks on
//         purpose, so it should stay off until you've watched the UI Action path work
//         correctly for a while and deliberately decide you want it. Flip Active to
//         true only when you're ready.
// When: after
// Insert: true
// Update: true
// Delete: false
// Filter condition: leave blank, or scope it to groups that have ANY row in
//   u_pagerduty_sync_group if you want a related-list condition -- not required,
//   since the code-level isEnrolled() check below is the actual source of truth and
//   won't drift out of sync with the filter condition the way a hardcoded list of
//   sys_ids could.
// Order: 100 (default is fine; this doesn't need to race anything else)
//
// Script (paste into the Business Rule's Script field):

(function executeRule(current, previous /*null when async*/) {

    var sync = new PagerDutySync();
    var groupName = current.group.name.toString();

    if (!sync.isEnrolled(groupName)) {
        return; // not enrolled in u_pagerduty_sync_group; nothing to do
    }

    // Queue the same event the UI Actions use, so all three trigger paths (global UI
    // Action, contextual UI Action, this Business Rule) funnel through the one
    // Script Action listener in pagerduty_sync_script_action.js -- no duplicated
    // sync logic to keep in sync (no pun intended) across trigger points.
    gs.eventQueue('pagerduty_sync.requested', current, groupName, 'live');

})(current, previous);

// BEFORE ENABLING:
// - Consider whether you also want this on cmn_rota_roster / cmn_rota_member updates
//   (a membership or escalation-level change is arguably the more common edit than a
//   change to cmn_rota itself). If so, dot-walk up to the group name the same way
//   (e.g. `current.rota.group.name.toString()` on cmn_rota_roster,
//   `current.roster.rota.group.name.toString()` on cmn_rota_member) and create a
//   second Business Rule per table, same pattern, also inactive by default.
// - A sync currently touches EVERY schedule/escalation policy for the whole group,
//   not just the one field that changed. That's fine while u_pagerduty_sync_group
//   stays small, but worth knowing: editing one roster row will re-upsert every
//   schedule in that group's escalation policy, not just one layer -- and the more
//   groups get enrolled, the more this adds up per edit.
// - There's no debounce: five quick edits to the same rota queues five separate sync
//   events, each doing a full group resync. Harmless (idempotent upsert-by-name) but
//   wasteful against PagerDuty's rate limits if edits come in bursts. If that becomes
//   a real problem, the standard ServiceNow fix is a small "pending sync" flag table
//   plus a scheduled job that debounces, rather than firing the event directly here.
