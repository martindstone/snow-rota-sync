(function() {
    // Scripts - Background (Global scope). Creates the debounced-sync-queue plumbing:
    //   - five Business Rules that mark a group pending (RULE_SCRIPT / RULES below)
    //   - two Scheduled Jobs (JOBS below):
    //       "PagerDuty Sync - Process Pending"   every minute, created INACTIVE (it is the
    //                                             switch that lets edits reach PagerDuty)
    //       "PagerDuty Sync - Nightly Catch-All"  daily at NIGHTLY_RUN_TIME, active (it only
    //                                             marks groups pending)
    //
    // DRY_RUN = true (default) only prints what it WOULD do. Set it to false to apply.
    // Safe to re-run: a record with the same name is left exactly as it is (the script
    // reports it); it never edits or deletes anything. Requires PagerDutySync (v23+) and the
    // sync-state columns (fix_script_create_sync_group_table.js) to exist before the
    // rules are useful, but creating the records does not depend on them.
    var DRY_RUN = true;
    var NIGHTLY_RUN_TIME = '1970-01-01 02:00:00'; // time of day; interpreted in the job's time zone setting (blank = system default)

    var RULE_SCRIPT = [
        '(function executeRule(current, previous /*null when async*/) {',
        '',
        '    // Resolves the enrolled group(s) this record belongs to and stamps them pending.',
        "    // A record belonging to a group that isn't in u_pagerduty_sync_group is ignored.",
        '    // `previous` is also checked so a rota moved between groups marks both.',
        '    new PagerDutySync().markPendingForRecord(current, previous);',
        '',
        '})(current, previous);'
    ].join('\n');

    var RULES = [
        {name: 'PagerDuty Sync Pending - Rota', table: 'cmn_rota', filter: ''},
        {name: 'PagerDuty Sync Pending - Roster', table: 'cmn_rota_roster', filter: ''},
        {name: 'PagerDuty Sync Pending - Member', table: 'cmn_rota_member', filter: ''},
        {name: 'PagerDuty Sync Pending - Schedule Span', table: 'cmn_schedule_span', filter: ''},
        {name: 'PagerDuty Sync Pending - Coverage', table: 'roster_schedule_span', filter: 'type=on_call'}
    ];

    var JOBS = [
        {name: 'PagerDuty Sync - Process Pending', active: false, runType: 'periodically', runPeriod: '1970-01-01 00:01:00',
            script: 'new PagerDutySync().processPending();',
            description: 'Syncs enrolled groups whose on-call changes have gone quiet (see PagerDutySync README). INACTIVE until validated: activating it lets pending changes write to PagerDuty.'},
        {name: 'PagerDuty Sync - Nightly Catch-All', active: true, runType: 'daily', runTime: NIGHTLY_RUN_TIME,
            script: 'new PagerDutySync().markAllPending();',
            description: 'Marks every enrolled group pending so time-based changes (member from/to dates, expiring repeat_until) are picked up. Does not sync by itself.'}
    ];

    function say(msg) { gs.print((DRY_RUN ? '[dry run] ' : '') + msg); }

    function exists(table, name) {
        var gr = new GlideRecord(table);
        gr.addQuery('name', name);
        gr.query();
        return gr.next();
    }

    var created = 0, present = 0;
    try {
        for (var i = 0; i < RULES.length; i++) {
            var rule = RULES[i];
            if (exists('sys_script', rule.name)) { present++; say('business rule "' + rule.name + '" already exists; leaving it alone'); continue; }
            say('create business rule "' + rule.name + '" on ' + rule.table + ' (before insert/update/delete' +
                (rule.filter ? ', condition ' + rule.filter : '') + ', active)');
            created++;
            if (DRY_RUN) continue;
            var br = new GlideRecord('sys_script');
            br.initialize();
            br.setValue('name', rule.name);
            br.setValue('collection', rule.table);
            br.setValue('when', 'before');
            br.setValue('order', 100);
            br.setValue('active', true);
            br.setValue('advanced', true);
            br.setValue('action_insert', true);
            br.setValue('action_update', true);
            br.setValue('action_delete', true);
            br.setValue('action_query', false);
            if (rule.filter) br.setValue('filter_condition', rule.filter);
            br.setValue('description', 'Marks the record\'s enrolled group pending in u_pagerduty_sync_group; the scheduled job does the sync. Never calls PagerDuty.');
            br.setValue('script', RULE_SCRIPT);
            if (!br.insert()) throw 'could not create business rule "' + rule.name + '"';
        }

        for (var j = 0; j < JOBS.length; j++) {
            var job = JOBS[j];
            if (exists('sysauto_script', job.name)) { present++; say('scheduled job "' + job.name + '" already exists; leaving it alone'); continue; }
            say('create scheduled job "' + job.name + '" (' + job.runType + ', ' + (job.active ? 'ACTIVE' : 'INACTIVE') + ')');
            created++;
            if (DRY_RUN) continue;
            var sj = new GlideRecord('sysauto_script');
            sj.initialize();
            sj.setValue('name', job.name);
            sj.setValue('active', job.active);
            sj.setValue('run_type', job.runType);
            if (job.runPeriod) sj.setValue('run_period', job.runPeriod);
            if (job.runTime) sj.setValue('run_time', job.runTime);
            sj.setValue('script', job.script);
            sj.setValue('description', job.description);
            if (!sj.insert()) throw 'could not create scheduled job "' + job.name + '"';
        }

        gs.print('');
        gs.print((DRY_RUN ? 'DRY RUN: would create ' : 'Created ') + created + ' record(s); ' + present + ' already present.');
        if (DRY_RUN) {
            gs.print('Set DRY_RUN = false and run again to apply.');
        } else {
            var missing = [];
            for (var k = 0; k < RULES.length; k++) if (!exists('sys_script', RULES[k].name)) missing.push(RULES[k].name);
            for (var m = 0; m < JOBS.length; m++) if (!exists('sysauto_script', JOBS[m].name)) missing.push(JOBS[m].name);
            gs.print(missing.length ? 'VERIFY FAILED -- not found: ' + missing.join('; ') : 'VERIFIED: all records exist.');
            gs.print('Check: Process Pending job is INACTIVE until you have validated a real sync.');
        }
    } catch (err) {
        gs.print('ERROR: ' + err);
    }
})();
