(function() {
    var group = current;
    var groupName = group.getValue('name');

    var out = {
        exported_at: new GlideDateTime().getValue() + ' UTC',
        exported_by: gs.getUserName(),
        group: {
            sys_id: group.getUniqueValue(),
            name: groupName,
            active: group.getValue('active'),
            manager_name: group.manager.getDisplayValue() || '',
            manager_email: group.manager.email ? group.manager.email.toString() : ''
        },
        rotas: []
    };

    var rotaGr = new GlideRecord('cmn_rota');
    rotaGr.addQuery('group', group.getUniqueValue());
    rotaGr.orderBy('name');
    rotaGr.query();

    while (rotaGr.next()) {
        var rotaOut = {
            sys_id: rotaGr.getUniqueValue(),
            name: rotaGr.getValue('name'),
            active: rotaGr.getValue('active'),
            state: rotaGr.getValue('state'),
            catch_all: rotaGr.getValue('catch_all'),
            catch_all_member_name: rotaGr.catch_all_member.getDisplayValue() || '',
            catch_all_member_email: rotaGr.catch_all_member.email ? rotaGr.catch_all_member.email.toString() : '',
            catch_all_wait_time_raw: rotaGr.getValue('catch_all_wait_time'),
            catch_all_roster: rotaGr.catch_all_roster.getDisplayValue() || '',
            use_custom_escalation: rotaGr.getValue('use_custom_escalation'),
            send_reminders: rotaGr.getValue('send_reminders'),
            reminder_lead_time_raw: rotaGr.getValue('reminder_lead_time'),
            schedule: null,
            rosters: []
        };

        // Schedule + every span row on it, raw. This is the actual coverage-window
        // source data -- days_of_week/repeat_type/start_date_time/end_date_time --
        // left completely unparsed on purpose (see file header).
        var scheduleSysId = rotaGr.schedule.toString();
        if (scheduleSysId) {
            var schedGr = new GlideRecord('cmn_schedule');
            if (schedGr.get(scheduleSysId)) {
                var schedOut = {
                    sys_id: scheduleSysId,
                    name: schedGr.getValue('name'),
                    time_zone: schedGr.getValue('time_zone'),
                    spans: []
                };
                var spanGr = new GlideRecord('cmn_schedule_span');
                spanGr.addQuery('schedule', scheduleSysId);
                spanGr.orderBy('start_date_time');
                spanGr.query();
                while (spanGr.next()) {
                    schedOut.spans.push({
                        sys_id: spanGr.getUniqueValue(),
                        name: spanGr.getValue('name'),
                        type: spanGr.getValue('type'),
                        repeat_type: spanGr.getValue('repeat_type'),
                        days_of_week: spanGr.getValue('days_of_week'),
                        repeat_count: spanGr.getValue('repeat_count'),
                        start_date_time: spanGr.getValue('start_date_time'),
                        end_date_time: spanGr.getValue('end_date_time')
                    });
                }
                rotaOut.schedule = schedOut;
            }
        }

        // Every roster row on this rota, and every member row on each roster --
        // both in their own order field's raw value, unsorted here on purpose
        // (sort in whatever's reading this JSON; don't bake in an assumption
        // about numeric-vs-string order here).
        var rosterGr = new GlideRecord('cmn_rota_roster');
        rosterGr.addQuery('rota', rotaGr.getUniqueValue());
        rosterGr.query();
        while (rosterGr.next()) {
            var rosterOut = {
                sys_id: rosterGr.getUniqueValue(),
                name: rosterGr.getValue('name'),
                order: rosterGr.getValue('order'),
                active: rosterGr.getValue('active'),
                rotation_interval_type: rosterGr.getValue('rotation_interval_type'),
                rotation_interval_count: rosterGr.getValue('rotation_interval_count'),
                rotation_start_date: rosterGr.getValue('rotation_start_date'),
                rotation_start_time: rosterGr.getValue('rotation_start_time'),
                time_before_escalation_raw: rosterGr.getValue('time_before_escalation'),
                members: []
            };

            var memberGr = new GlideRecord('cmn_rota_member');
            memberGr.addQuery('roster', rosterGr.getUniqueValue());
            memberGr.query();
            while (memberGr.next()) {
                rosterOut.members.push({
                    sys_id: memberGr.getUniqueValue(),
                    order: memberGr.getValue('order'),
                    member_name: memberGr.member.getDisplayValue() || '',
                    member_email: memberGr.member.email ? memberGr.member.email.toString() : '',
                    from: memberGr.getValue('from'),
                    to: memberGr.getValue('to')
                });
            }

            rotaOut.rosters.push(rosterOut);
        }

        out.rotas.push(rotaOut);
    }

    var fileName = 'oncall-config-' + groupName.replace(/[^a-zA-Z0-9_-]+/g, '_') + '.json';
    var content = JSON.stringify(out, null, 2);

    var attachment = new GlideSysAttachment();
    attachment.write(group, fileName, 'application/json', content);

    gs.addInfoMessage('On-call config exported -- see "' + fileName + '" in the Attachments (paperclip icon) ' +
        'on this record. Download it and send it to whoever asked for it.');
    action.setRedirectURL(current);
})();