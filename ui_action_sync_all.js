// Record type: sys_ui_action
// Name: Sync All PagerDuty On-Call
// Table: global (Application = Global, Table = leave blank so it's not tied to one table)
//        Practically: create this on a table your on-call admins actually land on --
//        e.g. sys_user_group (list or form view) is a reasonable home even though it
//        syncs ALL groups, not just the one on screen. Set "List Banner Button" and/or
//        "Form Button" as appropriate; leave "Show insert" / "Show update" alone.
// Action name: sync_all_pagerduty_oncall  (must be unique on this table)
// Client: false   (this must run server-side to call gs.eventQueue())
// Form/List button, or List Banner Button: true (per where you place it)
// Condition (field): leave blank, or restrict to an admin role via the Condition below
//
// Recommended Condition:
//   gs.hasRole('admin') || gs.hasRole('x_pagerduty_sync.admin')
// (adjust to whatever role your team uses to gate this -- there's no built-in role
// created by this port; use an existing admin-ish role or create a small custom one.)
//
// Script (paste into the UI Action's Script field):

(function() {
    gs.eventQueue('pagerduty_sync.requested', current, 'all', 'live');

    gs.addInfoMessage('PagerDuty sync for all groups has been queued. Check System Logs ' +
        '(filter: Source = PagerDutySync, or search "pagerduty_sync.requested") in a ' +
        'minute or two for the result.');

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
