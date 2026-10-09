(function executeRule(current, previous /*null when async*/) {

    // One enrollment row per group.
    var dup = new GlideRecord('u_pagerduty_sync_group');
    dup.addQuery('u_group', current.getValue('u_group'));
    dup.addQuery('sys_id', '!=', current.getUniqueValue());
    dup.setLimit(1);
    dup.query();
    if (dup.next()) {
        gs.addErrorMessage('That group is already enrolled in PagerDuty Sync.');
        current.setAbortAction(true);
    }

})(current, previous);