// Record type: sys_script (Business Rule) -- create FIVE, one per table below, all with
// the same script body. Instead of queueing a live sync per edit, they only mark the group "pending" on its
// u_pagerduty_sync_group row. The scheduled job (scheduled_job_process_pending_syncs.js)
// does the actual syncing once edits have gone quiet, so five quick edits become ONE
// sync. These rules never call PagerDuty, so they are safe to leave Active; the
// scheduled job is the on/off switch (leave it Inactive until you've validated).
//
// Common settings:
//   When:   before     (so a "before delete" can still dot-walk up to the group; marking
//                       pending early is harmless -- the sync waits for a quiet period
//                       and a rolled-back edit just causes one idempotent resync)
//   Insert: true, Update: true, Delete: true
//   Order:  100
//
//   Name                                   Table                  Filter condition
//   PagerDuty Sync Pending - Rota          cmn_rota               (none)
//   PagerDuty Sync Pending - Roster        cmn_rota_roster        (none)
//   PagerDuty Sync Pending - Member        cmn_rota_member        (none)
//   PagerDuty Sync Pending - Schedule Span cmn_schedule_span      (none)
//   PagerDuty Sync Pending - Coverage      roster_schedule_span   type=on_call
//
// (cmn_schedule_span covers the rota's coverage window -- start/end time, repeat days.
//  roster_schedule_span with type=on_call is "Provide coverage"; time off is not synced,
//  so it is deliberately excluded.)
//
// Script (paste into each Business Rule's Script field):

(function executeRule(current, previous /*null when async*/) {

    // Resolves the enrolled group(s) this record belongs to and stamps them pending.
    // A record belonging to a group that isn't in u_pagerduty_sync_group is ignored.
    // `previous` is also checked so a rota moved between groups marks both.
    new PagerDutySync().markPendingForRecord(current, previous);

})(current, previous);
