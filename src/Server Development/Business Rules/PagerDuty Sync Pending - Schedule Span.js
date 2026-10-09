(function executeRule(current, previous /*null when async*/) {

    // Resolves the enrolled group(s) this record belongs to and stamps them pending.
    // A record belonging to a group that isn't in u_pagerduty_sync_group is ignored.
    // `previous` is also checked so a rota moved between groups marks both.
    new global.PagerDutySync().markPendingForRecord(current, previous);

})(current, previous);