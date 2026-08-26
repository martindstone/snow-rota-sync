// Script Include: PagerDutySync
// Client callable: false | Access from: All application scopes (adjust to your scope policy)
//
// CHOOSING GROUPS TO MANAGE: Add rows to the u_pagerduty_sync_group table (one
// sys_user_group per row) to enroll them in this sync. Presence in that table
// means this port will overwrite that group's PagerDuty schedules/escalation policies
// on every sync; absence means it's never touched. See isEnrolled() /
// _enrolledGroupNames() below and README.md for how to create the table.
//
// ASSUMPTIONS -- verify these against your instance before trusting this:
//   - Field names on cmn_rota / cmn_rota_roster / cmn_rota_member / cmn_schedule_span
//     match what the original CSV exports used (schedule, schedule.time_zone,
//     group, group.manager.email, catch_all, rota, roster, days_of_week, repeat_type,
//     start_date_time, end_date_time, etc.)
//   - cmn_rota_member.from / cmn_rota_member.to are Date fields (no time component),
//     matching the "DD-MM-YYYY" format seen in the CSV exports.

var PagerDutySync = Class.create();
PagerDutySync.prototype = {
    initialize: function() {
        // Which groups this port manages is data now, not code -- see isEnrolled()
        // and _enrolledGroupNames() below, which read the u_pagerduty_sync_group
        // table (one row per enrolled sys_user_group). Presence = this group's
        // on-call comes from ServiceNow and gets overwritten in PagerDuty on every
        // sync; absence = untouched. See README.md for how to create the table.
        this.SYNC_GROUP_TABLE = 'u_pagerduty_sync_group';

        // Every schedule/escalation policy this port creates or updates gets this
        // prefix, so anyone scanning PagerDuty's UI can immediately tell which
        // objects are ServiceNow-managed (and, since PD sorts lists alphabetically,
        // they cluster together instead of being scattered through the full list).
        this.SYNCED_NAME_PREFIX = '[ServiceNow Sync] ';
        this.SYNCED_DESCRIPTION = 'Managed by ServiceNow on-call sync (PagerDutySync). ' +
            'Changes made directly in PagerDuty will be overwritten on the next sync.';

        // Reuses the app's own "Default PagerDuty User ID to use if auto-provisioning
        // is disabled" property instead of a separate one-off property for this port
        // -- same fallback-user concept the app already uses elsewhere (see
        // PagerDuty.defaultUserID and PagerDutyProvisioning's group provisioning),
        // already configured on this instance, no second ID to keep in sync.
        this.FALLBACK_USER_ID = gs.getProperty('x_pd_integration.default_user');
        if (!this.FALLBACK_USER_ID) {
            gs.warn('PagerDutySync: x_pd_integration.default_user is not set; escalation ' +
                'rules/layers with no active or resolvable member will be built with a blank ' +
                'user id, which PagerDuty will reject');
        }

        // Cosmetic only 
        this.ROLE_CANONICALIZATION = {
            'Primary': 'Primary',
            'Secondary': 'Secondary',
            'Tertiary': 'Tertiary',
            'Regional DBA Manager': 'Regional DBA Manager',
            'Regional DBA manager': 'Regional DBA Manager',
            'Regional DBA Manger': 'Regional DBA Manager',
            'Regional DBA manger': 'Regional DBA Manager',
            'DBA Chapter Lead': 'DBA Chapter Lead',
            'DBA Chapter lead': 'DBA Chapter Lead',
            'DBA ChapterLead': 'DBA Chapter Lead',
            'Chapter Lead': 'Chapter Lead'
        };

        // Map common timezone aliases to the canonical IANA names PagerDuty expects
        this.TZ_CANONICAL_ALIASES = {
            'US/Eastern': 'America/New_York',
            'US/Central': 'America/Chicago',
            'US/Mountain': 'America/Denver',
            'US/Pacific': 'America/Los_Angeles',
            'US/Arizona': 'America/Phoenix',
            'US/Alaska': 'America/Anchorage',
            'US/Hawaii': 'Pacific/Honolulu',
            'Mexico/General': 'America/Mexico_City',
            'Canada/Eastern': 'America/Toronto',
            'Asia/Manila': 'Asia/Singapore'
        };

        this.NUM_LOOPS = 2;
        this.CATCH_ALL_DELAY_MINUTES = 30;
        this.HANDLED_CATCH_ALL_TYPES = {'Notify Group Manager': true};
        this.ROTATION_ORDER_SENTINEL_THRESHOLD = 1000;
        this.MAX_RESTRICTED_WINDOW_HOURS = 20;

        this._placeholderCounter = {schedule: 0, escalation_policy: 0};
    },

    // ------------------------------------------------------------------------------
    // PUBLIC ENTRY POINTS
    // ------------------------------------------------------------------------------

    // Sync every enrolled group (see u_pagerduty_sync_group). dryRun defaults to true
    // for safety when called programmatically (e.g. from a Background Script); UI
    // Actions should pass false explicitly once they've been tested.
    syncAll: function(dryRun) {
        dryRun = (dryRun === false) ? false : true;
        var asOf = new GlideDateTime();
        var collected = {schedules: [], escalation_policies: []};
        var groupNames = this._enrolledGroupNames();
        for (var i = 0; i < groupNames.length; i++) {
            this._syncOneGroup(groupNames[i], asOf, dryRun, collected);
        }
        gs.info('PagerDutySync.syncAll ' + (dryRun ? '[DRY RUN] ' : '[LIVE] ') +
            'complete: ' + collected.schedules.length + ' schedule action(s), ' +
            collected.escalation_policies.length + ' escalation policy action(s)');
        gs.info(JSON.stringify(collected, null, 2));
        return collected;
    },

    // Sync a single group by its exact name (must be enrolled in u_pagerduty_sync_group).
    syncGroup: function(groupName, dryRun) {
        dryRun = (dryRun === false) ? false : true;
        if (!this.isEnrolled(groupName)) {
            gs.warn('PagerDutySync.syncGroup: ' + groupName + ' is not enrolled in ' +
                this.SYNC_GROUP_TABLE + '; nothing to do');
            return null;
        }
        var asOf = new GlideDateTime();
        var collected = {schedules: [], escalation_policies: []};
        this._syncOneGroup(groupName, asOf, dryRun, collected);
        gs.info('PagerDutySync.syncGroup(' + groupName + ') ' + (dryRun ? '[DRY RUN] ' : '[LIVE] ') + 'complete');
        gs.info(JSON.stringify(collected, null, 2));
        return collected;
    },

    // Returns true if `groupName` is enrolled in u_pagerduty_sync_group. This is the
    // one place that knows what "enrolled" means -- the Business Rule and contextual
    // UI Action condition scripts call this directly instead of each keeping their
    // own copy of the check.
    isEnrolled: function(groupName) {
        if (!groupName) return false;
        var gr = new GlideRecord(this.SYNC_GROUP_TABLE);
        gr.addQuery('u_group.name', groupName);
        gr.query();
        return gr.next();
    },

    _enrolledGroupNames: function() {
        var names = [];
        var gr = new GlideRecord(this.SYNC_GROUP_TABLE);
        gr.query();
        while (gr.next()) {
            if (gr.u_group.name) names.push(gr.u_group.name.toString());
        }
        return names;
    },

    // Resolve a group to sync from a specific record -- a cmn_rota row (syncs the
    // whole group that rota belongs to, since our escalation policies are built per
    // GROUP, not per region -- there's no such thing as "just sync one region" for a
    // follow_the_sun group) or a sys_user_group row (syncs it directly if it's
    // enrolled in u_pagerduty_sync_group). Used by the contextual UI Action and the
    // Business Rule so both can share one resolution path regardless of which table
    // they fire from.
    syncForRecord: function(tableName, sysId, dryRun) {
        var groupName = null;
        if (tableName === 'cmn_rota') {
            var rotaGr = new GlideRecord('cmn_rota');
            if (rotaGr.get(sysId)) {
                groupName = rotaGr.group.name.toString();
            }
        } else if (tableName === 'sys_user_group') {
            var groupGr = new GlideRecord('sys_user_group');
            if (groupGr.get(sysId)) {
                groupName = groupGr.getValue('name');
            }
        } else {
            gs.warn('PagerDutySync.syncForRecord: unsupported table ' + tableName);
            return null;
        }
        if (!groupName) {
            gs.warn('PagerDutySync.syncForRecord: could not resolve a group name from ' + tableName + ' ' + sysId);
            return null;
        }
        return this.syncGroup(groupName, dryRun);
    },

    _syncOneGroup: function(groupName, asOf, dryRun, collected) {
        var snow = this._loadSnowData(groupName);
        var coverageWindows = this._loadCoverageWindows(snow);
        var classification = this._classifyGroup(groupName, snow, coverageWindows);
        gs.info('classified "' + groupName + '" as ' + classification.shape +
            (classification.reason ? (' (' + classification.reason + ')') : ''));

        if (classification.shape === 'single_region') {
            this._buildSingleRegionEscalationPolicies(groupName, snow, asOf, dryRun, collected);
        } else if (classification.shape === 'follow_the_sun') {
            this._buildFollowTheSunEscalationPolicy(groupName, snow, coverageWindows, asOf, dryRun, collected);
        } else {
            this._buildBestEffortEscalationPolicy(groupName, snow, coverageWindows, asOf, dryRun, collected);
        }
    },

    _loadSnowData: function(groupName) {
        var rotaBySysId = {};
        var rotaGr = new GlideRecord('cmn_rota');
        rotaGr.addQuery('group.name', groupName);
        rotaGr.query();
        while (rotaGr.next()) {
            rotaBySysId[rotaGr.getUniqueValue()] = {
                sys_id: rotaGr.getUniqueValue(),
                name: rotaGr.getValue('name'),
                group: groupName,
                schedule_sys_id: rotaGr.schedule.toString(),
                schedule_time_zone: rotaGr.schedule.time_zone ? rotaGr.schedule.time_zone.toString() : '',
                catch_all: rotaGr.getValue('catch_all') || '',
                group_manager_email: rotaGr.group.manager.email ? rotaGr.group.manager.email.toString() : ''
            };
        }

        var rosterBySysId = {};
        var rosterByRotaSysId = {};
        var rosterGr = new GlideRecord('cmn_rota_roster');
        rosterGr.addQuery('rota.group.name', groupName);
        rosterGr.query();
        while (rosterGr.next()) {
            var rotaSysId = rosterGr.rota.toString();
            if (!rotaBySysId.hasOwnProperty(rotaSysId)) continue; // defensive; shouldn't happen given the query above
            var rosterRow = {
                sys_id: rosterGr.getUniqueValue(),
                name: rosterGr.getValue('name'),
                order: rosterGr.getValue('order'),
                time_before_escalation: rosterGr.getValue('time_before_escalation'),
                rotation_interval_count: rosterGr.getValue('rotation_interval_count'),
                rotation_interval_type: rosterGr.getValue('rotation_interval_type'),
                rotation_start_date: rosterGr.getValue('rotation_start_date'),
                rotation_start_time: rosterGr.getValue('rotation_start_time'),
                rota_sys_id: rotaSysId
            };
            rosterBySysId[rosterRow.sys_id] = rosterRow;
            rosterByRotaSysId[rotaSysId] = rosterByRotaSysId[rotaSysId] || [];
            rosterByRotaSysId[rotaSysId].push(rosterRow);
        }

        var membersByRosterSysId = {};
        var memberGr = new GlideRecord('cmn_rota_member');
        memberGr.addQuery('roster.rota.group.name', groupName);
        memberGr.query();
        while (memberGr.next()) {
            var rosterSysId = memberGr.roster.toString();
            if (!rosterBySysId.hasOwnProperty(rosterSysId)) continue;
            var memberRow = {
                sys_id: memberGr.getUniqueValue(),
                order: memberGr.getValue('order'),
                from: memberGr.getValue('from'),
                to: memberGr.getValue('to'),
                member_email: memberGr.member.email ? memberGr.member.email.toString() : ''
            };
            membersByRosterSysId[rosterSysId] = membersByRosterSysId[rosterSysId] || [];
            membersByRosterSysId[rosterSysId].push(memberRow);
        }

        return {
            rotaBySysId: rotaBySysId,
            rosterBySysId: rosterBySysId,
            rosterByRotaSysId: rosterByRotaSysId,
            membersByRosterSysId: membersByRosterSysId,
            rotasForGroup: function() {
                var out = [];
                for (var sid in rotaBySysId) { if (rotaBySysId.hasOwnProperty(sid)) out.push(rotaBySysId[sid]); }
                return out;
            },
            rostersForGroup: function() {
                var out = [];
                for (var sid in rosterBySysId) { if (rosterBySysId.hasOwnProperty(sid)) out.push(rosterBySysId[sid]); }
                return out;
            }
        };
    },

    // ------------------------------------------------------------------------------
    // ROLE / REGION NAME HELPERS
    // ------------------------------------------------------------------------------

    // Cosmetic only
    _canonicalizeRole: function(rawName) {
        rawName = (rawName || '').replace(/^\s+|\s+$/g, '');
        if (this.ROLE_CANONICALIZATION.hasOwnProperty(rawName)) {
            return this.ROLE_CANONICALIZATION[rawName];
        }
        var normalized = rawName.replace(/\s+/g, ' ');
        gs.debug('unrecognized roster role name "' + rawName + '"; using it as-is ("' + normalized + '")');
        return normalized;
    },

    // Whether a roster level should target a single fixed user rather than a full
    // rotating PagerDuty schedule -- determined from actual membership data instead
    // of matching the roster's name against a hardcoded list of manager/lead labels.
    // There's no out-of-box "no rotation" value on cmn_rota_roster.rotation_interval_
    // type to key off instead (confirmed against public ServiceNow community docs -
    // only Daily/Weekly exist out of the box, though a custom choice is possible on
    // any given instance and worth a quick check). The real test used here: has this
    // roster ever had two members concurrently active? If not, it's functionally a
    // single-incumbent role even if the named individual has changed over time -
    // PagerDuty only needs a rotating multi-person schedule when more than one person
    // has actually shared the responsibility at the same time.
    _isSingleIncumbent: function(memberRows) {
        var rows = [];
        for (var i = 0; i < memberRows.length; i++) {
            // Sentinel-order rows are placeholders (see ROTATION_ORDER_SENTINEL_
            // THRESHOLD / _activeMemberRows), not real concurrent membership.
            if (this._parseOrder(memberRows[i].order) >= this.ROTATION_ORDER_SENTINEL_THRESHOLD) continue;
            rows.push(memberRows[i]);
        }
        for (var a = 0; a < rows.length; a++) {
            for (var b = a + 1; b < rows.length; b++) {
                if (this._memberRangesOverlap(rows[a], rows[b])) return false;
            }
        }
        return true;
    },

    // Two member date ranges overlap unless one provably ends before the other
    // starts; a blank from/to is treated as open-ended (unbounded).
    _memberRangesOverlap: function(rowA, rowB) {
        var aTo = rowA.to ? new GlideDateTime(rowA.to + ' 00:00:00') : null;
        var bFrom = rowB.from ? new GlideDateTime(rowB.from + ' 00:00:00') : null;
        if (aTo && bFrom && aTo.compareTo(bFrom) < 0) return false;
        var bTo = rowB.to ? new GlideDateTime(rowB.to + ' 00:00:00') : null;
        var aFrom = rowA.from ? new GlideDateTime(rowA.from + ' 00:00:00') : null;
        if (bTo && aFrom && bTo.compareTo(aFrom) < 0) return false;
        return true;
    },

    _canonicalizeTimeZone: function(tzName) {
        return this.TZ_CANONICAL_ALIASES.hasOwnProperty(tzName) ? this.TZ_CANONICAL_ALIASES[tzName] : tzName;
    },

    _parseOrder: function(orderStr) {
        return parseInt(String(orderStr).replace(/,/g, ''), 10);
    },

    // ------------------------------------------------------------------------------
    // COVERAGE WINDOWS (from cmn_schedule_span). Reads every span row for a
    // schedule and merges them, instead of assuming exactly one Weekly row exists
    // and falling back to a cross-group majority vote when that assumption didn't
    // hold. Per KB0552555 (ServiceNow Known Error, confirmed for on-call rota
    // behavior specifically): the on-call engine only honors a span's `type` field
    // when it's "Excluded" -- every other type value (including the common blank/
    // --None--, and informational ones like "Time Off") is ignored for coverage
    // purposes and contributes the same way. So "read all the rows" mostly means:
    // union whatever's not Excluded, subtract whatever is. See build_escalation_
    // policies.py's load_coverage_windows() for why this mattered in the CSV/
    // majority-vote version this replaces -- that mechanism is gone now because each
    // rota's coverage is computed correctly on its own, not inferred from siblings.
    // ------------------------------------------------------------------------------

    // Returns {rota_sys_id: {days: [1-7,...], startTimeOfDay: 'HH:MM:SS', durationSeconds: N}}
    _loadCoverageWindows: function(snow) {
        var ownWindow = {};
        var rotas = snow.rotasForGroup();
        for (var i = 0; i < rotas.length; i++) {
            var rota = rotas[i];
            if (!rota.schedule_sys_id) continue;
            var window = this._computeCoverageWindow(rota.schedule_sys_id, rota.name);
            if (window) ownWindow[rota.sys_id] = window;
        }
        return ownWindow;
    },

    // Reads and merges every recurring cmn_schedule_span row for one schedule into a
    // single {days, startTimeOfDay, durationSeconds} window, or returns null if
    // there's nothing usable. Only Weekly/Daily repeat_type rows are considered --
    // that's the only shape PagerDuty's own schedule restrictions (daily_restriction/
    // weekly_restriction) can express, so a Monthly/Yearly/one-time span isn't a gap
    // here, it's just out of scope for "the steady-state weekly coverage window."
    //
    // NOTE on start_date_time/end_date_time: these use an undocumented "Schedule
    // Date/Time" field type whose raw getValue() is NOT the usual GlideDateTime
    // 'yyyy-MM-dd HH:mm:ss' format -- it's compact ISO8601 ('yyyyMMdd'T'HHmmss'Z',
    // e.g. '20251026T010000Z'). Feeding that directly into gs.dateDiff()/
    // GlideDateTime() silently fails to parse it (confirmed: produced a 0 day/second
    // diff for every pair checked, including pairs months apart), which would have
    // made every duration computation here come out <= 0 and every row get skipped --
    // i.e. every coverage window in this whole file would have silently computed as
    // "none," and every group would have misclassified as needs_review. See
    // _parseScheduleDateTime(), used below to normalize before either API touches it.
    _computeCoverageWindow: function(scheduleSysId, rotaLabel) {
        var spanGr = new GlideRecord('cmn_schedule_span');
        spanGr.addQuery('schedule', scheduleSysId);
        spanGr.addQuery('repeat_type', 'IN', 'weekly,daily');
        spanGr.query();

        var includeWindows = [];
        var excludeWindows = [];
        while (spanGr.next()) {
            var startNormalized = this._parseScheduleDateTime(spanGr.getValue('start_date_time'));
            var endNormalized = this._parseScheduleDateTime(spanGr.getValue('end_date_time'));
            if (!startNormalized || !endNormalized) continue;

            var durationSeconds = gs.dateDiff(startNormalized, endNormalized, true);
            if (durationSeconds === null || durationSeconds <= 0 || (durationSeconds / 3600) >= this.MAX_RESTRICTED_WINDOW_HOURS) {
                continue;
            }
            var days = (spanGr.getValue('repeat_type') === 'daily')
                ? [1, 2, 3, 4, 5, 6, 7]
                : this._decodeDaysOfWeek(spanGr.getValue('days_of_week'));
            var window = {
                days: days,
                startTimeOfDay: this._timeOfDayFromGlideDateTime(new GlideDateTime(startNormalized)),
                durationSeconds: durationSeconds
            };
            if ((spanGr.getValue('type') || '').toLowerCase() === 'exclude') {
                excludeWindows.push(window);
            } else {
                includeWindows.push(window);
            }
        }

        if (includeWindows.length === 0) return null;
        if (includeWindows.length === 1 && excludeWindows.length === 0) {
            return includeWindows[0]; // common case -- same result as the old single-row logic
        }
        return this._mergeSpanWindows(rotaLabel, includeWindows, excludeWindows);
    },

    // Normalizes cmn_schedule_span's compact-ISO8601 date value ('yyyyMMdd'T'HHmmss'Z')
    // to the canonical 'yyyy-MM-dd HH:mm:ss' format GlideDateTime/gs.dateDiff actually
    // understand. See the NOTE above _computeCoverageWindow for why this exists.
    _parseScheduleDateTime: function(raw) {
        var m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(raw || '');
        if (!m) {
            gs.error('PagerDutySync: cmn_schedule_span date value "' + raw + '" did not match the expected ' +
                'compact ISO8601 format; treating as unparseable');
            return null;
        }
        return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6];
    },

    // Merges multiple coverage-contributing spans and subtracts any Excluded spans,
    // per day of week, using real interval union/subtraction. Only returns a result
    // if it collapses to ONE time-of-day window shared by every covered day -- that's
    // the only shape _buildRestrictions() can turn into a PagerDuty restriction. A
    // genuinely more complex shape (different hours on different days, or a gap left
    // by an exclusion) isn't something to guess through -- it logs why and returns
    // null, same "no usable window" fallback as the old code had for unexpected data,
    // just with a clearer reason attached.
    _mergeSpanWindows: function(rotaLabel, includeWindows, excludeWindows) {
        var includeIntervalsByDay = {};
        var excludeIntervalsByDay = {};
        for (var i = 0; i < includeWindows.length; i++) {
            this._addIntervalPerDay(includeIntervalsByDay, includeWindows[i]);
        }
        for (var e = 0; e < excludeWindows.length; e++) {
            this._addIntervalPerDay(excludeIntervalsByDay, excludeWindows[e]);
        }

        var resultDays = [];
        var commonStart = null, commonDuration = null;
        for (var day = 1; day <= 7; day++) {
            var merged = this._mergeIntervals(includeIntervalsByDay[day] || []);
            if (excludeIntervalsByDay[day]) {
                merged = this._subtractIntervals(merged, this._mergeIntervals(excludeIntervalsByDay[day]));
            }
            if (merged.length === 0) continue;
            if (merged.length > 1) {
                gs.warn('"' + rotaLabel + '" has a non-contiguous coverage window on day ' + day + ' after ' +
                    'merging cmn_schedule_span rows; this shape can\'t be represented as a single PagerDuty ' +
                    'restriction -- skipping, treat as needs review');
                return null;
            }
            var start = merged[0][0], duration = merged[0][1] - merged[0][0];
            if (commonStart === null) {
                commonStart = start;
                commonDuration = duration;
            } else if (start !== commonStart || duration !== commonDuration) {
                gs.warn('"' + rotaLabel + '" has a different time-of-day coverage window on different days ' +
                    'after merging cmn_schedule_span rows; this shape can\'t be represented as a single ' +
                    'PagerDuty restriction -- skipping, treat as needs review');
                return null;
            }
            resultDays.push(day);
        }
        if (resultDays.length === 0) return null;
        return {
            days: resultDays,
            startTimeOfDay: this._secondsToTimeOfDay(commonStart),
            durationSeconds: commonDuration
        };
    },

    _addIntervalPerDay: function(intervalsByDay, window) {
        var startSec = this._timeOfDayToSeconds(window.startTimeOfDay);
        var endSec = startSec + window.durationSeconds;
        for (var d = 0; d < window.days.length; d++) {
            var day = window.days[d];
            intervalsByDay[day] = intervalsByDay[day] || [];
            intervalsByDay[day].push([startSec, endSec]);
        }
    },

    // Standard interval union: sorts by start, merges overlapping/touching pairs.
    _mergeIntervals: function(intervals) {
        if (intervals.length === 0) return [];
        var sorted = intervals.slice().sort(function(a, b) { return a[0] - b[0]; });
        var merged = [sorted[0].slice()];
        for (var i = 1; i < sorted.length; i++) {
            var last = merged[merged.length - 1];
            if (sorted[i][0] <= last[1]) {
                last[1] = Math.max(last[1], sorted[i][1]);
            } else {
                merged.push(sorted[i].slice());
            }
        }
        return merged;
    },

    // Standard interval subtraction: removes each subtractor from every interval,
    // splitting an interval in two if the subtractor falls in the middle of it.
    _subtractIntervals: function(intervals, subtractors) {
        var result = intervals;
        for (var s = 0; s < subtractors.length; s++) {
            var sub = subtractors[s];
            var next = [];
            for (var i = 0; i < result.length; i++) {
                var cur = result[i];
                if (sub[1] <= cur[0] || sub[0] >= cur[1]) {
                    next.push(cur);
                    continue;
                }
                if (sub[0] > cur[0]) next.push([cur[0], Math.min(sub[0], cur[1])]);
                if (sub[1] < cur[1]) next.push([Math.max(sub[1], cur[0]), cur[1]]);
            }
            result = next;
        }
        return result;
    },

    _timeOfDayToSeconds: function(hhmmss) {
        var parts = hhmmss.split(':');
        return (parseInt(parts[0], 10) * 3600) + (parseInt(parts[1], 10) * 60) + parseInt(parts[2], 10);
    },

    _secondsToTimeOfDay: function(seconds) {
        var h = Math.floor(seconds / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        var s = seconds % 60;
        var pad = function(n) { return (n < 10 ? '0' : '') + n; };
        return pad(h) + ':' + pad(m) + ':' + pad(s);
    },

    _decodeDaysOfWeek: function(digits) {
        var days = [];
        digits = digits || '';
        for (var i = 0; i < digits.length; i++) {
            var d = parseInt(digits.charAt(i), 10);
            if (!isNaN(d)) days.push(d);
        }
        days.sort(function(a, b) { return a - b; });
        return days;
    },

    _daysAreEveryDay: function(days) {
        if (days.length !== 7) return false;
        for (var i = 1; i <= 7; i++) {
            if (days.indexOf(i) === -1) return false;
        }
        return true;
    },

    _timeOfDayFromGlideDateTime: function(gdt) {
        // getValue() on a GlideDateTime returns 'yyyy-MM-dd HH:mm:ss' (instance/UTC
        // internal format); take just the time portion.
        var value = gdt.getValue();
        var parts = value.split(' ');
        return parts.length > 1 ? parts[1] : '00:00:00';
    },

    _buildRestrictions: function(window) {
        if (this._daysAreEveryDay(window.days)) {
            return [{
                type: 'daily_restriction',
                start_time_of_day: window.startTimeOfDay,
                duration_seconds: window.durationSeconds
            }];
        }
        var restrictions = [];
        for (var i = 0; i < window.days.length; i++) {
            restrictions.push({
                type: 'weekly_restriction',
                start_day_of_week: window.days[i],
                start_time_of_day: window.startTimeOfDay,
                duration_seconds: window.durationSeconds
            });
        }
        return restrictions;
    },

    // ------------------------------------------------------------------------------
    // SHAPE CLASSIFICATION
    // ------------------------------------------------------------------------------

    _classifyGroup: function(groupName, snow, coverageWindows) {
        var rotas = snow.rotasForGroup();
        if (rotas.length < 2) {
            return {shape: 'single_region'};
        }

        var rosterCountsByRota = {};
        for (var i = 0; i < rotas.length; i++) {
            var rota = rotas[i];
            rosterCountsByRota[rota.sys_id] = (snow.rosterByRotaSysId[rota.sys_id] || []).length;
        }
        var counts = [];
        for (var sid in rosterCountsByRota) { if (rosterCountsByRota.hasOwnProperty(sid)) counts.push(rosterCountsByRota[sid]); }
        var allSame = true, anyZero = false;
        for (var c = 0; c < counts.length; c++) {
            if (counts[c] === 0) anyZero = true;
            if (counts[c] !== counts[0]) allSame = false;
        }
        if (!allSame || anyZero) {
            return {shape: 'needs_review', reason: 'regions do not all have the same number of escalation levels'};
        }

        var missing = [];
        for (var j = 0; j < rotas.length; j++) {
            if (!coverageWindows.hasOwnProperty(rotas[j].sys_id)) missing.push(rotas[j].name);
        }
        if (missing.length > 0) {
            return {shape: 'needs_review', reason: 'consistent escalation levels, but no usable coverage window for: ' + missing.join(', ')};
        }
        return {shape: 'follow_the_sun'};
    },

    // ------------------------------------------------------------------------------
    // SCHEDULE LAYER / USER RESOLUTION
    // ------------------------------------------------------------------------------

    _resolveUser: function(email, emailToId) {
        email = (email || '').replace(/^\s+|\s+$/g, '').toLowerCase();
        if (email && emailToId.hasOwnProperty(email)) {
            return {id: emailToId[email], matched: true};
        }
        return {id: this.FALLBACK_USER_ID, matched: false};
    },

    _activeMemberRows: function(memberRows, asOf) {
        var active = [];
        var droppedSentinels = 0, droppedFuture = 0;
        for (var i = 0; i < memberRows.length; i++) {
            var row = memberRows[i];
            if (row.to) {
                var toGdt = new GlideDateTime(row.to + ' 00:00:00');
                if (toGdt.compareTo(asOf) < 0) continue;
            }
            if (row.from) {
                var fromGdt = new GlideDateTime(row.from + ' 00:00:00');
                if (fromGdt.compareTo(asOf) > 0) { droppedFuture++; continue; }
            }
            var orderNum = this._parseOrder(row.order);
            if (orderNum >= this.ROTATION_ORDER_SENTINEL_THRESHOLD) { droppedSentinels++; continue; }
            active.push(row);
        }
        if (droppedSentinels) gs.info('  note: dropped ' + droppedSentinels + ' sentinel-order member row(s)');
        if (droppedFuture) gs.info('  note: dropped ' + droppedFuture + ' member row(s) not yet started');
        var self = this;
        active.sort(function(a, b) { return self._parseOrder(a.order) - self._parseOrder(b.order); });
        return active;
    },

    _pickDirectUser: function(memberRows, asOf, emailToId) {
        var active = this._activeMemberRows(memberRows, asOf);
        if (active.length === 0) return this.FALLBACK_USER_ID;
        if (active.length > 1) {
            gs.warn('single-incumbent role has ' + active.length + ' active members; using the lowest rotation-order one');
        }
        return this._resolveUser(active[0].member_email, emailToId).id;
    },

    _buildScheduleLayer: function(rosterRow, rotaRow, memberRows, asOf, emailToId) {
        var tzName = rotaRow.schedule_time_zone;

        var intervalType = rosterRow.rotation_interval_type;
        var intervalCount = parseInt(rosterRow.rotation_interval_count, 10);
        if (isNaN(intervalCount) || intervalCount < 1) intervalCount = 1;
        if (intervalType !== 'Weekly') {
            gs.warn('unhandled rotation_interval_type "' + intervalType + '" on roster ' + rosterRow.sys_id + '; treating as weekly anyway');
        }
        var rotationTurnLengthSeconds = intervalCount * 7 * 24 * 3600;

        // rotation_start_date is a plain Date field ("yyyy-MM-dd" internal value);
        // rotation_start_time is a plain Time field ("HH:mm:ss"). Combine and localize
        // to the rota's own schedule time zone for the ISO8601 string PagerDuty needs.
        var startIso = this._localizedIso(rosterRow.rotation_start_date, rosterRow.rotation_start_time, tzName);

        var active = this._activeMemberRows(memberRows, asOf);
        var users = [];
        var fallbackCount = 0;
        for (var i = 0; i < active.length; i++) {
            var resolved = this._resolveUser(active[i].member_email, emailToId);
            if (!resolved.matched) fallbackCount++;
            users.push({user: {id: resolved.id, type: 'user_reference'}});
        }
        if (users.length === 0) {
            gs.warn('roster ' + rosterRow.sys_id + ' (' + rosterRow.name + ') has no currently-active ' +
                'members (no member rows at all, or none currently active); using fallback user for the whole layer');
            users = [{user: {id: this.FALLBACK_USER_ID, type: 'user_reference'}}];
            fallbackCount = 1;
        }
        if (fallbackCount) {
            gs.info('  note: ' + fallbackCount + '/' + users.length + ' slot(s) in "' + rosterRow.name +
                '" (' + rotaRow.name + ') filled with the fallback user');
        }

        return {
            name: rotaRow.name + ' - ' + rosterRow.name,
            start: startIso,
            rotation_virtual_start: startIso,
            rotation_turn_length_seconds: rotationTurnLengthSeconds,
            users: users
        };
    },

    // Converts a wall-clock date+time in an arbitrary IANA time zone to a UTC ISO8601
    // string, using only supported Glide server APIs -- no Packages.java.* interop,
    // so unlike the previous java.time-based version this can't be blocked by Script
    // Include Java-interop sandboxing.
    //
    // The trick: GlideDateTime.setDisplayValueInternal() takes a plain
    // 'yyyy-MM-dd HH:mm:ss' string and interprets it in the CURRENT SESSION's time
    // zone, converting it to the correct UTC instant internally (DST included) --
    // unlike setDisplayValue(), it isn't sensitive to the session's locale date
    // format, so it's safe to feed it dateStr/timeStr's fixed internal format
    // directly. So: temporarily point the session at the rota's own time zone, do the
    // conversion, then restore the session's original time zone immediately
    // (try/finally keeps that window synchronous and narrow -- each transaction has
    // its own GlideSession, so this can't leak into a concurrent request).
    //
    // No offset formatting is needed either: PagerDuty's start/rotation_virtual_start
    // fields just need a correct instant -- a plain UTC 'Z' timestamp is exactly as
    // valid as an offset-qualified one for that (the schedule's own time_zone field,
    // set separately, is what governs how the *recurring* rotation is interpreted
    // going forward).
    _localizedIso: function(dateStr, timeStr, tzName) {
        var session = gs.getSession();
        var originalTzName = session.getTimeZoneName();
        try {
            session.setTimeZoneName(tzName);
            var gdt = new GlideDateTime();
            gdt.setDisplayValueInternal(dateStr + ' ' + timeStr);
            return gdt.getValue().replace(' ', 'T') + 'Z';
        } catch (e) {
            gs.error('PagerDutySync: failed to localize ' + dateStr + ' ' + timeStr + ' to ' + tzName +
                ' (' + e + '); falling back to a bare UTC-offset-less string, which PagerDuty will likely reject');
            return dateStr + 'T' + timeStr;
        } finally {
            session.setTimeZoneName(originalTzName);
        }
    },

    // ------------------------------------------------------------------------------
    // CATCH-ALL
    // ------------------------------------------------------------------------------

    _buildCatchAllRule: function(rotaRows, emailToId) {
        var catchAllTypes = {};
        for (var i = 0; i < rotaRows.length; i++) {
            var v = (rotaRows[i].catch_all || '').replace(/^\s+|\s+$/g, '');
            if (v) catchAllTypes[v] = true;
        }
        var anyType = false;
        for (var t in catchAllTypes) { if (catchAllTypes.hasOwnProperty(t)) anyType = true; }
        if (!anyType) return null;

        var unhandled = [];
        for (var t2 in catchAllTypes) {
            if (catchAllTypes.hasOwnProperty(t2) && !this.HANDLED_CATCH_ALL_TYPES.hasOwnProperty(t2)) unhandled.push(t2);
        }
        if (unhandled.length > 0) {
            gs.warn('catch_all type(s) [' + unhandled.join(', ') + '] found but not handled; no rule added for these');
        }
        if (!catchAllTypes.hasOwnProperty('Notify Group Manager')) return null;

        var managerEmails = {};
        for (var j = 0; j < rotaRows.length; j++) {
            var em = (rotaRows[j].group_manager_email || '').replace(/^\s+|\s+$/g, '');
            if (em) managerEmails[em] = true;
        }
        var emailList = [];
        for (var e in managerEmails) { if (managerEmails.hasOwnProperty(e)) emailList.push(e); }
        emailList.sort();

        var userId;
        if (emailList.length === 0) {
            gs.warn("catch_all is 'Notify Group Manager' but group.manager.email is blank on every rota; using the fallback user");
            userId = this.FALLBACK_USER_ID;
        } else {
            if (emailList.length > 1) {
                gs.warn('this group\'s rotas disagree on group.manager.email [' + emailList.join(', ') + ']; using the first');
            }
            userId = this._resolveUser(emailList[0], emailToId).id;
        }

        return {
            escalation_delay_in_minutes: this.CATCH_ALL_DELAY_MINUTES,
            targets: [{id: userId, type: 'user_reference'}]
        };
    },

    // ------------------------------------------------------------------------------
    // PAGERDUTY REST HELPERS
    // ------------------------------------------------------------------------------

    _pdGetAllUsers: function() {
        var rest = new x_pd_integration.PagerDuty_REST();
        var users = rest.getAllItemsThrowable('users', function(user) { return user; });
        var emailToId = {};
        for (var i = 0; i < users.length; i++) {
            if (users[i].email) emailToId[users[i].email.toLowerCase().replace(/^\s+|\s+$/g, '')] = users[i].id;
        }
        return emailToId;
    },

    _findByName: function(endpoint, name) {
        var rest = new x_pd_integration.PagerDuty_REST();
        // PagerDuty's ?query= is a substring match, not exact -- getAllItemsThrowable
        // pages through everything it returns and we filter to an exact name match
        // below, same as the old hand-rolled pagination did.
        var found = rest.getAllItemsThrowable(endpoint + '?query=' + gs.urlEncode(name), function(item) { return item; });
        var matches = [];
        for (var i = 0; i < found.length; i++) {
            if (found[i].name === name) matches.push(found[i]);
        }
        if (matches.length > 1) {
            gs.warn('found ' + matches.length + ' existing ' + endpoint + ' named "' + name + '"; using the first (' +
                matches[0].id + ') and leaving the others as-is');
        }
        return matches.length ? matches[0] : null;
    },

    _nextPlaceholderId: function(kind) {
        this._placeholderCounter[kind] = (this._placeholderCounter[kind] || 0) + 1;
        return kind + '-' + this._placeholderCounter[kind];
    },

    // Applied to every top-level schedule/escalation_policy name this port writes
    // (not to schedule LAYER names, which aren't top-level PagerDuty objects and
    // aren't what someone scanning PagerDuty's schedule/EP list is looking at) --
    // see SYNCED_NAME_PREFIX in initialize().
    _syncedName: function(name) {
        return this.SYNCED_NAME_PREFIX + name;
    },

    _upsertSchedule: function(payload, dryRun, collected) {
        var name = payload.schedule.name;
        var existing = this._findByName('schedules', name);
        var action = existing ? 'update' : 'create';

        if (existing) {
            var rest = new x_pd_integration.PagerDuty_REST();
            var current = rest.getRESTThrowable('schedules/' + existing.id).data;
            var currentLayersByName = {};
            var currentLayers = current.schedule.schedule_layers;
            for (var i = 0; i < currentLayers.length; i++) {
                currentLayersByName[currentLayers[i].name] = currentLayers[i].id;
            }
            var matched = 0;
            for (var j = 0; j < payload.schedule.schedule_layers.length; j++) {
                var layer = payload.schedule.schedule_layers[j];
                if (currentLayersByName.hasOwnProperty(layer.name)) {
                    layer.id = currentLayersByName[layer.name];
                    matched++;
                }
            }
            if (matched < currentLayers.length) {
                gs.info('  note: "' + name + '" currently has ' + currentLayers.length + ' layer(s) on PagerDuty but ' +
                    'only ' + matched + ' matched by name to the new payload; the rest will be removed by this update');
            }
        }

        collected.schedules.push({action: action, id: existing ? existing.id : null, payload: payload});

        if (dryRun) {
            if (existing) {
                gs.info('  [dry run] would UPDATE schedule "' + name + '" (' + existing.id + ')');
                return existing.id;
            }
            gs.info('  [dry run] would CREATE schedule "' + name + '"');
            return this._nextPlaceholderId('schedule');
        }

        var rest2 = new x_pd_integration.PagerDuty_REST();
        var result;
        if (existing) {
            result = rest2.putRESTThrowable('schedules/' + existing.id, payload).data;
            gs.info('updated schedule "' + name + '" -> ' + result.schedule.id);
        } else {
            result = rest2.postRESTThrowable('schedules', payload).data;
            gs.info('created schedule "' + name + '" -> ' + result.schedule.id);
        }
        return result.schedule.id;
    },

    _upsertEscalationPolicy: function(payload, dryRun, collected) {
        var name = payload.escalation_policy.name;
        var existing = this._findByName('escalation_policies', name);
        var action = existing ? 'update' : 'create';
        collected.escalation_policies.push({action: action, id: existing ? existing.id : null, payload: payload});

        if (dryRun) {
            if (existing) {
                gs.info('[dry run] would UPDATE escalation policy "' + name + '" (' + existing.id + ')');
                return existing.id;
            }
            gs.info('[dry run] would CREATE escalation policy "' + name + '"');
            return this._nextPlaceholderId('escalation_policy');
        }

        var rest = new x_pd_integration.PagerDuty_REST();
        var result;
        if (existing) {
            result = rest.putRESTThrowable('escalation_policies/' + existing.id, payload).data;
            gs.info('updated escalation policy "' + name + '" -> ' + result.escalation_policy.id);
        } else {
            result = rest.postRESTThrowable('escalation_policies', payload).data;
            gs.info('created escalation policy "' + name + '" -> ' + result.escalation_policy.id);
        }
        return result.escalation_policy.id;
    },

    // ------------------------------------------------------------------------------
    // ESCALATION RULE BUILDERS
    // ------------------------------------------------------------------------------

    _buildEscalationRule: function(rosterRow, rotaRow, snow, asOf, emailToId, dryRun, collected) {
        var memberRows = snow.membersByRosterSysId[rosterRow.sys_id] || [];
        var delayMinutes = Math.max(1, Math.round(parseInt(rosterRow.time_before_escalation, 10) / 60));

        var target;
        if (this._isSingleIncumbent(memberRows)) {
            target = {id: this._pickDirectUser(memberRows, asOf, emailToId), type: 'user_reference'};
        } else {
            var layer = this._buildScheduleLayer(rosterRow, rotaRow, memberRows, asOf, emailToId);
            var namePrefix = (rotaRow.name.indexOf(rotaRow.group) === 0) ? rotaRow.name : (rotaRow.group + ' - ' + rotaRow.name);
            var schedulePayload = {
                schedule: {
                    type: 'schedule',
                    name: this._syncedName(namePrefix + ' - ' + rosterRow.name),
                    description: this.SYNCED_DESCRIPTION,
                    time_zone: this._canonicalizeTimeZone(rotaRow.schedule_time_zone),
                    schedule_layers: [layer]
                }
            };
            var scheduleId = this._upsertSchedule(schedulePayload, dryRun, collected);
            target = {id: scheduleId, type: 'schedule_reference'};
        }
        return {escalation_delay_in_minutes: delayMinutes, targets: [target]};
    },

    // single_region: one EP per (region, group) -- trivial since there's only one region.
    _buildSingleRegionEscalationPolicies: function(groupName, snow, asOf, dryRun, collected) {
        var emailToId = this._emailToIdCache || (this._emailToIdCache = this._pdGetAllUsers());
        var rotas = snow.rotasForGroup();
        for (var i = 0; i < rotas.length; i++) {
            var rotaRow = rotas[i];
            var rosterRows = (snow.rosterByRotaSysId[rotaRow.sys_id] || []).slice();
            if (rosterRows.length === 0) {
                gs.warn(groupName + ' / ' + rotaRow.name + ' has no roster rows at all; skipping');
                continue;
            }
            var self = this;
            rosterRows.sort(function(a, b) { return self._parseOrder(a.order) - self._parseOrder(b.order); });

            var rules = [];
            for (var r = 0; r < rosterRows.length; r++) {
                rules.push(this._buildEscalationRule(rosterRows[r], rotaRow, snow, asOf, emailToId, dryRun, collected));
            }
            var catchAll = this._buildCatchAllRule([rotaRow], emailToId);
            if (catchAll) rules.push(catchAll);

            var epName = (rotaRow.name.indexOf(groupName) === 0) ? rotaRow.name : (groupName + ' - ' + rotaRow.name);
            var epPayload = {
                escalation_policy: {
                    type: 'escalation_policy',
                    name: this._syncedName(epName),
                    description: this.SYNCED_DESCRIPTION,
                    num_loops: this.NUM_LOOPS,
                    escalation_rules: rules
                }
            };
            this._upsertEscalationPolicy(epPayload, dryRun, collected);
        }
    },

    // follow_the_sun: one EP per GROUP, each level a single schedule made of one
    // time-restricted layer per region. Levels are grouped and sequenced by
    // rosterRow.order -- the field ServiceNow itself uses for escalation
    // sequencing -- rather than by matching each region's roster role name against
    // a hardcoded label list (_buildBestEffortEscalationPolicy already proves this
    // technique works for the other shape). This generalizes to any team's naming
    // convention for free, but it does assume `order` is assigned consistently
    // across regions for the same logical tier (e.g. every region's "first
    // responder" roster row really does carry the same order value) -- worth
    // confirming against real data; see README.md "Known gaps". The canonicalized
    // role name is still used, but only for the schedule's display name -- that's
    // cosmetic, not load-bearing for correctness.
    _buildFollowTheSunEscalationPolicy: function(groupName, snow, coverageWindows, asOf, dryRun, collected) {
        var emailToId = this._emailToIdCache || (this._emailToIdCache = this._pdGetAllUsers());
        var rotas = snow.rotasForGroup();

        var levels = {}; // order -> [{rosterRow, rotaRow}, ...]
        for (var i = 0; i < rotas.length; i++) {
            var rotaRow = rotas[i];
            var rosterRows = snow.rosterByRotaSysId[rotaRow.sys_id] || [];
            for (var j = 0; j < rosterRows.length; j++) {
                var orderNum = this._parseOrder(rosterRows[j].order);
                levels[orderNum] = levels[orderNum] || [];
                levels[orderNum].push({rosterRow: rosterRows[j], rotaRow: rotaRow});
            }
        }

        this._warnIfWindowsDontTile(groupName, rotas, coverageWindows);
        this._warnIfOrderLevelsDisagreeOnName(groupName, levels);

        var orderKeys = [];
        for (var order in levels) { if (levels.hasOwnProperty(order)) orderKeys.push(parseInt(order, 10)); }
        orderKeys.sort(function(a, b) { return a - b; });

        var rules = [];
        for (var k = 0; k < orderKeys.length; k++) {
            var entries = levels[orderKeys[k]];
            var levelLabel = this._pickLevelLabel(entries);
            var layers = [];
            var maxDelay = 1;
            for (var e = 0; e < entries.length; e++) {
                var rosterRow = entries[e].rosterRow;
                var rotaRow2 = entries[e].rotaRow;
                var memberRows = snow.membersByRosterSysId[rosterRow.sys_id] || [];
                var layer = this._buildScheduleLayer(rosterRow, rotaRow2, memberRows, asOf, emailToId);

                var window = coverageWindows[rotaRow2.sys_id];
                if (!window) {
                    gs.warn('no coverage window for "' + rotaRow2.name + '" (' + groupName + ' / ' + levelLabel +
                        ') despite this group being classified follow_the_sun; building this layer as 24/7 unrestricted -- treat as a bug');
                } else {
                    layer.restrictions = this._buildRestrictions(window);
                }
                layers.push(layer);
                maxDelay = Math.max(maxDelay, Math.round(parseInt(rosterRow.time_before_escalation, 10) / 60));
            }

            var schedulePayload = {
                schedule: {
                    type: 'schedule',
                    name: this._syncedName(groupName + ' - ' + levelLabel),
                    description: this.SYNCED_DESCRIPTION,
                    time_zone: this._canonicalizeTimeZone(entries[0].rotaRow.schedule_time_zone),
                    schedule_layers: layers
                }
            };
            var scheduleId = this._upsertSchedule(schedulePayload, dryRun, collected);
            rules.push({
                escalation_delay_in_minutes: maxDelay,
                targets: [{id: scheduleId, type: 'schedule_reference'}]
            });
        }

        var catchAll = this._buildCatchAllRule(rotas, emailToId);
        if (catchAll) rules.push(catchAll);

        var epPayload = {
            escalation_policy: {
                type: 'escalation_policy',
                name: this._syncedName(groupName),
                description: this.SYNCED_DESCRIPTION,
                num_loops: this.NUM_LOOPS,
                escalation_rules: rules
            }
        };
        this._upsertEscalationPolicy(epPayload, dryRun, collected);
    },

    // Picks a display label for an order-grouped level by majority vote across the
    // regions in it, instead of just canonicalizing whichever region happened to be
    // first in iteration order. Order is what makes this possible: because it's
    // already the mechanism grouping the "right" regions together (see
    // _buildFollowTheSunEscalationPolicy), the most common name *within that group*
    // is a much better signal for the correct label than either an arbitrary first
    // entry or ROLE_CANONICALIZATION's hardcoded typo list alone -- it naturally
    // picks a sensible label even for a typo variant nobody's cataloged, and (as a
    // side effect) tends to pick the "right" name even when one region's order value
    // is itself wrong (see _warnIfOrderLevelsDisagreeOnName, which still separately
    // flags that case rather than silently absorbing it here).
    _pickLevelLabel: function(entries) {
        var votes = {};
        for (var i = 0; i < entries.length; i++) {
            var canonical = this._canonicalizeRole(entries[i].rosterRow.name);
            votes[canonical] = (votes[canonical] || 0) + 1;
        }
        var winner = null, winnerCount = 0;
        for (var name in votes) {
            if (votes.hasOwnProperty(name) && votes[name] > winnerCount) {
                winner = name;
                winnerCount = votes[name];
            }
        }
        return winner;
    },

    // Order is the mechanism follow-the-sun grouping actually relies on now (see
    // _buildFollowTheSunEscalationPolicy), but that's only correct if every region
    // really does use the same order value for the same logical tier. This is a
    // sanity check on that assumption, not a correction to it: if two regions land
    // in the same order-grouped level but canonicalize to different role names, log
    // it loudly -- that's either a real data problem (an order value on one region's
    // roster needs fixing in cmn_rota_roster) or, less likely, an intentional
    // structure this grouping doesn't handle well. Cosmetic typos already covered by
    // ROLE_CANONICALIZATION don't trigger this (they canonicalize to the same name),
    // only a genuine mismatch does -- this exact scenario was found on a real
    // instance (Global NoSQL ADMIN's EMEA region has order=200 -> "Regional DBA
    // Manager" while every other region uses order=200 -> "Secondary").
    _warnIfOrderLevelsDisagreeOnName: function(groupName, levels) {
        for (var order in levels) {
            if (!levels.hasOwnProperty(order)) continue;
            var entries = levels[order];
            var namesSeen = {};
            for (var i = 0; i < entries.length; i++) {
                namesSeen[this._canonicalizeRole(entries[i].rosterRow.name)] = true;
            }
            var distinctNames = [];
            for (var n in namesSeen) { if (namesSeen.hasOwnProperty(n)) distinctNames.push(n); }
            if (distinctNames.length > 1) {
                gs.warn('"' + groupName + '" order=' + order + ' groups regions with different role names [' +
                    distinctNames.join(', ') + '] into the same escalation rule/schedule because they share ' +
                    'this order value. If that\'s not intended, fix the order value on the mismatched roster ' +
                    'row(s) in cmn_rota_roster.');
            }
        }
    },

    _warnIfWindowsDontTile: function(groupName, rotas, coverageWindows) {
        var everyDaySeconds = 0;
        var partialWeekRotas = [];
        for (var i = 0; i < rotas.length; i++) {
            var window = coverageWindows[rotas[i].sys_id];
            if (!window) continue;
            if (this._daysAreEveryDay(window.days)) {
                everyDaySeconds += window.durationSeconds;
            } else {
                partialWeekRotas.push(rotas[i].name);
            }
        }
        if (partialWeekRotas.length > 0) {
            gs.info('NOTE: ' + groupName + ' has rota(s) with a partial-week coverage window [' +
                partialWeekRotas.join(', ') + ']; excluded from the tiling check below.');
        }
        var totalHours = everyDaySeconds / 3600;
        if (Math.abs(totalHours - 24) <= 0.05) return;
        var detail = totalHours > 24 ? 'some regions likely overlap' : 'there is likely a gap';
        gs.info('NOTE: ' + groupName + '\'s every-day rotas\' coverage windows sum to ' + totalHours.toFixed(1) +
            'h, not a clean 24h -- ' + detail + '. Included as-is; worth confirming with whoever owns this rotation.');
    },

    // needs_review: one best-effort combined EP for a group that doesn't fit either
    // clean shape. See build_best_effort_escalation_policy() in the Python reference
    // for the full reasoning (order-value grouping, alternating-sibling detection).
    _buildBestEffortEscalationPolicy: function(groupName, snow, coverageWindows, asOf, dryRun, collected) {
        var emailToId = this._emailToIdCache || (this._emailToIdCache = this._pdGetAllUsers());
        gs.info('NOTE: "' + groupName + '" classified needs_review -- this escalation policy is a best-effort approximation.');

        var rosterRows = snow.rostersForGroup();
        if (rosterRows.length === 0) {
            gs.warn('no roster rows found for ' + groupName + '; nothing to build');
            return null;
        }

        var byOrder = {};
        var orderKeys = [];
        for (var i = 0; i < rosterRows.length; i++) {
            var orderNum = this._parseOrder(rosterRows[i].order);
            if (!byOrder.hasOwnProperty(orderNum)) { byOrder[orderNum] = []; orderKeys.push(orderNum); }
            byOrder[orderNum].push(rosterRows[i]);
        }
        orderKeys.sort(function(a, b) { return a - b; });

        var rules = [];
        for (var k = 0; k < orderKeys.length; k++) {
            var orderValue = orderKeys[k];
            var rowsAtLevel = byOrder[orderValue];

            var allSingleIncumbent = true;
            for (var r = 0; r < rowsAtLevel.length; r++) {
                var memberRowsAtLevel = snow.membersByRosterSysId[rowsAtLevel[r].sys_id] || [];
                if (!this._isSingleIncumbent(memberRowsAtLevel)) allSingleIncumbent = false;
            }

            this._warnAboutPossibleAlternatingSiblings(groupName, orderValue, rowsAtLevel, coverageWindows);

            var delayMinutes = 1;
            for (var d = 0; d < rowsAtLevel.length; d++) {
                delayMinutes = Math.max(delayMinutes, Math.round(parseInt(rowsAtLevel[d].time_before_escalation, 10) / 60));
            }

            var target;
            if (allSingleIncumbent) {
                var userId = this.FALLBACK_USER_ID;
                for (var s = 0; s < rowsAtLevel.length; s++) {
                    var memberRows = snow.membersByRosterSysId[rowsAtLevel[s].sys_id] || [];
                    var candidate = this._pickDirectUser(memberRows, asOf, emailToId);
                    if (candidate !== this.FALLBACK_USER_ID) { userId = candidate; break; }
                }
                target = {id: userId, type: 'user_reference'};
            } else {
                var layers = [];
                for (var l = 0; l < rowsAtLevel.length; l++) {
                    var row = rowsAtLevel[l];
                    var rotaRow = snow.rotaBySysId[row.rota_sys_id];
                    var memberRows2 = snow.membersByRosterSysId[row.sys_id] || [];
                    var layer = this._buildScheduleLayer(row, rotaRow, memberRows2, asOf, emailToId);
                    var window = coverageWindows[rotaRow.sys_id];
                    if (window) layer.restrictions = this._buildRestrictions(window);
                    layers.push(layer);
                }
                var firstRota = snow.rotaBySysId[rowsAtLevel[0].rota_sys_id];
                var schedulePayload = {
                    schedule: {
                        type: 'schedule',
                        name: this._syncedName(groupName + ' - level ' + orderValue),
                        description: this.SYNCED_DESCRIPTION,
                        time_zone: this._canonicalizeTimeZone(firstRota.schedule_time_zone),
                        schedule_layers: layers
                    }
                };
                var scheduleId = this._upsertSchedule(schedulePayload, dryRun, collected);
                target = {id: scheduleId, type: 'schedule_reference'};
            }
            rules.push({escalation_delay_in_minutes: delayMinutes, targets: [target]});
        }

        var catchAll = this._buildCatchAllRule(snow.rotasForGroup(), emailToId);
        if (catchAll) rules.push(catchAll);

        var epPayload = {
            escalation_policy: {
                type: 'escalation_policy',
                name: this._syncedName(groupName + ' (NEEDS REVIEW)'),
                description: this.SYNCED_DESCRIPTION,
                num_loops: this.NUM_LOOPS,
                escalation_rules: rules
            }
        };
        this._upsertEscalationPolicy(epPayload, dryRun, collected);
    },

    _warnAboutPossibleAlternatingSiblings: function(groupName, orderValue, rowsAtLevel, coverageWindows) {
        var byWindowKey = {};
        var self = this;
        var keyFor = function(w) { return w.days.join(',') + '|' + w.startTimeOfDay + '|' + w.durationSeconds; };
        for (var i = 0; i < rowsAtLevel.length; i++) {
            var window = coverageWindows[rowsAtLevel[i].rota_sys_id];
            if (!window) continue;
            var key = keyFor(window);
            byWindowKey[key] = byWindowKey[key] || [];
            byWindowKey[key].push(rowsAtLevel[i]);
        }
        for (var k in byWindowKey) {
            if (!byWindowKey.hasOwnProperty(k)) continue;
            var rows = byWindowKey[k];
            if (rows.length < 2) continue;
            var names = [];
            for (var n = 0; n < rows.length; n++) names.push(rows[n].name);
            gs.info('NOTE: ' + groupName + ' order=' + orderValue + ': [' + names.join(', ') + '] share an identical ' +
                'coverage window -- could be alternating-week crews for the same slot, or independently-configured ' +
                'rotas that happen to use the same hours. Built here as separate, overlapping restricted layers.');
        }
    },

    type: 'PagerDutySync'
};
