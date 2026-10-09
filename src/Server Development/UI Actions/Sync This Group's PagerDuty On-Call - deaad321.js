(function() {
    var groupName;
    if (current.getTableName() == 'cmn_rota') {
        groupName = current.group.name.toString();
    } else {
        // sys_user_group
        groupName = current.name.toString();
    }

    gs.eventQueue('pagerduty_sync.requested', current, groupName, 'live');

    gs.addInfoMessage('PagerDuty sync for "' + groupName + '" has been queued. In a minute or two ' +
        'its PagerDuty Sync Group record shows the result (Last sync result / message); System Logs ' +
        '(Source = PagerDutySync) has the detail.');

    action.setRedirectURL(current);
})();

// Same live-vs-dry-run note as ui_action_sync_all.js: this fires 'live'. Validate with
// 'dryrun' first in sub-prod.
//
// If you'd rather have ONE UI Action work on both cmn_rota and sys_user_group without
// creating two separate sys_ui_action records, ServiceNow doesn't support a single UI
// Action spanning two unrelated tables -- create this as two records (same script,
// same name) rather than trying to force one record to cover both.