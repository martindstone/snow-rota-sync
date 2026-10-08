// Record type: sysauto_script (Scheduled Script Execution) -- create TWO.
//
// ---------------------------------------------------------------------------
// 1. Name: PagerDuty Sync - Process Pending
//    Run: Periodically, every 1 minute
//    Active: FALSE until you've validated the queue on a pilot group (this is the
//            switch that lets pending changes actually write to PagerDuty)
//
//    Script:
//      new global.PagerDutySync().processPending();
//
//    Syncs each group on u_pagerduty_sync_group that has pending changes once they've
//    gone quiet for 2 minutes (or 10 minutes after the first one). Skips a group that is
//    already syncing or is backing off after a failure. Records the outcome on the row:
//    u_last_attempt / u_last_result / u_last_message / u_last_success. Safe to run
//    overlapping: the per-group lock stops two runs syncing the same group.
//
// ---------------------------------------------------------------------------
// 2. Name: PagerDuty Sync - Nightly Catch-All
//    Run: Daily, e.g. 02:00
//    Active: true (it only marks groups pending; job 1 decides when they sync)
//
//    Script:
//      new global.PagerDutySync().markAllPending();
//
//    Picks up changes that no edit announces: a member's from/to date arriving or
//    passing, a repeat_until expiring, a rotation reaching its next phase.
//
// Tunables (QUIET_PERIOD_SECONDS, MAX_WAIT_SECONDS, STALE_LOCK_SECONDS,
// RETRY_BACKOFF_MINUTES, MAX_RUN_SECONDS) are constants in PagerDutySync.initialize().
