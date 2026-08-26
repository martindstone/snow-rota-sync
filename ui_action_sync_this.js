// Record type: sys_ui_action
// Name: Sync This Group's PagerDuty On-Call
// Table: cmn_rota   (create a second copy of this same UI Action on sys_user_group if
//        you also want the button available from the group record directly -- see the
//        table-specific branch in the script below, which handles both)
// Action name: sync_this_pagerduty_oncall
// Client: false
// Form button: true
// Condition (field):
//   current.getTableName() == 'cmn_rota'
//       ? (new global.PagerDutySync()).isEnrolled(current.group.name.toString())
//       : (new global.PagerDutySync()).isEnrolled(current.name.toString())
// (This keeps the button hidden entirely on rotas/groups not enrolled in
// u_pagerduty_sync_group, so nobody's tempted to click it somewhere it'll no-op. Drop
// the `global.` prefix if your instance scope doesn't require it.)
//
// Script (paste into the UI Action's Script field):

(function() {
    var groupName;
    if (current.getTableName() == 'cmn_rota') {
        groupName = current.group.name.toString();
    } else {
        // sys_user_group
        groupName = current.name.toString();
    }

    gs.eventQueue('pagerduty_sync.requested', current, groupName, 'live');

    gs.addInfoMessage('PagerDuty sync for "' + groupName + '" has been queued. Check System ' +
        'Logs (filter: Source = PagerDutySync, or search "pagerduty_sync.requested") in a ' +
        'minute or two for the result.');

    action.setRedirectURL(current);
})();

// Same live-vs-dry-run note as ui_action_sync_all.js: this fires 'live'. Validate with
// 'dryrun' first in sub-prod.
//
// If you'd rather have ONE UI Action work on both cmn_rota and sys_user_group without
// creating two separate sys_ui_action records, ServiceNow doesn't support a single UI
// Action spanning two unrelated tables -- create this as two records (same script,
// same name) rather than trying to force one record to cover both.
