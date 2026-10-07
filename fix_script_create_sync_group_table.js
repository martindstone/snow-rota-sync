(function() {
    // Scripts - Background (Global scope). Creates the u_pagerduty_sync_group table and every
    // column PagerDutySync needs (enrollment + the debounced sync queue state), or -- if the
    // table already exists, e.g. you made it by hand with just u_group -- adds only the
    // columns that are missing. Never alters or drops anything that already exists.
    //
    // DRY_RUN = true (default) only prints what it WOULD do. Set it to false to apply.
    // Safe to re-run: every step checks first.
    //
    // Not covered here: a form/list layout for the table. A table made by script has no
    // form sections, so configure one (Form Layout / List Layout, or "Configure > Form
    // Layout" on the table) -- at minimum u_group and the u_last_* columns -- and hide
    // u_claim_token, which is internal.
    // u_group is kept unique by a Business Rule (UNIQUE_RULE below), not a unique index:
    // ServiceNow won't set the dictionary Unique flag over a reference column's automatic
    // index (a unique index has to be built separately with IndexCreator).
    var DRY_RUN = true;

    var TABLE = 'u_pagerduty_sync_group';
    var TABLE_LABEL = 'PagerDuty Sync Group';

    // type: sys_dictionary.internal_type. choices: [value, label] pairs (stored as a string column with a choice list).
    var COLUMNS = [
        {name: 'u_group', label: 'Group', type: 'reference', reference: 'sys_user_group', mandatory: true, display: true},
        {name: 'u_pending_since', label: 'Pending since', type: 'glide_date_time'},
        {name: 'u_last_change', label: 'Last change', type: 'glide_date_time'},
        {name: 'u_running_since', label: 'Running since', type: 'glide_date_time'},
        {name: 'u_claim_token', label: 'Claim token', type: 'string', length: 40},
        {name: 'u_retry_after', label: 'Retry after', type: 'glide_date_time'},
        {name: 'u_last_attempt', label: 'Last sync attempt', type: 'glide_date_time'},
        {name: 'u_last_result', label: 'Last sync result', type: 'string', length: 40, audit: true,
            choices: [['success', 'Success'], ['failed', 'Failed'], ['skipped', 'Skipped']]},
        {name: 'u_last_message', label: 'Last sync message', type: 'string', length: 4000, audit: true},
        {name: 'u_last_success', label: 'Last successful sync', type: 'glide_date_time', audit: true},
        {name: 'u_consecutive_failures', label: 'Consecutive failures', type: 'integer'}
    ];

    var UNIQUE_RULE = {
        name: 'PagerDuty Sync Group - Unique Group',
        script: [
            '(function executeRule(current, previous /*null when async*/) {',
            '',
            '    // One enrollment row per group.',
            "    var dup = new GlideRecord('u_pagerduty_sync_group');",
            "    dup.addQuery('u_group', current.getValue('u_group'));",
            "    dup.addQuery('sys_id', '!=', current.getUniqueValue());",
            '    dup.setLimit(1);',
            '    dup.query();',
            '    if (dup.next()) {',
            "        gs.addErrorMessage('That group is already enrolled in PagerDuty Sync.');",
            '        current.setAbortAction(true);',
            '    }',
            '',
            '})(current, previous);'
        ].join('\n')
    };

    function say(msg) { gs.print((DRY_RUN ? '[dry run] ' : '') + msg); }

    function tableExists() {
        var t = new GlideRecord('sys_db_object');
        t.addQuery('name', TABLE);
        t.query();
        return t.next();
    }

    function dictionaryRowExists(column) {
        var d = new GlideRecord('sys_dictionary');
        d.addQuery('name', TABLE);
        d.addQuery('element', column);
        d.query();
        return d.next();
    }

    function createTable() {
        say('create table ' + TABLE + ' ("' + TABLE_LABEL + '")');
        if (DRY_RUN) return;
        var t = new GlideRecord('sys_db_object');
        t.initialize();
        t.setValue('name', TABLE);
        t.setValue('label', TABLE_LABEL);
        t.setValue('is_extendable', false);
        t.setValue('create_access_controls', false); // admin-only by default; add ACLs/roles to taste
        t.setValue('live_feed_enabled', false);
        if (!t.insert()) throw 'could not create table ' + TABLE;
    }

    function createColumn(c) {
        say('add column ' + c.name + ' (' + c.type + (c.length ? ' ' + c.length : '') +
            (c.reference ? ' -> ' + c.reference : '') + (c.mandatory ? ', mandatory' : '') +
            (c.audit ? ', audited' : '') + (c.choices ? ', choice list' : '') + ')');
        if (DRY_RUN) return;
        var d = new GlideRecord('sys_dictionary');
        d.initialize();
        d.setValue('name', TABLE);
        d.setValue('element', c.name);
        d.setValue('column_label', c.label);
        d.setValue('internal_type', c.type);
        d.setValue('active', true);
        if (c.length) d.setValue('max_length', c.length);
        if (c.reference) d.setValue('reference', c.reference);
        if (c.mandatory) d.setValue('mandatory', true);
        if (c.display) d.setValue('display', true);
        if (c.audit) d.setValue('audit', true);
        if (c.choices) d.setValue('choice', 1); // sys_dictionary.choice: 1 = dropdown with a "-- None --" entry
        if (!d.insert()) throw 'could not add column ' + c.name;

        if (c.choices) {
            for (var i = 0; i < c.choices.length; i++) {
                var ch = new GlideRecord('sys_choice');
                ch.initialize();
                ch.setValue('name', TABLE);
                ch.setValue('element', c.name);
                ch.setValue('value', c.choices[i][0]);
                ch.setValue('label', c.choices[i][1]);
                ch.setValue('sequence', (i + 1) * 100);
                ch.setValue('language', 'en');
                ch.setValue('inactive', false);
                if (!ch.insert()) throw 'could not add choice ' + c.choices[i][0] + ' to ' + c.name;
            }
        }
    }

    try {
        var existed = tableExists();
        if (existed) say('table ' + TABLE + ' already exists; adding only missing columns');
        else createTable();

        var added = 0, present = 0;
        for (var i = 0; i < COLUMNS.length; i++) {
            if (existed && dictionaryRowExists(COLUMNS[i].name)) { present++; say('column ' + COLUMNS[i].name + ' already exists; leaving it alone'); continue; }
            createColumn(COLUMNS[i]);
            added++;
        }
        var ruleExists = new GlideRecord('sys_script');
        ruleExists.addQuery('name', UNIQUE_RULE.name);
        ruleExists.query();
        if (ruleExists.next()) {
            say('business rule "' + UNIQUE_RULE.name + '" already exists; leaving it alone');
        } else {
            say('create business rule "' + UNIQUE_RULE.name + '" on ' + TABLE + ' (before insert/update, active)');
            if (!DRY_RUN) {
                var br = new GlideRecord('sys_script');
                br.initialize();
                br.setValue('name', UNIQUE_RULE.name);
                br.setValue('collection', TABLE);
                br.setValue('when', 'before');
                br.setValue('order', 100);
                br.setValue('active', true);
                br.setValue('advanced', true);
                br.setValue('action_insert', true);
                br.setValue('action_update', true);
                br.setValue('action_delete', false);
                br.setValue('action_query', false);
                br.setValue('condition', 'current.isNewRecord() || current.u_group.changes()');
                br.setValue('description', 'Rejects a second enrollment row for the same group (u_group cannot carry a unique index).');
                br.setValue('script', UNIQUE_RULE.script);
                if (!br.insert()) throw 'could not create business rule "' + UNIQUE_RULE.name + '"';
            }
        }
        gs.print('');
        gs.print((DRY_RUN ? 'DRY RUN: would add ' : 'Added ') + added + ' column(s)' + (existed ? '' : ' to a new table') +
            '; ' + present + ' already present.');
        if (!DRY_RUN) {
            var check = new GlideRecord(TABLE);
            var missing = [];
            for (var j = 0; j < COLUMNS.length; j++) if (!check.isValidField(COLUMNS[j].name)) missing.push(COLUMNS[j].name);
            gs.print(missing.length ? 'VERIFY FAILED -- GlideRecord does not see: ' + missing.join(', ') +
                ' (the table cache may need a moment; re-run the script to re-check)' : 'VERIFIED: every column is visible to GlideRecord.');
        } else {
            gs.print('Set DRY_RUN = false and run again to apply.');
        }
    } catch (err) {
        gs.print('ERROR: ' + err);
    }
})();
