var PagerDutySync = Class.create();
PagerDutySync.prototype = {
    initialize: function() {
        // Which groups this port manages is data now, not code -- see isEnrolled()
        // and _enrolledGroupNames() below, which read the u_pagerduty_sync_group
        // table (Global scope, one row per enrolled sys_user_group). Presence = this
        // group's on-call comes from ServiceNow and gets overwritten in PagerDuty on
        // every sync; absence = untouched. See README.md for how to create the table.
        this.SYNC_GROUP_TABLE = 'u_pagerduty_sync_group';

        // Every schedule/escalation policy this port creates or updates gets this
        // prefix, so anyone scanning PagerDuty's UI can immediately tell which
        // objects are ServiceNow-managed (and, since PD sorts lists alphabetically,
        // they cluster together instead of being scattered through the full list).
        this.SYNCED_NAME_PREFIX = '[ServiceNow Sync v3] ';
        this.SYNCED_DESCRIPTION = 'Managed by ServiceNow on-call sync (PagerDutySync, v3 shift-based ' +
            'schedules exploration). Changes made directly in PagerDuty will be overwritten on the next sync.';

        // Reuses the app's own "Default PagerDuty User ID to use if auto-provisioning
        // is disabled" property instead of a separate one-off property for this port
        // -- same fallback-user concept the app already uses elsewhere (see
        // PagerDuty.defaultUserID and PagerDutyProvisioning's group provisioning),
        // already configured on this instance, no second ID to keep in sync.
        this.FALLBACK_USER_ID = gs.getProperty('x_pd_integration.default_user');
        if (!this.FALLBACK_USER_ID) {
            gs.warn('PagerDutySync: x_pd_integration.default_user is not set; events with no active or ' +
                'resolvable member will be built with a blank user id, which PagerDuty will reject');
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

        // Standard-time (non-DST) UTC offsets, in seconds, for the canonical zones
        // above -- see _localizedIso for why this exists and its DST limitation.
        this.STANDARD_UTC_OFFSET_SECONDS = {
            'America/New_York': -5 * 3600,
            'America/Chicago': -6 * 3600,
            'America/Denver': -7 * 3600,
            'America/Los_Angeles': -8 * 3600,
            'America/Phoenix': -7 * 3600,   // no DST
            'America/Anchorage': -9 * 3600,
            'Pacific/Honolulu': -10 * 3600, // no DST
            'America/Mexico_City': -6 * 3600,
            'America/Toronto': -5 * 3600,
            'Asia/Singapore': 8 * 3600,     // no DST
            'UTC': 0
        };

        this.NUM_LOOPS = 2;
        this.CATCH_ALL_DELAY_MINUTES = 30;
        // cmn_rota.catch_all is a choice field -- like repeat_type and
        // rotation_interval_type before it, its real internal values don't match
        // the capitalized display labels ('Notify Group Manager' etc.) this was
        // originally written against. Confirmed live via sys_choice: the actual
        // values are 'group_manager', 'all', 'individual'. Only 'group_manager'
        // is handled -- with the wrong string, this matched NOTHING in real data,
        // meaning the catch-all feature silently built no rule for any of the 16
        // rotas (across several groups, not just Wintel) actually configured with
        // it.
        //
        // 'individual' now handled too -- confirmed via cmn_rota's own "Catch-All
        // is Individual" UI Policy (condition catch_all=individual, action makes
        // catch_all_member visible AND mandatory) that it's a direct reference to
        // one named sys_user, not a roster or group lookup. Resolved through the
        // same email->PD-user path as every other user reference in this file.
        //
        // 'all' ("Notify All") is still unhandled -- a rota using it still logs a
        // warning instead of silently doing nothing. Its own UI Policy proves the
        // earlier guess in this comment ("presumably every member of the
        // assignment group") was wrong: it makes catch_all_roster visible and
        // mandatory, i.e. "all" means every member of one specific, explicitly
        // chosen roster, not the group's whole membership. Building it needs that
        // roster's members resolved and turned into an every_member_assignment_
        // strategy-style "page together" target (see Architecture notes in the
        // README), not a simple group-wide broadcast -- bigger than the one-field
        // lookup 'individual' needed, scoped separately.
        this.HANDLED_CATCH_ALL_TYPES = {'group_manager': true, 'individual': true};
        this.ROTATION_ORDER_SENTINEL_THRESHOLD = 1000;
        // A sanity ceiling on a single cmn_schedule_span's computed duration, meant
        // to catch a genuine data problem (e.g. start/end misordered across days,
        // producing a nonsensical multi-day "duration"). Was 20 -- too strict:
        // confirmed live on real data that a legitimate all-day rotation
        // (days_of_week=1234567, 00:00:00-23:59:59, ServiceNow's own way of
        // representing "all day") computes to 86399 seconds = 23.9997h, which is
        // >= 20 and was being silently filtered out, leaving zero usable windows
        // and _computeCoverageWindow returning null for an entirely valid rota.
        // 24 lets a real all-day span through while still rejecting anything
        // that's actually too long to be a single day's window.
        //
        // Raised to 72 -- 24 was too strict in the other direction: confirmed live
        // that Hardware (Weekend)'s span is a legitimate ~48.5h block (Fri
        // afternoon through Sun afternoon Pacific, repeat_type='weekly',
        // days_of_week naming a single weekday), not bad data. At 24h that got
        // filtered out the same way the 20h ceiling used to filter out real
        // all-day spans -- includeWindows ended up empty, _computeCoverageWindow
        // returned null, and the caller substituted _defaultAlwaysOnWindow's 24/7-
        // every-day default, turning a weekly ~2-day weekend block into a daily
        // rotation through every member. 72h covers a Fri-Sun style block with
        // headroom; a span longer than that is still almost certainly misordered
        // start/end data rather than an intentional shift.
        this.MAX_RESTRICTED_WINDOW_HOURS = 72;

        // Monday=1 .. Sunday=7, matching _decodeDaysOfWeek's convention -- confirmed
        // against real data (Wintel's "Su-We-Th-Fr" rota has days_of_week digits
        // that decode to {3,4,5,7} under this mapping, i.e. Wed/Thu/Fri/Sun).
        this.RRULE_DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

        // Arbitrary, fixed, stable reference instant used only when a roster has
        // neither a real rotation_start_date/rotation_start_time NOR a coverage
        // window to anchor its rotation phase to (see _rotationPhaseAnchorIso) --
        // confirmed this happens on real data (a "Daily Rotation" roster with both
        // fields blank produced an invalid "0002-11-30" effective_since before this
        // existed). Deliberately not "now" (asOf) -- using the sync time as the
        // phase anchor would reset which member looks "current" on every re-sync.
        this.FIXED_FALLBACK_ANCHOR_ISO = '2020-01-06T00:00:00Z'; // arbitrary Monday

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
        var expiredRotaIds = {};
        var coverageWindows = this._loadCoverageWindows(snow, asOf, expiredRotaIds);
        this._dropExpiredRotas(snow, expiredRotaIds);
        if (snow.rotasForGroup().length === 0) {
            gs.warn('PagerDutySync: "' + groupName + '" has no rota left with current coverage (every rota ' +
                'either was never loaded or has expired); leaving its PagerDuty objects untouched this run');
            return;
        }
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
        // Confirmed live: a rota removed from a group's real on-call config (e.g.
        // Global SQLDBA ADMIN's LATAM/NA regions, replaced by a combined "Americas")
        // was deactivated in ServiceNow rather than hard-deleted -- without this
        // filter it was still loaded here, still treated as "desired," and its
        // PagerDuty rotation/event kept getting recreated forever even though the
        // group's real current data no longer includes it.
        rotaGr.addActiveQuery();
        rotaGr.query();
        while (rotaGr.next()) {
            rotaBySysId[rotaGr.getUniqueValue()] = {
                sys_id: rotaGr.getUniqueValue(),
                name: rotaGr.getValue('name'),
                group: groupName,
                schedule_sys_id: rotaGr.schedule.toString(),
                schedule_time_zone: rotaGr.schedule.time_zone ? rotaGr.schedule.time_zone.toString() : '',
                catch_all: rotaGr.getValue('catch_all') || '',
                catch_all_wait_time: rotaGr.getValue('catch_all_wait_time') || '',
                catch_all_member_email: rotaGr.catch_all_member.email ? rotaGr.catch_all_member.email.toString() : '',
                use_custom_escalation: rotaGr.getValue('use_custom_escalation') === 'true',
                group_manager_email: rotaGr.group.manager.email ? rotaGr.group.manager.email.toString() : ''
            };
        }

        var rosterBySysId = {};
        var rosterByRotaSysId = {};
        var rosterGr = new GlideRecord('cmn_rota_roster');
        rosterGr.addQuery('rota.group.name', groupName);
        rosterGr.addActiveQuery(); // same reasoning as cmn_rota above; no-ops harmlessly if this table has no active field
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

    // cmn_rota_roster.rotation_interval_type is a choice field -- like
    // cmn_schedule_span.repeat_type (see _computeCoverageWindow's NOTE), its real
    // internal values are lowercase ('weekly', 'daily'), not the capitalized
    // 'Weekly' this code originally assumed. Confirmed live: a real roster's
    // rotation_interval_type came back as "daily" and hit the "unhandled ...
    // treating as weekly anyway" fallback -- meaning a roster meant to hand off
    // daily among its members was instead treated as a weekly handoff (7x too
    // slow), AND any 'weekly' roster was silently mismatching the same
    // capitalized-only check and hitting that warning path too (just with the
    // right behavior by coincidence, since the fallback IS "weekly"). Every
    // comparison against this field goes through this helper now.
    _normalizeIntervalType: function(raw) {
        return (raw || '').replace(/^\s+|\s+$/g, '').toLowerCase();
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
    //
    // Unchanged from the v2 file -- this whole section is ServiceNow-side parsing,
    // independent of which PagerDuty schedule API consumes the result. window.
    // anchorUtcIso (the earliest include span's real start instant, already UTC) is
    // what this v3 file uses directly as an event's start_time/effective_since --
    // see _buildEvent/_buildAlternatingEvent below.
    // ------------------------------------------------------------------------------

    // Returns {rota_sys_id: {days: [1-7,...], startTimeOfDay: 'HH:MM:SS', durationSeconds: N}}
    _loadCoverageWindows: function(snow, asOf, expiredRotaIds) {
        var ownWindow = {};
        var rotas = snow.rotasForGroup();
        for (var i = 0; i < rotas.length; i++) {
            var rota = rotas[i];
            if (!rota.schedule_sys_id) continue;
            var state = {expiredSpans: 0};
            var window = this._computeCoverageWindow(rota.schedule_sys_id, rota.name, asOf, state);
            if (window) {
                ownWindow[rota.sys_id] = window;
            } else if (state.expiredSpans > 0 && expiredRotaIds) {
                expiredRotaIds[rota.sys_id] = true;
            }
        }
        return ownWindow;
    },

    // A rota whose ONLY usable recurring spans all have a repeat_until in the past
    // has ended -- that's how ServiceNow admins retire a rotation without
    // deactivating the rota/roster (both stay active=true). It's removed from this
    // sync entirely, rather than left to fall through to _defaultAlwaysOnWindow's
    // 24/7-every-day default like a rota that simply has no window configured.
    // The always-on fallback was the original behavior of the repeat_until fix and
    // was confirmed live to be wrong for this case, twice over: the ended
    // regions kept paging around the clock, AND having no window flipped the whole
    // group to needs_review (_classifyGroup), which renamed its escalation policy
    // and schedules and forked a duplicate set in PagerDuty. Dropping the rota
    // here (before classification) avoids both; any PagerDuty rotation it left
    // behind on a schedule found by name is removed by _upsertScheduleV3's
    // "no longer produced by this sync" cleanup.
    _dropExpiredRotas: function(snow, expiredRotaIds) {
        for (var rotaId in expiredRotaIds) {
            if (!expiredRotaIds.hasOwnProperty(rotaId) || !snow.rotaBySysId.hasOwnProperty(rotaId)) continue;
            gs.info('skipping rota "' + snow.rotaBySysId[rotaId].name + '": every recurring span on its schedule has a ' +
                'repeat_until in the past, so it has no current coverage (not falling back to an always-on window)');
            var rosters = snow.rosterByRotaSysId[rotaId] || [];
            for (var i = 0; i < rosters.length; i++) {
                delete snow.membersByRosterSysId[rosters[i].sys_id];
                delete snow.rosterBySysId[rosters[i].sys_id];
            }
            delete snow.rosterByRotaSysId[rotaId];
            delete snow.rotaBySysId[rotaId];
        }
    },

    // Reads and merges every recurring cmn_schedule_span row for one schedule into a
    // single {days, startTimeOfDay, durationSeconds} window, or returns null if
    // there's nothing usable. Only Weekly/Daily repeat_type rows are considered.
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
    _computeCoverageWindow: function(scheduleSysId, rotaLabel, asOf, state) {
        var spanGr = new GlideRecord('cmn_schedule_span');
        spanGr.addQuery('schedule', scheduleSysId);
        // 'weekdays' is a distinct real repeat_type value from 'daily' (confirmed
        // live: Hardware (US)'s span is repeat_type='weekdays' with days_of_week=
        // '1234567', not 'daily') -- it still carries its real day set in
        // days_of_week same as 'weekly' does, so omitting it here doesn't just
        // mis-decode the days, it drops the row from this query entirely. That
        // silently emptied includeWindows for the whole rota, which
        // _loadCoverageWindows' callers then treated as "no coverage window" and
        // replaced with _defaultAlwaysOnWindow's 24/7-every-day default -- turning
        // an 8.5h/day window into round-the-clock coverage.
        //
        // 'weekends'/'weekMWF'/'weekTT' are the same shape as 'weekdays' -- real,
        // independently selectable cmn_schedule_span.repeat_type choice-list values
        // ("Every Weekend (Sat, Sun)" / "Every Mon, Wed, Fri" / "Every Tue, Thu"),
        // still carrying their real day set in days_of_week, so they hit the exact
        // same silent-drop failure 'weekdays' did until it's included here too. Not
        // observed on any real on-call rota's schedule in this instance yet (only
        // 'daily'/'weekly'/'weekdays' are, as of this writing) -- added proactively
        // since 'weekends' in particular is the literal preset ServiceNow's own UI
        // offers for a rota named like Hardware's "Weekend" one, and hitting it once
        // already (silently) is enough reason not to wait for a second occurrence.
        // 'monthly'/'yearly'/'specific' are NOT included -- those aren't a day-of-
        // week shape at all (month/day-of-month or explicit dates), so days_of_week
        // decoding and the weekly-BYDAY RRULE builder below have no representation
        // for them; adding them to this query alone would just let them fall through
        // to _mergeSpanWindows/_rruleForWindow and misbehave differently, not fix
        // anything. See README's "Coverage window repeat types" section.
        spanGr.addQuery('repeat_type', 'IN', 'weekly,daily,weekdays,weekends,weekMWF,weekTT');
        spanGr.query();

        var includeWindows = [];
        var excludeWindows = [];
        var repeatCountsSeen = {};
        var earliestAnchor = null;
        while (spanGr.next()) {
            // repeat_until is a real cmn_schedule_span field (compact YYYYMMDD,
            // '00000000' sentinel for "no end date" -- same convention
            // _isBlankRosterValue/_normalizeRosterDate already handle for
            // rotation_start_date) that was never read here at all before this --
            // confirmed live: a rotation ended by setting repeat_until in the past
            // (rather than deactivating the rota/roster, which stays active=true)
            // kept being read as an ongoing, currently-valid recurring pattern
            // forever. Same day-boundary convention as _activeMemberRows' `to`
            // check below (expires at the START of that day, not through the end
            // of it) for consistency within this file.
            var repeatUntilRaw = spanGr.getValue('repeat_until');
            if (!this._isBlankRosterValue(repeatUntilRaw)) {
                var repeatUntilGdt = new GlideDateTime(this._normalizeRosterDate(repeatUntilRaw) + ' 00:00:00');
                if (repeatUntilGdt.compareTo(asOf) < 0) {
                    gs.info('"' + rotaLabel + '": span ' + spanGr.getUniqueValue() + '\'s repeat_until (' +
                        this._normalizeRosterDate(repeatUntilRaw) + ') is in the past; excluding it from this ' +
                        'rota\'s coverage window computation');
                    if (state) state.expiredSpans++;
                    continue;
                }
            }

            var startNormalized = this._parseScheduleDateTime(spanGr.getValue('start_date_time'));
            var endNormalized = this._parseScheduleDateTime(spanGr.getValue('end_date_time'));
            if (!startNormalized || !endNormalized) continue;

            var durationSeconds = this._dateDiffSeconds(startNormalized, endNormalized);
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
            var repeatCount = parseInt(spanGr.getValue('repeat_count'), 10);
            if (isNaN(repeatCount) || repeatCount < 1) repeatCount = 1;
            repeatCountsSeen[repeatCount] = true;

            if ((spanGr.getValue('type') || '').toLowerCase() === 'exclude') {
                excludeWindows.push(window);
            } else {
                includeWindows.push(window);
                if (earliestAnchor === null || startNormalized < earliestAnchor) earliestAnchor = startNormalized;
            }
        }

        if (includeWindows.length === 0) return null;

        var repeatCountValues = [];
        for (var rc in repeatCountsSeen) { if (repeatCountsSeen.hasOwnProperty(rc)) repeatCountValues.push(parseInt(rc, 10)); }
        if (repeatCountValues.length > 1) {
            gs.warn('"' + rotaLabel + '" has cmn_schedule_span rows with different repeat_count values (' +
                repeatCountValues.join(', ') + '); using the largest for alternating-cycle detection');
        }
        var repeatCount = repeatCountValues.length ? Math.max.apply(null, repeatCountValues) : 1;

        var result;
        if (includeWindows.length === 1 && excludeWindows.length === 0) {
            result = includeWindows[0]; // common case -- same result as the old single-row logic
        } else {
            result = this._mergeSpanWindows(rotaLabel, includeWindows, excludeWindows);
        }
        if (!result) return null;

        // repeat_count > 1 ("Repeat every N weeks") means this rota is only active
        // every Nth week, not every week -- cyclePhase/anchorUtcIso let
        // _detectAlternatingGroups() recognize two rotas with an identical shape
        // (e.g. Wintel's "1a"/"1b") as alternating partners on disjoint weeks of
        // the same cycle, rather than a same-week conflict. Confirmed via
        // fix_script_q6_q7.txt Q7 (in ../servicenow/) -- see _detectAlternatingGroups.
        result.repeatCount = repeatCount;
        result.cyclePhase = (repeatCount > 1 && earliestAnchor) ? this._weekPhase(earliestAnchor) : null;
        result.anchorUtcIso = earliestAnchor ? (earliestAnchor.replace(' ', 'T') + 'Z') : null;
        return result;
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

    // gs.dateDiff() is disallowed under function fencing in a scoped app -- confirmed
    // live: "Function dateDiff is not allowed in scope x_pd_integration. Use
    // GlideDateTime.subtract() instead." The suggested GlideDateTime.subtract(
    // otherGdt) replacement turned out NOT to take a second GlideDateTime the way
    // gs.dateDiff() does -- confirmed live, it threw "Cannot convert <date string> to
    // java.lang.Long," meaning that overload expects something duration/Long-shaped,
    // not another GlideDateTime, and Rhino tried (and failed) to coerce one into that.
    // This instead uses GlideDateTime.getNumericValue() (epoch milliseconds as a
    // plain JS number, no interop overload ambiguity) on each side and subtracts
    // directly -- date2 minus date1, in seconds, matching gs.dateDiff(date1Str,
    // date2Str, true)'s exact semantics everywhere it was used in this file.
    _dateDiffSeconds: function(date1Str, date2Str) {
        var gdt1 = new GlideDateTime(date1Str);
        var gdt2 = new GlideDateTime(date2Str);
        return (gdt2.getNumericValue() - gdt1.getNumericValue()) / 1000;
    },

    // Integer week index of a normalized 'yyyy-MM-dd HH:mm:ss' instant relative to
    // an arbitrary fixed reference. Only meaningful as a DIFFERENCE between two
    // calls (mod a shared repeat_count) -- used to tell whether two rotas' anchors
    // fall on the same or a different week of an N-week repeat cycle.
    _weekPhase: function(normalizedDateTime) {
        var REFERENCE = '2001-01-01 00:00:00';
        var seconds = this._dateDiffSeconds(REFERENCE, normalizedDateTime);
        return Math.floor(seconds / (7 * 24 * 3600));
    },

    // Merges multiple coverage-contributing spans and subtracts any Excluded spans,
    // per day of week, using real interval union/subtraction. Only returns a result
    // if it collapses to ONE time-of-day window shared by every covered day -- that's
    // the only shape this file's RRULE-per-day-shape approach can represent (same
    // constraint the v2 file's restrictions had). A genuinely more complex shape
    // (different hours on different days, or a gap left by an exclusion) isn't
    // something to guess through -- it logs why and returns null, same "no usable
    // window" fallback as before, just with a clearer reason attached.
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
                    'merging cmn_schedule_span rows; this shape can\'t be represented as a single RRULE-based ' +
                    'event -- skipping, treat as needs review');
                return null;
            }
            var start = merged[0][0], duration = merged[0][1] - merged[0][0];
            if (commonStart === null) {
                commonStart = start;
                commonDuration = duration;
            } else if (start !== commonStart || duration !== commonDuration) {
                gs.warn('"' + rotaLabel + '" has a different time-of-day coverage window on different days ' +
                    'after merging cmn_schedule_span rows; this shape can\'t be represented as a single ' +
                    'RRULE-based event -- skipping, treat as needs review');
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

    // v2 could represent "no restriction" by simply omitting .restrictions from a
    // layer (always active). v3 has no such concept -- every event needs a real
    // start_time anchor -- so this fallback anchors to today's midnight IN THE
    // SCHEDULE'S OWN ZONE (via the same GlideScheduleDateTime mechanism
    // _localizedIso uses) and covers every day, all day (RRULE:FREQ=DAILY, no
    // BYDAY needed).
    //
    // An earlier version of this anchored to midnight UTC instead, regardless of
    // tzName -- confirmed live on a real sync: a schedule in America/New_York
    // (EDT, UTC-4) got its daily handoffs at 8:00 PM local, since 00:00 UTC is
    // 20:00 EDT the PREVIOUS day. The window's specific anchor time doesn't affect
    // 24/7 coverage itself (it's always-on regardless), but it does set where the
    // daily occurrence boundary -- and so the handoff moment -- falls.
    // Always-on (00:00-23:59 every day) window used when there's no
    // cmn_schedule_span coverage window to compute from -- single_region groups
    // (nothing to restrict WHEN coverage applies) and the needs_review/best-effort
    // fallback paths. window.anchorUtcIso feeds two different things downstream:
    // the event's start_time/end_time (cosmetic for a FREQ=DAILY rule, since every
    // day matches regardless of which specific date is used as the reference
    // occurrence) and, via _rotationPhaseAnchorIso's fallback, effective_since when
    // the roster's own rotation_start_date/rotation_start_time are blank (confirmed
    // happens on real data). That second use is NOT cosmetic -- it's what
    // determines which day of the week the shifts_per_member handoff boundary
    // falls on.
    //
    // Originally anchored to "now" (today's midnight) -- confirmed live this was
    // wrong: a live sync run on a Tuesday produced Tuesday handoffs in PagerDuty
    // for CHB MAINFRAME SUPPORT's Primary/Secondary rotation, while that group's
    // own real ServiceNow on-call calendar showed a steady weekly Friday handoff.
    // Since "now" is whatever day the sync happens to run, every re-sync would
    // silently move the handoff day again. Prefers the earliest
    // cmn_rota_member.from date across this roster's members instead -- real data
    // about when the rotation's members actually started, stable across re-syncs
    // -- falling back to FIXED_FALLBACK_ANCHOR_ISO (never "now") only if no member
    // has a usable from date either.
    _defaultAlwaysOnWindow: function(tzName, memberRows) {
        var anchorUtcIso = this._earliestMemberFromAnchorIso(memberRows || [], tzName);
        if (!anchorUtcIso) {
            gs.warn('PagerDutySync: no cmn_rota_member.from date available to anchor an always-on rotation\'s ' +
                'handoff day; using a fixed fallback anchor instead of "now" so it at least stays stable across ' +
                'syncs -- which day of the week handoffs land on is not derived from real ServiceNow data here');
            anchorUtcIso = this.FIXED_FALLBACK_ANCHOR_ISO;
        }
        return {
            days: [1, 2, 3, 4, 5, 6, 7],
            startTimeOfDay: '00:00:00',
            durationSeconds: 86400,
            repeatCount: 1,
            cyclePhase: null,
            anchorUtcIso: anchorUtcIso
        };
    },

    // Earliest cmn_rota_member.from across all of a roster's members (active or
    // not -- even a not-yet-started or already-ended member's from is real
    // ServiceNow data about the rotation's real cadence, a better signal than
    // "now"), localized the same way rotation_start_date/rotation_start_time are.
    // Returns null if no member row has a usable from value at all.
    _earliestMemberFromAnchorIso: function(memberRows, tzName) {
        var earliest = null;
        for (var i = 0; i < memberRows.length; i++) {
            var from = memberRows[i].from;
            if (!from) continue;
            if (earliest === null || from < earliest) earliest = from;
        }
        return earliest ? this._localizedIso(earliest, '00:00:00', tzName) : null;
    },

    // ------------------------------------------------------------------------------
    // RRULE / SHIFT-TIMING HELPERS (v3-specific)
    // ------------------------------------------------------------------------------

    // FREQ=DAILY for a 24/7 window (no BYDAY needed -- every day matches); otherwise
    // FREQ=WEEKLY with an explicit BYDAY list built from window.days via
    // RRULE_DAY_CODES. INTERVAL is deliberately not used here even for alternating
    // groups -- see _buildAlternatingEvent, which expresses the alternation through
    // assignment_strategy/shifts_per_member instead, since that's demonstrated in
    // the OpenAPI spec's own examples and doesn't depend on how PagerDuty's RRULE
    // parser handles INTERVAL (untested).
    _rruleForWindow: function(window) {
        if (this._daysAreEveryDay(window.days)) {
            return 'RRULE:FREQ=DAILY';
        }
        var codes = [];
        for (var i = 0; i < window.days.length; i++) {
            codes.push(this.RRULE_DAY_CODES[window.days[i] - 1]);
        }
        return 'RRULE:FREQ=WEEKLY;BYDAY=' + codes.join(',');
    },

    // How many consecutive RRULE-generated occurrences one member covers before the
    // assignment strategy hands off to the next -- confirmed from the OpenAPI spec:
    // "Number of consecutive shift occurrences each member covers before the next
    // member takes over," with an explicit note that for FREQ=WEEKLY this must be
    // evenly divisible by the BYDAY day count. One full intervalCount-week rotation
    // period = intervalCount * (occurrences generated per week) -- 7 for FREQ=DAILY,
    // window.days.length for FREQ=WEEKLY.
    // intervalType 'daily' (cmn_rota_roster.rotation_interval_type, see
    // _normalizeIntervalType): N days = N discrete occurrences, 1:1, regardless of
    // how many of those occurrences fall in a calendar week. Anything else (the
    // 'weekly' default, and _buildAlternatingEvent's fixed one-side-per-week
    // cadence): N weeks = N * however many occurrences one week's worth of this
    // shape produces.
    _shiftsPerMember: function(window, intervalType, intervalCount) {
        var count = Math.max(1, intervalCount || 1);
        if (intervalType === 'daily') return count;
        var occurrencesPerWeek = this._daysAreEveryDay(window.days) ? 7 : window.days.length;
        return count * occurrencesPerWeek;
    },

    _zonedDateTime: function(isoUtc, tzName) {
        return {date_time: isoUtc, time_zone: tzName};
    },

    // Adds `seconds` to a UTC ISO8601 instant ('yyyy-MM-ddTHH:mm:ssZ'), returning the
    // same format. GlideDateTime's plain constructor accepts the internal
    // 'yyyy-MM-dd HH:mm:ss' form directly as UTC (already relied on elsewhere in this
    // file, e.g. _computeCoverageWindow's `new GlideDateTime(startNormalized)`), so
    // this doesn't need the session-timezone dance _localizedIso uses below.
    _addSecondsToUtcIso: function(isoUtc, seconds) {
        var normalized = isoUtc.replace('T', ' ').replace(/Z$/, '');
        var gdt = new GlideDateTime(normalized);
        gdt.addSeconds(seconds);
        return gdt.getValue().replace(' ', 'T') + 'Z';
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
    // MEMBER RESOLUTION
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

    // ------------------------------------------------------------------------------
    // EVENT BUILDERS (v3) -- replace the v2 file's schedule-layer builders. A v3
    // "event" is the analog of a v2 "layer": one roster row's rotation, scoped to one
    // coverage window. Where the v2 file wrote {days, startTimeOfDay, duration} into
    // a `restrictions` array evaluated fresh every week, this file writes it into an
    // RFC 5545 `recurrence` rule anchored at the window's real first occurrence
    // (window.anchorUtcIso) -- see ASSUMPTION 1 in the file header for the one real
    // open question in this translation.
    // ------------------------------------------------------------------------------

    // One roster row -> one event, with its own members rotating among themselves
    // (rotating_member_assignment_strategy). Mirrors the v2 file's
    // _buildScheduleLayer, translated to the event/assignment_strategy shape.
    _buildEvent: function(rosterRow, rotaRow, memberRows, window, asOf, emailToId, tzName) {
        var intervalType = this._normalizeIntervalType(rosterRow.rotation_interval_type);
        var intervalCount = parseInt(rosterRow.rotation_interval_count, 10);
        if (isNaN(intervalCount) || intervalCount < 1) intervalCount = 1;
        if (intervalType !== 'daily' && intervalType !== 'weekly') {
            gs.warn('unrecognized rotation_interval_type "' + rosterRow.rotation_interval_type + '" on roster ' +
                rosterRow.sys_id + '; treating as weekly anyway');
            intervalType = 'weekly';
        }

        // rotation_start_date/rotation_start_time is sent as effective_since below,
        // but that field does NOT control which member PagerDuty shows as current
        // -- see the "ROTATION PHASE ALIGNMENT" section above _rotationMemberOffset
        // for why, and how the members array gets rotated instead to actually
        // apply it. _rotationPhaseAnchorIso's own fallback (blank
        // rotation_start_date/time) still governs effective_since here, same as
        // always -- _rotationMemberOffset separately falls back to "no rotation"
        // in that same case, so the two stay consistent with each other.
        var effectiveSince = this._rotationPhaseAnchorIso(rosterRow, tzName, window.anchorUtcIso);

        var active = this._activeMemberRows(memberRows, asOf);
        var members = [];
        var fallbackCount = 0;
        for (var i = 0; i < active.length; i++) {
            var resolved = this._resolveUser(active[i].member_email, emailToId);
            if (!resolved.matched) fallbackCount++;
            members.push({type: 'user_member', user_id: resolved.id});
        }
        if (members.length === 0) {
            gs.warn('roster ' + rosterRow.sys_id + ' (' + rosterRow.name + ') has no currently-active ' +
                'members (no member rows at all, or none currently active); using fallback user for the whole event');
            members = [{type: 'user_member', user_id: this.FALLBACK_USER_ID}];
            fallbackCount = 1;
        }
        if (fallbackCount) {
            gs.info('  note: ' + fallbackCount + '/' + members.length + ' slot(s) in "' + rosterRow.name +
                '" (' + rotaRow.name + ') filled with the fallback user');
        }

        var shiftsPerMember = this._shiftsPerMember(window, intervalType, intervalCount);
        var rotationOffset = this._rotationMemberOffset(rosterRow, window, tzName, shiftsPerMember, members.length);
        if (rotationOffset) {
            gs.info('  note: rotating "' + rosterRow.name + '" (' + rotaRow.name + ')\'s member order by ' +
                rotationOffset + '/' + members.length + ' to align with rotation_start_date (' +
                rosterRow.rotation_start_date + ') -- its coverage window\'s own anchor date disagrees with ' +
                'that by enough whole shift-blocks to otherwise put the wrong member first');
        }
        members = this._rotateForPhase(members, rotationOffset);

        return {
            name: rotaRow.name + ' - ' + rosterRow.name,
            start_time: this._zonedDateTime(window.anchorUtcIso, tzName),
            end_time: this._zonedDateTime(this._addSecondsToUtcIso(window.anchorUtcIso, window.durationSeconds), tzName),
            effective_since: effectiveSince,
            recurrence: [this._rruleForWindow(window)],
            assignment_strategy: {
                type: 'rotating_member_assignment_strategy',
                shifts_per_member: shiftsPerMember,
                members: members
            }
        };
    },

    // Builds ONE rotating v3 event from a detected alternating group of roster rows
    // (see _detectAlternatingGroups) whose rotas share an identical coverage shape
    // but sit on disjoint weeks of a shared repeat_count cycle -- e.g. Wintel's "On
    // shift 1a"/"On shift 1b", confirmed via fix_script_q6_q7.txt Q7 (repeat_count=2
    // on both, anchors one week apart, in ../servicenow/).
    //
    // This is the payoff for the v3 rewrite: the v2 file needed a hand-rolled
    // interleaved-users/rotation_turn_length_seconds hack (_buildAlternatingLayer,
    // _interleaveAlternatingUsers) to fake "week on/week off" on top of a schedule
    // model with no such native concept. Here it's just
    // rotating_member_assignment_strategy with shifts_per_member set to one full
    // week's worth of occurrences (see _shiftsPerMember) and each side's members
    // interleaved into the rotation order -- the SAME interleaving algorithm as the
    // v2 file (_interleaveAlternatingUsers, kept, operating on plain user id strings
    // now rather than pre-wrapped {user:{id,type}} objects), just fed into a
    // members list PagerDuty rotates through natively instead of a synthetic
    // multi-week rotation_turn_length_seconds.
    //
    // orderedRows must already be in phase order (index 0 = whichever side's own
    // span anchors first) -- _detectAlternatingGroups guarantees this.
    _buildAlternatingEvent: function(orderedRows, sharedWindow, snow, asOf, emailToId, tzName) {
        var sideUserIdLists = [];
        var names = [];
        for (var i = 0; i < orderedRows.length; i++) {
            var row = orderedRows[i];
            var memberRows = snow.membersByRosterSysId[row.sys_id] || [];
            var active = this._activeMemberRows(memberRows, asOf);
            var sideIds = [];
            for (var a = 0; a < active.length; a++) {
                sideIds.push(this._resolveUser(active[a].member_email, emailToId).id);
            }
            if (sideIds.length === 0) sideIds = [this.FALLBACK_USER_ID];
            sideUserIdLists.push(sideIds);
            names.push(row.name);
        }

        var interleavedIds = this._interleaveAlternatingUsers(sideUserIdLists);
        var members = [];
        for (var m = 0; m < interleavedIds.length; m++) {
            members.push({type: 'user_member', user_id: interleavedIds[m]});
        }

        return {
            name: names.join(' / alternating with / '),
            start_time: this._zonedDateTime(sharedWindow.anchorUtcIso, tzName),
            end_time: this._zonedDateTime(this._addSecondsToUtcIso(sharedWindow.anchorUtcIso, sharedWindow.durationSeconds), tzName),
            // Alternation phase comes from the coverage window's own anchor, not any
            // one side's rotation_start_date -- there's no single "right" side to
            // pick that from, and the window anchor is what _detectAlternatingGroups
            // already validated as the real signal.
            effective_since: sharedWindow.anchorUtcIso,
            recurrence: [this._rruleForWindow(sharedWindow)],
            assignment_strategy: {
                type: 'rotating_member_assignment_strategy',
                shifts_per_member: this._shiftsPerMember(sharedWindow, 'weekly', 1),
                members: members
            }
        };
    },

    // Round-robins N side-lists of PagerDuty user IDs into one flat rotation array:
    // [A1,B1,A2,B2,...]. A side shorter than the longest cycles back to its own start
    // (list[round % list.length]) instead of running out, so its members still get
    // equal turns over the full period. Same algorithm as the v2 file's version --
    // only the element shape changed (plain ID strings here; v3's ShiftMember
    // wrapping happens at the call site instead of being baked into this list).
    _interleaveAlternatingUsers: function(sideUserIdLists) {
        var maxLen = 1;
        for (var s = 0; s < sideUserIdLists.length; s++) maxLen = Math.max(maxLen, sideUserIdLists[s].length);
        var merged = [];
        for (var round = 0; round < maxLen; round++) {
            for (var side = 0; side < sideUserIdLists.length; side++) {
                var list = sideUserIdLists[side];
                merged.push(list[round % list.length]);
            }
        }
        return merged;
    },

    // For rows that share an IDENTICAL coverage window AND anchor (not just an
    // overlapping one) -- e.g. Wintel's "Management Escalation APAC" and "Escalation
    // CAL CECP (Manila)", confirmed via the fix scripts (../servicenow/) to have the
    // same window and anchor with no repeat_count evidence of alternation. v3's
    // every_member_assignment_strategy is the direct, native representation of
    // "these people are all on-call together for this shift" -- everyone ends up in
    // ONE event's members list, so this doesn't run into the rotation-can-only-hold-
    // one-event constraint ASSUMPTION 2 in the file header describes (that's about
    // SEPARATE events in the same rotation, not multiple members in one event).
    _buildEveryMemberEvent: function(rows, sharedWindow, snow, asOf, emailToId, tzName, eventName) {
        var members = [];
        var names = [];
        for (var i = 0; i < rows.length; i++) {
            var memberRows = snow.membersByRosterSysId[rows[i].sys_id] || [];
            var active = this._activeMemberRows(memberRows, asOf);
            if (active.length === 0) {
                members.push({type: 'user_member', user_id: this.FALLBACK_USER_ID});
            } else {
                for (var a = 0; a < active.length; a++) {
                    members.push({type: 'user_member', user_id: this._resolveUser(active[a].member_email, emailToId).id});
                }
            }
            names.push(rows[i].name);
        }

        return {
            name: eventName || names.join(' + '),
            start_time: this._zonedDateTime(sharedWindow.anchorUtcIso, tzName),
            end_time: this._zonedDateTime(this._addSecondsToUtcIso(sharedWindow.anchorUtcIso, sharedWindow.durationSeconds), tzName),
            effective_since: sharedWindow.anchorUtcIso,
            recurrence: [this._rruleForWindow(sharedWindow)],
            assignment_strategy: {
                type: 'every_member_assignment_strategy',
                members: members
            }
        };
    },

    // Converts a wall-clock date+time in an arbitrary IANA time zone to a UTC ISO8601
    // string.
    //
    // Earlier version of this function used session.setTimeZoneName(tzName) +
    // GlideDateTime.setDisplayValueInternal() to get a proper, DST-aware conversion.
    // That's blocked in this scoped app -- confirmed live: "Cannot find function
    // setTimeZoneName in object com.glide.script.fencing.ScopedGlideSession." A
    // follow-up attempt with a hardcoded STANDARD_UTC_OFFSET_SECONDS table worked but
    // was standard-time only (wrong by an hour for DST-observing zones roughly half
    // the year).
    //
    // GlideScheduleDateTime -- an undocumented class (not on ServiceNow's official
    // scoped GlideDateTime API reference, current Australia release included, checked
    // directly) but reported working by multiple independent developers, and now
    // confirmed live in this exact scoped app -- fixes this properly. Its
    // 'TZID=<IANA zone>;<yyyy-MM-dd HH:mm:ss>' constructor form interprets the
    // datetime as wall-clock time IN that zone and converts to UTC, DST included:
    // confirmed against real data (TZID=America/New_York;2026-07-15 19:00:00 ->
    // 2026-07-15 23:00:00, the correct EDT/UTC-4 answer for a July date -- the
    // hardcoded table would have used standard-time UTC-5 and gotten 00:00:00, an
    // hour off). String(gsdt) returns that UTC result as a plain 'yyyy-MM-dd
    // HH:mm:ss' value, same format GlideDateTime.getValue() uses.
    //
    // Given the "undocumented, mixed reliability" reports about this class
    // elsewhere, STANDARD_UTC_OFFSET_SECONDS is kept as a fallback (standard-time
    // only, same limitation as before) if GlideScheduleDateTime throws or returns
    // something unexpected -- so a construction that isn't recognized degrades to
    // "less accurate" rather than "crashes the sync."
    //
    // The compact-date parsing this still depends on: cmn_rota_roster.
    // rotation_start_date/rotation_start_time -- like cmn_schedule_span's date fields
    // (see _parseScheduleDateTime) -- return a compact, separator-less internal value
    // ('20260715'/'190000'), not the usual 'yyyy-MM-dd'/'HH:mm:ss'.
    // _normalizeRosterDate()/_normalizeRosterTime() below convert the compact form to
    // canonical first; they pass an already-canonical value through unchanged, in
    // case this varies by instance.
    _localizedIso: function(dateStr, timeStr, tzName) {
        var canonicalTz = this._canonicalizeTimeZone(tzName);
        var normalizedValue = this._normalizeRosterDate(dateStr) + ' ' + this._normalizeRosterTime(timeStr);
        try {
            var gsdt = new GlideScheduleDateTime('TZID=' + canonicalTz + ';' + normalizedValue);
            var utcValue = String(gsdt);
            if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(utcValue)) {
                return utcValue.replace(' ', 'T') + 'Z';
            }
            gs.warn('PagerDutySync: GlideScheduleDateTime("TZID=' + canonicalTz + ';' + normalizedValue + '") ' +
                'produced an unexpected value ("' + utcValue + '"); falling back to the standard-time-only offset table');
        } catch (e) {
            gs.warn('PagerDutySync: GlideScheduleDateTime threw for "' + canonicalTz + '" (' + e +
                '); falling back to the standard-time-only offset table');
        }
        return this._localizedIsoViaOffsetTable(normalizedValue, canonicalTz, dateStr, timeStr);
    },

    // Fallback for _localizedIso -- see that function's comment.
    _localizedIsoViaOffsetTable: function(normalizedValue, canonicalTz, dateStr, timeStr) {
        var gdt = new GlideDateTime(normalizedValue);
        var offsetSeconds = this.STANDARD_UTC_OFFSET_SECONDS.hasOwnProperty(canonicalTz)
            ? this.STANDARD_UTC_OFFSET_SECONDS[canonicalTz] : null;
        if (offsetSeconds === null) {
            gs.warn('PagerDutySync: no known UTC offset for "' + canonicalTz + '" either; treating ' + dateStr + ' ' +
                timeStr + ' as literal UTC (no conversion applied) -- add it to STANDARD_UTC_OFFSET_SECONDS ' +
                'if this zone is really in use');
        } else {
            gdt.addSeconds(-offsetSeconds); // local wall-clock + offset = UTC, so UTC = local - offset
        }
        return gdt.getValue().replace(' ', 'T') + 'Z';
    },

    // Resolves the UTC instant a roster's own member-rotation phase should anchor
    // to (an event's effective_since). Prefers the roster's own recorded
    // rotation_start_date/rotation_start_time (localized via _localizedIso); if
    // either is blank -- confirmed happens on real data, see README "Known gaps"
    // -- falls back to fallbackAnchorUtcIso (the roster's own coverage window
    // anchor, always available here since _buildEvent always has a window -- see
    // _defaultAlwaysOnWindow for the single_region/no-coverage-window case) or,
    // failing that, FIXED_FALLBACK_ANCHOR_ISO. Never falls back to "now" -- see
    // that constant's comment for why.
    _rotationPhaseAnchorIso: function(rosterRow, tzName, fallbackAnchorUtcIso) {
        if (this._hasRotationStart(rosterRow)) {
            return this._localizedIso(rosterRow.rotation_start_date, this._rotationStartTime(rosterRow), tzName);
        }
        gs.warn('PagerDutySync: roster ' + rosterRow.sys_id + ' (' + rosterRow.name + ') has no ' +
            'rotation_start_date; using a fallback anchor for its rotation phase instead ' +
            '-- which member appears "current" here is not derived from real ServiceNow data');
        return fallbackAnchorUtcIso || this.FIXED_FALLBACK_ANCHOR_ISO;
    },

    // ------------------------------------------------------------------------------
    // ROTATION PHASE ALIGNMENT
    //
    // effective_since (above) does NOT control which member PagerDuty shows as
    // currently on-call -- confirmed against PagerDuty's own v3 API reference for
    // POST .../events: "effective_since... When this event starts producing
    // shifts (UTC)" is a visibility floor, and separately, "past values are
    // clamped to now" (confirmed live: every event's effective_since reads back
    // as the moment of the most recent sync, regardless of what's sent). The
    // event description there is explicit that phase comes from a different
    // triple entirely: "a recurring time window (start_time, end_time,
    // recurrence)" -- i.e. occurrence position is counted from start_time, which
    // this file derives from the coverage window's own span anchor
    // (window.anchorUtcIso), NOT from rotation_start_date. Nothing forces those
    // two dates to agree, and in real data they usually don't (confirmed live:
    // 356-357 days apart for one customer's rota, which happens to land exactly
    // on a half-cycle boundary -- a permanent, deterministic member-position
    // swap, not an intermittent glitch). rotation_start_date genuinely has zero
    // effect on which member shows as on-call without this section.
    //
    // Since start_time can't be moved without either breaking the coverage-window
    // shape or (for a BYDAY pattern) risking landing on an uncovered weekday, the
    // fix instead rotates the *members array* by however many shift-blocks
    // separate window.anchorUtcIso from rotation_start_date, so occurrence 0 at
    // start_time lines up with whichever member should really be first as of
    // rotation_start_date. A blank rotation_start_date (_isBlankRosterValue)
    // leaves the array unrotated -- same "no real anchor to align to" philosophy
    // _rotationPhaseAnchorIso already applies to effective_since.
    // ------------------------------------------------------------------------------

    // How many shift-blocks (of shiftsPerMember occurrences each) separate
    // window.anchorUtcIso from rosterRow.rotation_start_date, mod memberCount --
    // i.e. how far to rotate the members array so occurrence 0 lines up with the
    // roster's real intended first member. Returns 0 (no rotation) whenever
    // there's no real rotation_start_date to align to, or the local-date
    // resolution below can't pin one down -- fails safe to today's unrotated
    // behavior rather than guessing.
    _rotationMemberOffset: function(rosterRow, window, tzName, shiftsPerMember, memberCount) {
        if (memberCount <= 1) return 0; // nothing to rotate
        if (!this._hasRotationStart(rosterRow)) return 0;
        var anchorLocalDate = this._localDateForUtcAnchor(window.anchorUtcIso, tzName);
        if (!anchorLocalDate) return 0;

        var rotationDate = this._normalizeRosterDate(rosterRow.rotation_start_date);
        var elapsedDays = Math.round(this._dateDiffSeconds(anchorLocalDate + ' 00:00:00', rotationDate + ' 00:00:00') / 86400);
        if (elapsedDays === 0) return 0;

        var anchorWeekday = this._weekdayOfDateStr(anchorLocalDate);
        var occurrenceIndex = this._countCoveredDaysBetween(window.days, anchorWeekday, elapsedDays);
        var blocks = Math.floor(occurrenceIndex / shiftsPerMember);

        // _rotateForPhase defines rotated[k] = members[(k+offset) mod N] (rotate
        // LEFT by offset). PagerDuty selects rotated[blocks mod N] as current at
        // rotation_start_date, which expands to members[(blocks+offset) mod N] --
        // for that to land on members[0] (index 0, ServiceNow's intended "first"
        // member), offset must satisfy (blocks+offset) mod N == 0, i.e.
        // offset = -blocks mod N. NOT blocks mod N -- confirmed live via
        // exhaustive validation against real multi-region data: for N=2 (NA/
        // LATAM) blocks mod N and -blocks mod N always coincide (a coincidence of
        // mod-2 arithmetic, since -x = x mod 2 for any integer x), which is
        // exactly why the 2-member cases this was first built and tested against
        // never exposed the missing negation -- N=3/N=4 regions (several other
        // groups' EMEA/APAC-2/Americas rosters) diverge from it in most cases.
        return (((-blocks % memberCount) + memberCount) % memberCount);
    },

    // Finds the local calendar date ('YYYY-MM-DD', in tzName) that anchorUtcIso
    // falls on -- i.e. the real local date of window.anchorUtcIso. Confirmed live
    // that window.startTimeOfDay is NOT a local time-of-day (it's extracted
    // straight from the already-UTC-labeled span value in _computeCoverageWindow,
    // so it's the UTC clock reading) -- an earlier version of this function
    // wrongly fed it into _localizedIso as if it were local, which only
    // coincidentally works when the real UTC offset happens to be a whole number
    // of hours that doesn't cross a day boundary; it silently failed (safely --
    // logged a warning and left the event unrotated, no corruption) for
    // Hardware's own Weekend rota, whose real UTC-7 PDT offset does cross one.
    // This version doesn't need to know any time-of-day at all: for each
    // candidate date, _localizedIso of that date's local midnight and local
    // 23:59:59 bracket the full UTC range that local calendar day spans (ISO8601
    // strings compare correctly as plain strings, chronological order matches
    // lexical order) -- whichever candidate's bracket contains anchorUtcIso is
    // the real local date, regardless of what time of day the anchor actually is.
    // Reuses the already-proven local->UTC direction (_localizedIso) rather than
    // adding a second, independent UTC->local conversion path; the true local
    // date is always within 1 day of anchorUtcIso's own UTC date (no real-world
    // UTC offset exceeds 24h), so trying that date and its two neighbors is
    // exhaustive, not a heuristic.
    _localDateForUtcAnchor: function(anchorUtcIso, tzName) {
        var utcDatePart = anchorUtcIso.substring(0, 10);
        var candidates = [utcDatePart, this._shiftDateStr(utcDatePart, -1), this._shiftDateStr(utcDatePart, 1)];
        for (var i = 0; i < candidates.length; i++) {
            var dayStartUtc = this._localizedIso(candidates[i], '00:00:00', tzName);
            var dayEndUtc = this._localizedIso(candidates[i], '23:59:59', tzName);
            if (anchorUtcIso >= dayStartUtc && anchorUtcIso <= dayEndUtc) return candidates[i];
        }
        gs.warn('PagerDutySync: could not resolve the local calendar date for anchor "' + anchorUtcIso +
            '" in zone "' + tzName + '" (tried ' + candidates.join(', ') + '); leaving this event\'s member ' +
            'order unrotated rather than guessing at rotation-phase alignment');
        return null;
    },

    // 'YYYY-MM-DD' -> 'YYYY-MM-DD', shifted by `days` (may be negative). Treated
    // as a plain calendar-date shift (addDaysUTC on a bare midnight instant), not
    // a real timezone-aware instant -- this is only ever used to generate the two
    // candidate dates either side of a UTC date part, never as a real moment.
    _shiftDateStr: function(dateStr, days) {
        var gdt = new GlideDateTime(dateStr + ' 00:00:00');
        gdt.addDaysUTC(days);
        return gdt.getValue().substring(0, 10);
    },

    // 'YYYY-MM-DD' -> 1(Monday)..7(Sunday), matching _decodeDaysOfWeek's
    // convention. Plain Gregorian-calendar arithmetic (JS Date, UTC-anchored so
    // there's no local-timezone ambiguity in what is purely an abstract "what
    // weekday is this date" fact, independent of any real timezone) -- not a
    // ServiceNow API call, so nothing here depends on GlideDateTime's day-of-week
    // support one way or the other.
    _weekdayOfDateStr: function(dateStr) {
        var parts = dateStr.split('-');
        var jsDay = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10))).getUTCDay(); // 0=Sunday..6=Saturday
        return jsDay === 0 ? 7 : jsDay;
    },

    // Signed count of window-covered days in the `elapsedDays`-day span starting
    // at (and including) a day with weekday `anchorWeekday` -- e.g. elapsedDays=7
    // with every day covered returns 7; elapsedDays=357 with every day covered
    // returns 357 (confirmed against real data: this is exactly NA's case, 357
    // days between its two anchors, both "every day" coverage). Decomposes into
    // whole weeks (each contributing exactly coveredDays.length occurrences,
    // regardless of which specific days those are) plus a bounded remainder check
    // (at most 6 iterations) for the partial week left over, rather than a
    // day-by-day walk across what can be a year or more -- same answer, no loop
    // over hundreds of iterations.
    _countCoveredDaysBetween: function(coveredDays, anchorWeekday, elapsedDays) {
        var sign = elapsedDays < 0 ? -1 : 1;
        var n = Math.abs(elapsedDays);
        var fullWeeks = Math.floor(n / 7);
        var remainder = n % 7;
        var count = fullWeeks * coveredDays.length;
        for (var i = 0; i < remainder; i++) {
            var stepsFromAnchor = sign > 0 ? i : -(i + 1);
            var dow = (((anchorWeekday - 1 + stepsFromAnchor) % 7) + 7) % 7 + 1;
            if (coveredDays.indexOf(dow) !== -1) count++;
        }
        return sign * count;
    },

    // Rotates a members array left by `offset` positions (wrapping), e.g.
    // offset=1 on [A,B] -> [B,A]. offset=0 returns the same array unchanged (no
    // new array allocated) -- the common case, since most rosters' coverage
    // window and rotation_start_date already happen to agree.
    _rotateForPhase: function(members, offset) {
        if (!offset) return members;
        var n = members.length;
        var rotated = [];
        for (var i = 0; i < n; i++) rotated.push(members[(i + offset) % n]);
        return rotated;
    },

    // Confirmed live on real data: a blank cmn_rota_roster.rotation_start_date
    // doesn't always mean an empty string -- ServiceNow's own "unset" sentinel is
    // all zeros ("00000000"), which is truthy and would otherwise slip past a
    // plain `if (value)` check straight into _localizedIso, producing the same
    // kind of invalid-date garbage a truly blank value did before that fallback
    // existed (0000-00-00 isn't a real date).
    //
    // That all-zeros logic is only sound for a DATE. It was originally applied to
    // rotation_start_time too, which is wrong: "000000" is a perfectly real time
    // (midnight), and all-day rotations (rotation_all_day=true) routinely store
    // exactly that. Treating it as unset made every such roster look like it had
    // no rotation start at all -- confirmed live against a customer's SQLDBA
    // APAC-1 Primary (real rotation_start_date 2026-05-04, time 000000), which
    // silently skipped phase alignment and came out exactly one shift-block off
    // (PagerDuty had its 8-person cycle starting Oct 12, ServiceNow Oct 19); 14
    // rosters in that customer's export had the same shape. So: whether a roster
    // has a rotation start is decided by its DATE alone (_hasRotationStart), and
    // a blank/zero time on a real date just means midnight (_rotationStartTime).
    _isBlankRosterValue: function(raw) {
        return !raw || /^0+$/.test(raw);
    },

    _hasRotationStart: function(rosterRow) {
        return !this._isBlankRosterValue(rosterRow.rotation_start_date);
    },

    _rotationStartTime: function(rosterRow) {
        return rosterRow.rotation_start_time || '000000';
    },

    _normalizeRosterDate: function(raw) {
        var m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw || '');
        return m ? (m[1] + '-' + m[2] + '-' + m[3]) : raw;
    },

    _normalizeRosterTime: function(raw) {
        var m = /^(\d{2})(\d{2})(\d{2})$/.exec(raw || '');
        return m ? (m[1] + ':' + m[2] + ':' + m[3]) : raw;
    },

    // time_before_escalation is a glide_duration field: getValue() returns a full
    // datetime string ("1970-01-01 00:15:00") whose HH:MM:SS is the actual duration,
    // not a plain seconds count. A bare parseInt() on that string reads only the
    // leading "1970" (stops at the first "-"), which is where a uniform, bogus
    // "33 minute" delay came from on every row -- 1970/60 rounded. Confirmed via
    // fix_script_q6_q7.txt Q6 (../servicenow/); real values are 15/30 minutes
    // depending on role.
    _parseDelayMinutes: function(raw) {
        var m = /^\d{4}-\d{2}-\d{2} (\d{2}):(\d{2}):(\d{2})$/.exec(raw || '');
        if (!m) {
            gs.error('PagerDutySync: unrecognized time_before_escalation format "' + raw + '"; defaulting delay to 1 minute');
            return 1;
        }
        var totalMinutes = (parseInt(m[1], 10) * 60) + parseInt(m[2], 10) + (parseInt(m[3], 10) / 60);
        return Math.max(1, Math.round(totalMinutes));
    },

    // ------------------------------------------------------------------------------
    // CATCH-ALL
    // ------------------------------------------------------------------------------

    _buildCatchAllRule: function(rotaRows, emailToId) {
        // cmn_rota.use_custom_escalation=true hides the catch_all field on the
        // ServiceNow form entirely (confirmed via the "Custom Escalation Hide
        // Fields" sys_ui_policy on cmn_rota: condition use_custom_escalation=true,
        // action catch_all visible=false) -- it's presented as an alternative to
        // catch_all, not an addition to it. A UI Policy only controls visibility,
        // not the underlying data, so a rota flipped to custom escalation after
        // already having a catch_all value would still have that stale value
        // sitting in the field -- reading it here would apply escalation logic
        // ServiceNow's own form no longer treats as active. There is nothing else
        // to read in its place: ServiceNow doesn't model "custom escalation" as
        // structured data anywhere (the likely-sounding cmn_rota_escalation table
        // is unrelated -- part of the generic event-notification framework, empty
        // in this instance, not referenced by cmn_rota at all) -- so a rota with
        // use_custom_escalation=true contributes no catch-all rule, and whatever
        // its real custom escalation is lives entirely outside ServiceNow, outside
        // this sync's reach. See README's "Custom escalation" section.
        var catchAllTypes = {};
        var rowsByType = {};
        for (var i = 0; i < rotaRows.length; i++) {
            if (rotaRows[i].use_custom_escalation) continue;
            var v = (rotaRows[i].catch_all || '').replace(/^\s+|\s+$/g, '');
            if (!v) continue;
            catchAllTypes[v] = true;
            if (!rowsByType.hasOwnProperty(v)) rowsByType[v] = [];
            rowsByType[v].push(rotaRows[i]);
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

        // group_manager takes priority over individual if a group's rotas somehow
        // disagree (different regions configured differently) -- matches this
        // function's pre-existing behavior of picking one winner rather than
        // building multiple catch-all rules, just extended to a second type
        // instead of silently dropping it.
        var userId, sourceRows;
        if (catchAllTypes.hasOwnProperty('group_manager')) {
            sourceRows = rowsByType.group_manager;
            var managerEmails = {};
            for (var j = 0; j < sourceRows.length; j++) {
                var em = (sourceRows[j].group_manager_email || '').replace(/^\s+|\s+$/g, '');
                if (em) managerEmails[em] = true;
            }
            var emailList = [];
            for (var e in managerEmails) { if (managerEmails.hasOwnProperty(e)) emailList.push(e); }
            emailList.sort();

            if (emailList.length === 0) {
                gs.warn("catch_all is 'group_manager' but group.manager.email is blank on every rota; using the fallback user");
                userId = this.FALLBACK_USER_ID;
            } else {
                if (emailList.length > 1) {
                    gs.warn('this group\'s rotas disagree on group.manager.email [' + emailList.join(', ') + ']; using the first');
                }
                userId = this._resolveUser(emailList[0], emailToId).id;
            }
        } else if (catchAllTypes.hasOwnProperty('individual')) {
            sourceRows = rowsByType.individual;
            var memberEmails = {};
            for (var k = 0; k < sourceRows.length; k++) {
                var mem = (sourceRows[k].catch_all_member_email || '').replace(/^\s+|\s+$/g, '');
                if (mem) memberEmails[mem] = true;
            }
            var memberEmailList = [];
            for (var me in memberEmails) { if (memberEmails.hasOwnProperty(me)) memberEmailList.push(me); }
            memberEmailList.sort();

            if (memberEmailList.length === 0) {
                gs.warn("catch_all is 'individual' but catch_all_member.email is blank on every rota; using the fallback user");
                userId = this.FALLBACK_USER_ID;
            } else {
                if (memberEmailList.length > 1) {
                    gs.warn('this group\'s rotas disagree on catch_all_member.email [' + memberEmailList.join(', ') + ']; using the first');
                }
                userId = this._resolveUser(memberEmailList[0], emailToId).id;
            }
        } else {
            return null; // only 'all' (or something newer/unrecognized) present -- logged above, not built
        }

        return {
            escalation_delay_in_minutes: this._catchAllDelayMinutes(sourceRows),
            targets: [{id: userId, type: 'user_reference'}]
        };
    },

    // catch_all_wait_time is the same glide_duration shape as cmn_rota_roster.
    // time_before_escalation (see _parseDelayMinutes's comment for the format
    // quirk) -- reused here rather than the hardcoded CATCH_ALL_DELAY_MINUTES,
    // which was silently ignoring this field even though ServiceNow's own form
    // always shows it as the configurable delay for the catch-all rule. Falls
    // back to CATCH_ALL_DELAY_MINUTES only when every contributing rota's
    // catch_all_wait_time is blank, and takes the max across rotas when they
    // disagree -- same "don't escalate away from someone too early" reasoning
    // _buildRuleForLevel already applies to time_before_escalation.
    _catchAllDelayMinutes: function(rotaRows) {
        var minutes = null;
        for (var i = 0; i < rotaRows.length; i++) {
            var raw = rotaRows[i].catch_all_wait_time;
            if (!raw) continue;
            var parsed = this._parseDelayMinutes(raw);
            minutes = (minutes === null) ? parsed : Math.max(minutes, parsed);
        }
        return (minutes === null) ? this.CATCH_ALL_DELAY_MINUTES : minutes;
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

    // Escalation policies stay on the classic v2 API (only the schedules they
    // target move to v3 -- see ASSUMPTION 5 in the file header: schedule_v3_
    // reference is accepted as an escalation rule target type right alongside the
    // classic schedule_reference). _findByName here is unchanged from the v2 file
    // and is only used for escalation_policies lookups in this file; schedules use
    // _findScheduleV3ByName below instead, since v3's list endpoint has a different
    // response shape (see that function's comment).
    // alternateNames (optional): fallbacks checked in the same single pass over the
    // list (it's a full re-page of PagerDuty per call, so a second lookup would
    // double the cost) -- only used when nothing matches `name` itself.
    _findByName: function(endpoint, name, alternateNames) {
        var rest = new x_pd_integration.PagerDuty_REST();
        // Does NOT use ?query= -- confirmed live for the v3 schedules endpoint
        // (see _findScheduleV3ByName) that PagerDuty's ?query= parameter silently
        // fails to match names containing the '[' ']' this port's
        // SYNCED_NAME_PREFIX always adds, even though the object is genuinely
        // present. Untested here specifically (this is the classic v2 API, a
        // different, more established surface than v3's schedules endpoint), but
        // the same bracketed naming convention applies to every name this port
        // creates -- including escalation policy names via this function -- so
        // this pages through everything unfiltered instead and relies entirely on
        // the exact-match check below, sidestepping the question rather than
        // risking the same silent-empty-match failure here too.
        //
        // NOTE: previously cached this endpoint's full list across the whole
        // PagerDutySync instance to avoid re-paginating on every lookup -- pulled
        // live 2026-09-22 after it caused a live run to hang. Back to a fresh
        // fetch per call until the caching approach is revisited.
        var found = rest.getAllItemsThrowable(endpoint, function(item) { return item; });
        var matches = [];
        for (var i = 0; i < found.length; i++) {
            if (found[i].name === name) matches.push(found[i]);
        }
        if (matches.length > 1) {
            gs.warn('found ' + matches.length + ' existing ' + endpoint + ' named "' + name + '"; using the first (' +
                matches[0].id + ') and leaving the others as-is');
        }
        if (matches.length) {
            for (var a0 = 0; alternateNames && a0 < alternateNames.length; a0++) {
                for (var f0 = 0; f0 < found.length; f0++) {
                    if (found[f0].name === alternateNames[a0]) {
                        gs.info('note: ' + endpoint + ' "' + alternateNames[a0] + '" (' + found[f0].id + ') also exists alongside "' +
                            name + '" (' + matches[0].id + ') and is being left untouched -- it looks like a stale duplicate');
                    }
                }
            }
            return matches[0];
        }
        for (var a = 0; alternateNames && a < alternateNames.length; a++) {
            for (var f = 0; f < found.length; f++) {
                if (found[f].name === alternateNames[a]) return found[f];
            }
        }
        return null;
    },

    // PagerDuty_REST.getAllItemsThrowable() resolves the response's array key from
    // pathString.split('?')[0] -- fine for a plain v2 path like 'schedules', but
    // wrong for 'v3/schedules' (it would look for responseBody['v3/schedules']
    // instead of the real key, responseBody['schedules'] -- confirmed against the
    // OpenAPI spec's actual response shape). Same offset/limit/more pagination v2
    // uses, just resolving the correct array key explicitly instead of guessing it
    // from the path.
    _pdListAllV3: function(pathString, arrayKey) {
        var rest = new x_pd_integration.PagerDuty_REST();
        var junction = pathString.indexOf('?') === -1 ? '?' : '&';
        var items = [];
        var offset = 0;
        var limit = 100;
        var maxPages = 500;
        for (var page = 0; page < maxPages; page++) {
            var body = rest.getRESTThrowable(pathString + junction + 'limit=' + limit + '&offset=' + offset).data;
            var pageItems = (body && body[arrayKey]) || [];
            items = items.concat(pageItems);
            if (!body || !body.more) break;
            offset = body.offset + body.limit;
        }
        return items;
    },

    // v3/schedules list items are V3ScheduleReference objects -- {id, type, summary,
    // self, html_url} -- with the display name in `summary`, not `name` (confirmed
    // against the OpenAPI spec).
    //
    // Does NOT use v3's ?query= parameter -- confirmed live it doesn't work for
    // names this port actually uses: a schedule named "[ServiceNow Sync v3] Global
    // Wintel CEC Operations - level 100" was confirmed present (visible in an
    // unfiltered list) while ?query=<that exact name> came back with an empty
    // "schedules":[] result. Not a timing issue (the schedule had existed for
    // minutes, confirmed by directly re-testing) -- most likely the `[`/`]` in
    // every name this port creates (see SYNCED_NAME_PREFIX) are being interpreted
    // as search syntax rather than literal characters, though the exact mechanism
    // doesn't matter: this pages through the FULL list instead and relies on the
    // exact-match check below, sidestepping whatever's wrong with ?query= entirely.
    // NOTE: previously cached this list across the whole PagerDutySync instance
    // to avoid re-paginating v3/schedules on every lookup -- pulled live
    // 2026-09-22 after it caused a live run to hang. Back to a fresh fetch per
    // call until the caching approach is revisited.
    _findScheduleV3ByName: function(name) {
        var found = this._pdListAllV3('v3/schedules', 'schedules');
        var matches = [];
        for (var i = 0; i < found.length; i++) {
            if (found[i].summary === name) matches.push(found[i]);
        }
        if (matches.length > 1) {
            gs.warn('found ' + matches.length + ' existing v3 schedules named "' + name + '"; using the first (' +
                matches[0].id + ') and leaving the others as-is');
        }
        return matches.length ? matches[0] : null;
    },

    _nextPlaceholderId: function(kind) {
        this._placeholderCounter[kind] = (this._placeholderCounter[kind] || 0) + 1;
        return kind + '-' + this._placeholderCounter[kind];
    },

    // Applied to every top-level schedule/escalation_policy name this port writes
    // (not to event names, which aren't top-level PagerDuty objects and aren't what
    // someone scanning PagerDuty's schedule/EP list is looking at) -- see
    // SYNCED_NAME_PREFIX in initialize().
    _syncedName: function(name) {
        return this.SYNCED_NAME_PREFIX + name;
    },

    // Upserts one v3 schedule by name, with a single rotation holding `events`
    // (already-built Event request objects). Every sync deletes and recreates every
    // event this schedule's rotation holds, rather than diffing and PUTting existing
    // ones in place -- see ASSUMPTION 3 in the file header for why (in short: v3
    // only allows changing effective_until on an already-"active" event via PUT, so
    // a plain update can't reliably apply roster/shape changes once an event has
    // started). This is the v3 analog of the v2 file's _upsertSchedule, which instead
    // did one PUT replacing the whole schedule_layers array in place (preserving
    // layer ids by name-matching) -- not possible here since schedule/rotation/event
    // are separate resources with their own endpoints, not one atomic replace.
    _upsertScheduleV3: function(name, tzName, description, events, dryRun, collected) {
        var existing = this._findScheduleV3ByName(name);
        var action = existing ? 'update' : 'create';
        collected.schedules.push({
            action: action,
            id: existing ? existing.id : null,
            payload: {schedule: {name: name, time_zone: tzName, description: description}, events: events}
        });

        if (dryRun) {
            if (existing) {
                gs.info('  [dry run] would UPDATE v3 schedule "' + name + '" (' + existing.id + ') with ' + events.length + ' event(s)');
                return existing.id;
            }
            gs.info('  [dry run] would CREATE v3 schedule "' + name + '" with ' + events.length + ' event(s)');
            return this._nextPlaceholderId('schedule');
        }

        var rest = new x_pd_integration.PagerDuty_REST();
        var scheduleId;
        if (existing) {
            scheduleId = existing.id;
            gs.info('updating v3 schedule "' + name + '" -> ' + scheduleId);
        } else {
            var createResult = this._v3WriteOrThrow(rest, 'post', 'v3/schedules', {
                schedule: {name: name, time_zone: tzName, description: description}
            }).data;
            scheduleId = createResult.schedule.id;
            gs.info('created v3 schedule "' + name + '" -> ' + scheduleId);
        }

        // v3 rotations are the analog of v2 schedule LAYERS, not a container that
        // can hold several independent shift patterns at once. Confirmed live:
        // creating a second always-on event in a shared rotation was rejected --
        // "Event with id ... overlaps with this event" (error code 2001) -- even
        // though the two events' own day/time patterns don't conflict (the two
        // alternating groups' shapes were already confirmed non-overlapping by
        // hand). The overlap check is on the event's effective_since/
        // effective_until window (both open-ended = "forever" = unconditionally
        // overlapping in PagerDuty's eyes), not on recurrence shape. So this
        // schedule needs one rotation PER logical event (one per roster row,
        // alternating group, or every_member group) -- matching v2's
        // one-layer-per-row structure -- not one shared rotation holding every
        // event the way this first assumed.
        //
        // Rotations have no name/identifying field of their own (confirmed
        // against the OpenAPI spec -- just {id, type, events}), so matching an
        // existing rotation to a desired event goes through the event it
        // contains: this port only ever puts exactly one event in a rotation it
        // manages, so that event's name is a reliable proxy for the rotation's
        // identity across syncs.
        //
        // Fetches the schedule by id rather than the separate .../rotations
        // endpoint -- confirmed against the OpenAPI spec that GET v3/schedules/{id}
        // already returns the schedule "including rotations and events" in one
        // call (ScheduleResponse.schedule.rotations), so there's no need for a
        // second round trip just to list them.
        var existingRotations = existing
            ? (rest.getRESTThrowable('v3/schedules/' + scheduleId).data.schedule.rotations || [])
            : [];
        var rotationByEventName = {};
        for (var r = 0; r < existingRotations.length; r++) {
            var rotationEvents = existingRotations[r].events || [];
            for (var re = 0; re < rotationEvents.length; re++) {
                rotationByEventName[rotationEvents[re].name] = {rotationId: existingRotations[r].id, event: rotationEvents[re]};
            }
        }

        var desiredNames = {};
        for (var e = 0; e < events.length; e++) desiredNames[events[e].name] = true;

        // Remove rotations whose event no longer corresponds to anything this
        // sync produces -- same "replace everything this port manages" semantics
        // as before.
        var removedRotations = 0;
        for (var existingName in rotationByEventName) {
            if (!rotationByEventName.hasOwnProperty(existingName) || desiredNames.hasOwnProperty(existingName)) continue;
            this._v3WriteOrThrow(rest, 'delete', 'v3/schedules/' + scheduleId + '/rotations/' + rotationByEventName[existingName].rotationId, null);
            removedRotations++;
        }
        if (removedRotations) {
            gs.info('  removed ' + removedRotations + ' rotation(s) from "' + name + '" no longer produced by this sync');
        }

        // PagerDuty rejects DELETE on an event whose effective_until is already in
        // the past -- confirmed live: HTTP 400, error code 2004, "Schedule contains
        // events with effective_until in the past." Such an event is already inert
        // (it stopped producing shifts once effective_until passed) and can't be
        // removed via this endpoint -- but since it's already ended, its window
        // doesn't overlap a new one starting now/in the future, so it's safe to
        // just leave it in place and add the replacement alongside it in the same
        // rotation.
        var now = new GlideDateTime();
        var createdRotationCount = 0, updatedEventCount = 0, skippedEndedCount = 0;
        for (var k = 0; k < events.length; k++) {
            var desiredEvent = events[k];
            var match = rotationByEventName[desiredEvent.name];
            var rotationId;
            if (match) {
                rotationId = match.rotationId;
                var alreadyEnded = false;
                if (match.event.effective_until) {
                    var effectiveUntilGdt = new GlideDateTime(match.event.effective_until.replace('T', ' ').replace(/Z$/, ''));
                    alreadyEnded = effectiveUntilGdt.compareTo(now) < 0;
                }
                if (alreadyEnded) {
                    skippedEndedCount++;
                } else {
                    this._v3WriteOrThrow(rest, 'delete', 'v3/schedules/' + scheduleId + '/rotations/' + rotationId + '/events/' + match.event.id, null);
                }
                updatedEventCount++;
            } else {
                var newRotation = this._v3WriteOrThrow(rest, 'post', 'v3/schedules/' + scheduleId + '/rotations', {}).data;
                rotationId = newRotation.rotation.id;
                createdRotationCount++;
            }
            this._v3WriteOrThrow(rest, 'post', 'v3/schedules/' + scheduleId + '/rotations/' + rotationId + '/events', {event: desiredEvent});
            gs.info('  created event "' + desiredEvent.name + '" on schedule "' + name + '"');
        }
        if (createdRotationCount) gs.info('  created ' + createdRotationCount + ' new rotation(s) on "' + name + '"');
        if (updatedEventCount) gs.info('  updated ' + updatedEventCount + ' existing rotation\'s event on "' + name + '"');
        if (skippedEndedCount) {
            gs.info('  ' + skippedEndedCount + ' matched event(s) had already ended (left in place, PagerDuty ' +
                'won\'t delete them) before adding the replacement alongside them in the same rotation');
        }

        return scheduleId;
    },

    // PagerDuty_REST's own *RESTThrowable() methods extract error detail via
    // extractPagerDutyErrorResponse(), which assumes error.errors is always an
    // ARRAY (matching the v2 API's error shape, {"error":{"errors":["msg"],...}}).
    // Confirmed live this breaks for v3's error shape, where error.errors is an
    // OBJECT keyed by field name (e.g. {"error":{"errors":{"effective_until":
    // ["..."]},...}}) -- errors.length is undefined on a plain object, so that
    // branch never fires, and the real reason is silently dropped in favor of the
    // generic "Method failed: (...) with code: N" wrapper message. Can't fix
    // extractPagerDutyErrorResponse itself (it's part of the officially-installed
    // app, not this port), so this calls the non-throwing REST method directly and
    // logs the full raw response body via gs.error before throwing, for every v3
    // write call -- so a v3 failure's actual reason always ends up in the logs.
    // attempt is 1-based and only used internally for the retry below -- omit it
    // when calling this.
    _v3WriteOrThrow: function(rest, verb, endpoint, body, attempt) {
        attempt = attempt || 1;
        var response = rest[verb + 'REST'](endpoint, body);
        if (response.haveError()) {
            // Immediately using an id a schedule/rotation CREATE just returned
            // occasionally 404s -- confirmed live: a rotation POST against a
            // schedule id returned moments earlier by a successful schedule
            // CREATE got "Schedule Not Found." The id is definitely right (it's
            // the exact one just returned); this looks like backend replication
            // lag between the write and whatever the child-resource endpoints
            // read from, not a logic error here. Retries a few times with a
            // short pause for any 404 before giving up -- gs.sleep() is
            // disallowed in this scoped app (confirmed via function fencing,
            // same family as gs.dateDiff/session.setTimeZoneName; its documented
            // workaround needs a separate GLOBAL-scope Script Include this port
            // doesn't have), so the pause is a bounded busy-wait instead (see
            // _busyWaitMs).
            if (response.getStatusCode() === 404 && attempt < 5) {
                gs.warn('PagerDutySync: v3 ' + verb.toUpperCase() + ' ' + endpoint + ' got 404 (attempt ' +
                    attempt + '/5) -- likely a just-created resource not visible yet; retrying shortly');
                this._busyWaitMs(400);
                return this._v3WriteOrThrow(rest, verb, endpoint, body, attempt + 1);
            }
            gs.error('PagerDutySync: v3 ' + verb.toUpperCase() + ' ' + endpoint + ' failed -- status ' +
                response.getStatusCode() + ', body: ' + response.getBody());
            throw new Error('v3 ' + verb.toUpperCase() + ' ' + endpoint + ' failed (status ' +
                response.getStatusCode() + '): ' + response.getBody());
        }
        var parsed = response.getBody() ? JSON.parse(response.getBody()) : null;
        return {status: response.getStatusCode(), data: parsed};
    },

    _busyWaitMs: function(ms) {
        var start = new GlideDateTime().getNumericValue();
        while ((new GlideDateTime().getNumericValue() - start) < ms) {
            // deliberately busy -- see _v3WriteOrThrow's comment for why there's
            // no real sleep available in this scoped app.
        }
    },

    // Escalation policies are unchanged from the v2 file -- still the classic v2
    // API. Only the `type` on schedule targets differs (schedule_v3_reference vs
    // schedule_reference), which callers set when they build a rule's targets.
    _upsertEscalationPolicy: function(payload, dryRun, collected) {
        var name = payload.escalation_policy.name;
        // Policies created before the suffix was dropped are named "<name> (NEEDS
        // REVIEW)". Adopt (and, via the PUT below, rename) one of those rather than
        // creating a duplicate -- but only when no policy already has the plain
        // name, which always wins (see _findByName).
        var legacyName = name + ' (NEEDS REVIEW)';
        var existing = this._findByName('escalation_policies', name, [legacyName]);
        if (existing && existing.name === legacyName) {
            gs.info('adopting existing policy "' + legacyName + '" (' + existing.id + ') as "' + name + '" -- renaming it in place');
        }
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
        var delayMinutes = this._parseDelayMinutes(rosterRow.time_before_escalation);

        if (this._isSingleIncumbent(memberRows)) {
            var userId = this._pickDirectUser(memberRows, asOf, emailToId);
            return {escalation_delay_in_minutes: delayMinutes, targets: [{id: userId, type: 'user_reference'}]};
        }

        // single_region groups don't have a coverage window computed at all (there's
        // only one region, so there's nothing to restrict WHEN this schedule
        // applies -- it's whoever's turn it is, all the time), same as the v2 file's
        // behavior of never setting .restrictions here.
        var tzName = this._canonicalizeTimeZone(rotaRow.schedule_time_zone);
        var namePrefix = (rotaRow.name.indexOf(rotaRow.group) === 0) ? rotaRow.name : (rotaRow.group + ' - ' + rotaRow.name);
        var event = this._buildEvent(rosterRow, rotaRow, memberRows, this._defaultAlwaysOnWindow(tzName, memberRows), asOf, emailToId, tzName);
        var scheduleName = this._syncedName(namePrefix + ' - ' + rosterRow.name);
        var scheduleId = this._upsertScheduleV3(scheduleName, tzName, this.SYNCED_DESCRIPTION, [event], dryRun, collected);
        return {escalation_delay_in_minutes: delayMinutes, targets: [{id: scheduleId, type: 'schedule_v3_reference'}]};
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

    // follow_the_sun: one EP per GROUP, each level a single v3 schedule made of one
    // event per region (was: one schedule made of one restricted layer per region).
    // Levels are grouped and sequenced by rosterRow.order -- the field ServiceNow
    // itself uses for escalation sequencing -- rather than by matching each region's
    // roster role name against a hardcoded label list. This generalizes to any
    // team's naming convention for free, but it does assume `order` is assigned
    // consistently across regions for the same logical tier (e.g. every region's
    // "first responder" roster row really does carry the same order value) --
    // worth confirming against real data; see README.md "Known gaps". The
    // canonicalized role name is still used, but only for the schedule's display
    // name -- that's cosmetic, not load-bearing for correctness.
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
            var targetTz = this._canonicalizeTimeZone(entries[0].rotaRow.schedule_time_zone);
            var events = [];
            var maxDelay = 1;
            for (var e = 0; e < entries.length; e++) {
                var rosterRow = entries[e].rosterRow;
                var rotaRow2 = entries[e].rotaRow;
                var memberRows = snow.membersByRosterSysId[rosterRow.sys_id] || [];

                var window = coverageWindows[rotaRow2.sys_id];
                if (!window) {
                    gs.warn('no coverage window for "' + rotaRow2.name + '" (' + groupName + ' / ' + levelLabel +
                        ') despite this group being classified follow_the_sun; building this event as always-on -- treat as a bug');
                    window = this._defaultAlwaysOnWindow(targetTz, memberRows);
                }
                events.push(this._buildEvent(rosterRow, rotaRow2, memberRows, window, asOf, emailToId, targetTz));
                maxDelay = Math.max(maxDelay, this._parseDelayMinutes(rosterRow.time_before_escalation));
            }

            var scheduleName = this._syncedName(groupName + ' - ' + levelLabel);
            var scheduleId = this._upsertScheduleV3(scheduleName, targetTz, this.SYNCED_DESCRIPTION, events, dryRun, collected);
            rules.push({
                escalation_delay_in_minutes: maxDelay,
                targets: [{id: scheduleId, type: 'schedule_v3_reference'}]
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
    // for the original order-value-grouping approach this is built on, and the v2
    // file (../servicenow/PagerDutySync.js) for the fuller history of the two
    // refinements below (both found by inspecting real output against a real Wintel
    // sync, not guessed):
    //
    // 1. Rotas with exactly one roster row whose name contains "escalation" are
    //    pulled out and built as their own, later rule(s) -- not blended into the
    //    same tier as multi-row "on shift" rotas just because they happen to share
    //    an order value. Same heuristic as the v2 file, unchanged.
    // 2. Within a tier, rows are first checked for a clean alternating pattern (see
    //    _detectAlternatingGroups) and built as one rotating event
    //    (_buildAlternatingEvent) if so. Remaining rows are then checked for an
    //    identical-window-and-anchor match (_detectIdenticalGroups) and built as one
    //    every_member event (_buildEveryMemberEvent) if so -- the v3 native
    //    representation of "these people page together," all in one event's members
    //    list. This file doesn't need the v2 file's multi-schedule/multi-target-rule
    //    partitioning (_partitionUnitsByNonOverlap) for THIS purpose -- but each
    //    resulting event still gets its own rotation, one per event, since a
    //    rotation can only hold one (see ASSUMPTION 2 in the file header, and
    //    _upsertScheduleV3, which is where that actually gets handled -- not here).
    //    Everything else becomes its own ordinary event, each on its own rotation,
    //    in the same schedule.
    _buildBestEffortEscalationPolicy: function(groupName, snow, coverageWindows, asOf, dryRun, collected) {
        var emailToId = this._emailToIdCache || (this._emailToIdCache = this._pdGetAllUsers());
        gs.info('NOTE: "' + groupName + '" classified needs_review -- this escalation policy is a best-effort approximation.');

        var rosterRows = snow.rostersForGroup();
        if (rosterRows.length === 0) {
            gs.warn('no roster rows found for ' + groupName + '; nothing to build');
            return null;
        }

        var rotaRosterCounts = {};
        for (var c = 0; c < rosterRows.length; c++) {
            rotaRosterCounts[rosterRows[c].rota_sys_id] = (rotaRosterCounts[rosterRows[c].rota_sys_id] || 0) + 1;
        }
        var primaryRows = [];
        var escalationOnlyRows = [];
        for (var i = 0; i < rosterRows.length; i++) {
            var row = rosterRows[i];
            var isEscalationOnly = rotaRosterCounts[row.rota_sys_id] === 1 && /escalation/i.test(row.name);
            if (isEscalationOnly) {
                escalationOnlyRows.push(row);
            } else {
                primaryRows.push(row);
            }
        }
        if (escalationOnlyRows.length > 0) {
            var escalationOnlyNames = [];
            for (var n = 0; n < escalationOnlyRows.length; n++) escalationOnlyNames.push(escalationOnlyRows[n].name);
            gs.info('NOTE: ' + groupName + ': treating single-tier roster(s) named like an escalation contact as a ' +
                'later escalation rule, not the same tier as multi-tier "on shift" rosters: [' +
                escalationOnlyNames.join(', ') + ']');
        }

        var rules = this._buildOrderedRulesForRows(groupName, primaryRows, snow, coverageWindows, asOf, emailToId, dryRun, collected);
        rules = rules.concat(
            this._buildOrderedRulesForRows(groupName + ' - escalation', escalationOnlyRows, snow, coverageWindows, asOf, emailToId, dryRun, collected)
        );

        var catchAll = this._buildCatchAllRule(snow.rotasForGroup(), emailToId);
        if (catchAll) rules.push(catchAll);

        var epPayload = {
            escalation_policy: {
                type: 'escalation_policy',
                // Same name as the follow_the_sun/single_region paths give this group's
                // policy -- the "needs review" flag lives in the description, NOT the
                // name. It used to be a name suffix, which meant any change to a group's
                // classification (confirmed live: a rota's coverage window disappearing
                // flipped a group follow_the_sun -> needs_review) changed the policy's
                // identity, so _findByName found nothing and a second, duplicate policy
                // (plus a differently-named schedule set) was created alongside the
                // original instead of updating it.
                name: this._syncedName(groupName),
                description: this.SYNCED_DESCRIPTION + ' NEEDS REVIEW: this group did not fit a clean follow-the-sun ' +
                    'shape (see PagerDutySync log for the reason), so this policy is a best-effort approximation.',
                num_loops: this.NUM_LOOPS,
                escalation_rules: rules
            }
        };
        this._upsertEscalationPolicy(epPayload, dryRun, collected);
    },

    // Groups rosterRows by order (ascending) and builds one escalation rule per
    // order value, via _buildRuleForLevel. Returns [] for an empty rosterRows list,
    // so callers can freely concat the result (e.g. an empty escalation-only split).
    _buildOrderedRulesForRows: function(scheduleNamePrefix, rosterRows, snow, coverageWindows, asOf, emailToId, dryRun, collected) {
        if (rosterRows.length === 0) return [];

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
            rules.push(this._buildRuleForLevel(
                scheduleNamePrefix, orderKeys[k], byOrder[orderKeys[k]], snow, coverageWindows, asOf, emailToId, dryRun, collected
            ));
        }
        return rules;
    },

    // Builds one escalation rule for a single order level: a direct user target if
    // every row is single-incumbent, otherwise ONE v3 schedule with one rotation
    // per row (or per detected alternating/identical group), each rotation holding
    // exactly one event -- no more multi-schedule bucketing (see the class comment
    // above _buildBestEffortEscalationPolicy and ASSUMPTION 2 in the file header).
    _buildRuleForLevel: function(scheduleNamePrefix, orderValue, rowsAtLevel, snow, coverageWindows, asOf, emailToId, dryRun, collected) {
        var allSingleIncumbent = true;
        for (var r = 0; r < rowsAtLevel.length; r++) {
            var memberRowsAtLevel = snow.membersByRosterSysId[rowsAtLevel[r].sys_id] || [];
            if (!this._isSingleIncumbent(memberRowsAtLevel)) allSingleIncumbent = false;
        }

        var delayMinutes = 1;
        for (var d = 0; d < rowsAtLevel.length; d++) {
            delayMinutes = Math.max(delayMinutes, this._parseDelayMinutes(rowsAtLevel[d].time_before_escalation));
        }

        if (allSingleIncumbent) {
            // Every row at this level names its own person -- e.g. Wintel's
            // "escalation only" tier is 5 single-incumbent rows, one real named
            // contact per region (LATAM, Manila, NA, APAC, EMEA). Confirmed live:
            // picking just the first non-fallback candidate silently dropped 4 of
            // those 5 regions' contacts from the built policy -- only the target
            // list's FIRST match ever made it in. Every distinct resolved person
            // is a target now, matching PagerDuty's native "multiple targets in
            // one rule = notify all simultaneously" -- no schedule/event needed
            // for this, since these are static individuals, not a rotation.
            // Falls back to a single fallback-user target only if literally none
            // of the rows resolved to a real person.
            var targets = [];
            var seenUserIds = {};
            for (var s = 0; s < rowsAtLevel.length; s++) {
                var memberRows = snow.membersByRosterSysId[rowsAtLevel[s].sys_id] || [];
                var candidate = this._pickDirectUser(memberRows, asOf, emailToId);
                if (candidate === this.FALLBACK_USER_ID || seenUserIds.hasOwnProperty(candidate)) continue;
                seenUserIds[candidate] = true;
                targets.push({id: candidate, type: 'user_reference'});
            }
            if (targets.length === 0) targets = [{id: this.FALLBACK_USER_ID, type: 'user_reference'}];
            if (targets.length > 10) {
                gs.warn('PagerDutySync: ' + scheduleNamePrefix + ' order=' + orderValue + ' has ' + targets.length +
                    ' distinct single-incumbent people -- PagerDuty escalation rules cap targets at 10; keeping ' +
                    'the first 10 and dropping the rest (' + (targets.length - 10) + ' person(s) not represented)');
                targets = targets.slice(0, 10);
            }
            return {escalation_delay_in_minutes: delayMinutes, targets: targets};
        }

        var firstRota = snow.rotaBySysId[rowsAtLevel[0].rota_sys_id];
        var targetTz = this._canonicalizeTimeZone(firstRota.schedule_time_zone);

        var alt = this._detectAlternatingGroups(rowsAtLevel, coverageWindows);
        var events = [];
        for (var g = 0; g < alt.alternatingGroups.length; g++) {
            var group = alt.alternatingGroups[g];
            var sharedWindow = coverageWindows[group[0].rota_sys_id];
            var groupNames = [];
            for (var gi = 0; gi < group.length; gi++) groupNames.push(group[gi].name);
            gs.info('NOTE: ' + scheduleNamePrefix + ' order=' + orderValue + ': detected an alternating group ' +
                '(repeat_count=' + sharedWindow.repeatCount + ') -- built as one rotating v3 event: [' +
                groupNames.join(', ') + ']');
            events.push(this._buildAlternatingEvent(group, sharedWindow, snow, asOf, emailToId, targetTz));
        }

        var ident = this._detectIdenticalGroups(alt.remainingRows, coverageWindows);
        for (var ig = 0; ig < ident.identicalGroups.length; ig++) {
            var identGroup = ident.identicalGroups[ig];
            var identWindow = coverageWindows[identGroup[0].rota_sys_id];
            var identNames = [];
            for (var ii = 0; ii < identGroup.length; ii++) identNames.push(identGroup[ii].name);
            gs.info('NOTE: ' + scheduleNamePrefix + ' order=' + orderValue + ': rows share an identical coverage ' +
                'window and anchor -- built as one simultaneous (every_member) v3 event: [' + identNames.join(', ') + ']');
            events.push(this._buildEveryMemberEvent(identGroup, identWindow, snow, asOf, emailToId, targetTz, identNames.join(' + ')));
        }

        for (var rr = 0; rr < ident.remaining.length; rr++) {
            var row = ident.remaining[rr];
            var rotaRow = snow.rotaBySysId[row.rota_sys_id];
            var memberRows2 = snow.membersByRosterSysId[row.sys_id] || [];
            var window = coverageWindows[row.rota_sys_id] || this._defaultAlwaysOnWindow(targetTz, memberRows2);
            events.push(this._buildEvent(row, rotaRow, memberRows2, window, asOf, emailToId, targetTz));
        }

        var scheduleName = this._syncedName(scheduleNamePrefix + ' - level ' + orderValue);
        var scheduleId = this._upsertScheduleV3(scheduleName, targetTz, this.SYNCED_DESCRIPTION, events, dryRun, collected);

        return {escalation_delay_in_minutes: delayMinutes, targets: [{id: scheduleId, type: 'schedule_v3_reference'}]};
    },

    _shapeKey: function(window) {
        if (!window) return null;
        return window.days.join(',') + '|' + window.startTimeOfDay + '|' + window.durationSeconds;
    },

    // Groups same-order-level roster rows by their rota's coverage SHAPE (days +
    // time-of-day + duration). A shape shared by exactly N rows, all with
    // repeat_count=N and N distinct phases within that cycle (see
    // _computeCoverageWindow's cyclePhase/repeatCount), is a clean N-way
    // alternation -- e.g. Wintel's "On shift 1a"/"On shift 1b" pair, confirmed via
    // fix_script_q6_q7.txt Q7 (repeat_count=2 on both, anchors one week apart, in
    // ../servicenow/). Anything less clean (uneven phase coverage, mismatched
    // repeat_count, more/fewer rows than the cycle length) is left in remainingRows
    // rather than guessed at.
    //
    // Also requires each row's OWN rotation to be a plain weekly handoff
    // (rotation_interval_type=Weekly, rotation_interval_count=1) among its active
    // members -- that's what makes it valid to compress a side's own hand-off
    // rotation into consecutive turns of the shared cycle
    // (_buildAlternatingEvent/_interleaveAlternatingUsers). A side with a longer
    // or non-weekly internal cadence would interact with the alternation in a way
    // that isn't verified to be correct, so it's excluded instead of guessed at.
    //
    // Unchanged from the v2 file -- this detection is ServiceNow-side and PagerDuty-
    // API-agnostic; only what CONSUMES its output differs (_buildAlternatingEvent
    // here vs. _buildAlternatingLayer in the v2 file).
    _detectAlternatingGroups: function(rows, coverageWindows) {
        var byShape = {};
        var shapeOrder = [];
        for (var i = 0; i < rows.length; i++) {
            var window = coverageWindows[rows[i].rota_sys_id];
            var key = this._shapeKey(window);
            if (key === null) continue;
            if (!byShape.hasOwnProperty(key)) { byShape[key] = []; shapeOrder.push(key); }
            byShape[key].push({row: rows[i], window: window});
        }

        var alternatingGroups = [];
        var usedRotaIds = {};
        for (var k = 0; k < shapeOrder.length; k++) {
            var entries = byShape[shapeOrder[k]];
            if (entries.length < 2) continue;

            var repeatCount = entries[0].window.repeatCount || 1;
            var clean = repeatCount > 1 && entries.length === repeatCount;
            var phasesSeen = {};
            for (var e = 0; clean && e < entries.length; e++) {
                var w = entries[e].window;
                var row = entries[e].row;
                if ((w.repeatCount || 1) !== repeatCount || w.cyclePhase === null || !w.anchorUtcIso) { clean = false; break; }
                if (this._normalizeIntervalType(row.rotation_interval_type) !== 'weekly' || (parseInt(row.rotation_interval_count, 10) || 1) !== 1) { clean = false; break; }
                var residue = ((w.cyclePhase % repeatCount) + repeatCount) % repeatCount;
                if (phasesSeen.hasOwnProperty(residue)) { clean = false; break; }
                phasesSeen[residue] = entries[e];
            }
            if (!clean) continue;

            var ordered = [];
            for (var p = 0; p < repeatCount; p++) ordered.push(phasesSeen[p].row);
            alternatingGroups.push(ordered);
            for (var u = 0; u < ordered.length; u++) usedRotaIds[ordered[u].rota_sys_id] = true;
        }

        var remainingRows = [];
        for (var r = 0; r < rows.length; r++) {
            if (!usedRotaIds.hasOwnProperty(rows[r].rota_sys_id)) remainingRows.push(rows[r]);
        }
        return {alternatingGroups: alternatingGroups, remainingRows: remainingRows};
    },

    // Among rows NOT part of a clean alternating group (see _detectAlternatingGroups),
    // groups any that share the EXACT same coverage window AND anchor instant -- a
    // stronger condition than just sharing a shape, and the real signal for "these
    // are genuinely meant to page together" (as opposed to "happen to be on the same
    // days/time but are unrelated," which shouldn't be merged just because it's
    // convenient). Two rows with the same shape but a DIFFERENT anchor are left
    // separate -- under repeat_count=1 a different anchor means nothing about timing
    // beyond the first occurrence, so merging them would be guessing.
    //
    // New in this v3 file -- the v2 file didn't need this distinction, since its
    // overlap-partitioning treated "same shape" and "same shape + same anchor" as
    // equally conflicting (both just went through the same bucket-splitting logic).
    // Here it matters because merging into one every_member_assignment_strategy
    // event is a stronger claim ("these people are meant to page together") than
    // just "these two events happen not to collide," so it's reserved for the
    // stronger signal.
    _detectIdenticalGroups: function(rows, coverageWindows) {
        var byKey = {};
        var order = [];
        for (var i = 0; i < rows.length; i++) {
            var window = coverageWindows[rows[i].rota_sys_id];
            if (!window || !window.anchorUtcIso) continue;
            var key = this._shapeKey(window) + '|' + window.anchorUtcIso;
            if (!byKey.hasOwnProperty(key)) { byKey[key] = []; order.push(key); }
            byKey[key].push(rows[i]);
        }
        var identicalGroups = [];
        var used = {};
        for (var k = 0; k < order.length; k++) {
            var group = byKey[order[k]];
            if (group.length < 2) continue;
            identicalGroups.push(group);
            for (var g = 0; g < group.length; g++) used[group[g].rota_sys_id] = true;
        }
        var remaining = [];
        for (var r = 0; r < rows.length; r++) {
            if (!used.hasOwnProperty(rows[r].rota_sys_id)) remaining.push(rows[r]);
        }
        return {identicalGroups: identicalGroups, remaining: remaining};
    },

    type: 'PagerDutySync'
};
