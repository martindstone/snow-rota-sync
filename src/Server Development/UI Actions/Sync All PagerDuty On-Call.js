(function() {
    gs.eventQueue('pagerduty_sync.requested', current, 'all', 'live');

    gs.addInfoMessage('PagerDuty sync for all groups has been queued. Each group\'s PagerDuty Sync ' +
        'Group record shows its result (Last sync result / message); System Logs ' +
        '(Source = PagerDutySync) has the detail.');

    action.setRedirectURL(current);
})();

// NOTE: "current" is passed as the event's target record only because gs.eventQueue()
// requires *some* GlideRecord argument -- the Script Action ignores it entirely and
// reads parm1/parm2 instead, so this UI Action works regardless of which table it's
// placed on.
//
// This fires LIVE ('live' as parm2). Test with dry-run first by temporarily changing
// the last argument to 'dryrun' (or duplicate this as a second "Sync All (Dry Run)"
// UI Action while you're validating in sub-prod) before trusting the 'live' version.