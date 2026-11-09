'use strict';
// Tests of PagerDutySync.js decision logic (which rosters count, how a group is classified, which levels become
// direct users or schedules). ServiceNow classes are stubbed and time maths is not exercised: this checks the
// shape of the escalation policy, not schedule times.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'PagerDutySync.js'), 'utf8');

class GlideDateTime {
  constructor(v) {
    if (v instanceof GlideDateTime) { this.ms = v.ms; return; }
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/.exec(String(v || '2026-11-04 12:00:00'));
    this.ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  compareTo(o) { return this.ms < o.ms ? -1 : this.ms > o.ms ? 1 : 0; }
  addSeconds(n) { this.ms += n * 1000; }
  getValue() {
    const d = new Date(this.ms), p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }
}
const AS_OF = new GlideDateTime('2026-11-04 12:00:00');
const ALWAYS = { days: [1, 2, 3, 4, 5, 6, 7], durationSeconds: 86400, anchorUtcIso: 'x', repeatCount: 1 };
const EIGHT_HOURS = { days: [1, 2, 3, 4, 5, 6, 7], durationSeconds: 28800, anchorUtcIso: 'x', repeatCount: 1 };

function load(extraGs) {
  const logs = [];
  const ctx = {
    Class: { create: () => function () { if (this.initialize) this.initialize.apply(this, arguments); } },
    GlideDateTime,
    gs: {
      warn: (m) => logs.push('WARN ' + m), info: (m) => logs.push('INFO ' + m), error: (m) => logs.push('ERR ' + m),
      debug: () => {}, getProperty: (k) => (k === 'x_pd_integration.default_user' ? 'FALLBACK' : ''),
    },
    global: {}, x_pd_integration: {},
  };
  Object.assign(ctx.gs, extraGs || {});
  vm.createContext(ctx);
  vm.runInContext(SOURCE + '\n;this.PS = PagerDutySync;', ctx);
  const sync = Object.create(ctx.PS.prototype);
  ctx.PS.call(sync);
  return { sync, logs };
}

// rotas: [{name, window, rosters: [{name, order, members: [{order, from, to, email}]}]}]
function build(rotas, groupName) {
  const rotaBySysId = {}, rosterBySysId = {}, rosterByRotaSysId = {}, membersByRosterSysId = {}, windows = {}, emails = {};
  rotas.forEach((r, ri) => {
    const id = 'rota' + ri;
    rotaBySysId[id] = { sys_id: id, name: r.name, group: groupName, schedule_sys_id: 'sched' + ri, schedule_time_zone: r.tz || 'UTC', catch_all: '',
      catch_all_wait_time: '', catch_all_member_email: '', use_custom_escalation: false, group_manager_email: '' };
    windows[id] = r.window || ALWAYS;
    rosterByRotaSysId[id] = [];
    r.rosters.forEach((ro, i) => {
      const rid = id + '_roster' + i;
      const row = { sys_id: rid, name: ro.name, order: String(ro.order), rota_sys_id: id,
        time_before_escalation: '1970-01-01 00:15:00', rotation_interval_type: 'weekly', rotation_interval_count: '1' };
      rosterBySysId[rid] = row; rosterByRotaSysId[id].push(row);
      membersByRosterSysId[rid] = (ro.members || []).map((m) => {
        emails[m.email.toLowerCase()] = 'U_' + m.email.split('@')[0];
        return { order: String(m.order), from: m.from || '', to: m.to || '', member_email: m.email };
      });
    });
  });
  return {
    snow: { rotaBySysId, rosterBySysId, rosterByRotaSysId, membersByRosterSysId,
      rotasForGroup: () => Object.values(rotaBySysId), rostersForGroup: () => Object.values(rosterBySysId) },
    windows, emails,
  };
}

// Runs the real _syncOneGroup with data loading, event building and PagerDuty calls stubbed.
function sync(rotas, opts) {
  opts = opts || {};
  const { sync: s, logs } = load();
  const { snow, windows, emails } = build(rotas, 'G');
  const windowForSchedule = {};
  Object.keys(snow.rotaBySysId).forEach((id) => { windowForSchedule[snow.rotaBySysId[id].schedule_sys_id] = windows[id]; });
  const out = { schedules: [], escalation_policies: [], overrides: [] };
  s._loadSnowData = () => snow;
  s._computeCoverageWindow = (scheduleSysId) => Object.assign({}, windowForSchedule[scheduleSysId]); // real _loadCoverageWindows adds .tz
  s._dropExpiredRotas = () => {}; s._loadRosterOverrides = () => ({}); s._warnUnappliedOverrides = () => {};
  s._pdGetAllUsers = () => emails; s._emailToIdCache = emails;
  s._buildEvent = (row, rota, members, window, asOf, emails2, tz) => ({ rota: rota.name, roster: row.name, tz });
  s._buildEveryMemberEvent = (rows, window, snow2, asOf, emails2, tz, name) => ({ rota: name, roster: 'every_member', tz });
  s._detectAlternatingGroups = (rows) => ({ alternatingGroups: [], remainingRows: rows });
  if (!opts.realIdenticalDetection) s._detectIdenticalGroups = (rows) => ({ identicalGroups: [], remaining: rows });
  s._upsertScheduleV3 = (name, tz, d, events) => { out.schedules.push({ name, events }); return 'SCHED:' + name.replace(/^\[.*?\] /, ''); };
  s._buildScopedCatchAllRule = () => null;
  s._upsertEscalationPolicy = (p) => { out.escalation_policies.push(p); };
  s._warnIfWindowsDontTile = () => {}; s._warnIfOrderLevelsDisagreeOnName = () => {};
  s._syncOneGroup('G', AS_OF, true, out);
  const rules = out.escalation_policies.length ? out.escalation_policies[0].escalation_policy.escalation_rules : null;
  return { logs, out, rules, classified: logs.find((l) => /event=classified/.test(l)) || '' };
}

const plain = (x) => JSON.parse(JSON.stringify(x)); // values built inside the vm context have another Array prototype
const person = (n, extra) => Object.assign({ order: 0, email: n + '@x.com', from: '2026-01-01' }, extra || {});
const region = (name, levels, window) => ({
  name, window, rosters: levels.map((l, i) => ({ name: 'L' + l, order: l, members: l === 'empty' ? [] : [person(name + l)] })),
});

describe('PagerDutySync: which members count', () => {
  it('treats member orders of 1000 and above as real members', () => {
    const { sync: s } = load();
    const rows = [
      { order: '1', from: '2025-04-02', to: '2026-03-22', member_email: 'old@x.com' },
      { order: '1001', from: '2026-03-23', to: '', member_email: 'new@x.com' },
      { order: '1002', from: '2026-03-23', to: '', member_email: 'new2@x.com' },
    ];
    assert.deepStrictEqual(plain(s._activeMemberRows(rows, AS_OF).map((r) => r.member_email)), ['new@x.com', 'new2@x.com']);
  });
  it('does not count ended or not-yet-started members', () => {
    const { sync: s } = load();
    const rows = [{ order: '0', from: '', to: '2026-01-01', member_email: 'a' }, { order: '1', from: '2027-01-01', to: '', member_email: 'b' }];
    assert.strictEqual(s._activeMemberRows(rows, AS_OF).length, 0);
  });
});

describe('PagerDutySync: empty rosters are ignored', () => {
  it('drops the empty Quinary of one region (the Major Incident case) and stays follow_the_sun', () => {
    const americas = region('Americas', [100, 200, 300, 400]);
    americas.rosters.push({ name: 'Quinary', order: 500, members: [] });
    const r = sync([americas, region('APAC', [100, 200, 300, 400], EIGHT_HOURS), region('EMEA', [100, 200, 300, 400], EIGHT_HOURS)]);
    assert.match(r.classified, /follow_the_sun/);
    assert.strictEqual(r.rules.length, 4);
    assert.ok(r.rules.every((x) => /^SCHED:/.test(x.targets[0].id)), 'every level is a schedule, never a direct user');
    assert.ok(r.logs.some((l) => /event=roster_ignored group=G rota=Americas roster=Quinary order=500/.test(l)));
  });
  it('a level that only some regions staff is a schedule with events from those regions', () => {
    const emea = region('EMEA', [100, 200], EIGHT_HOURS);
    emea.rosters[1].members = [];
    const r = sync([region('Americas', [100, 200], EIGHT_HOURS), emea]);
    assert.match(r.classified, /follow_the_sun/);
    const level2 = r.out.schedules.find((s) => /L200/.test(s.name) || s.events.some((e) => e.roster === 'L200'));
    assert.deepStrictEqual(plain(level2.events.map((e) => e.rota)), ['Americas']);
  });
  it('a rota with no staffed roster at all is ignored', () => {
    const empty = region('LATAM', [100, 200]);
    empty.rosters.forEach((ro) => { ro.members = []; });
    const r = sync([region('Americas', [100, 200]), region('EMEA', [100, 200]), empty]);
    assert.ok(r.logs.some((l) => /event=rota_ignored group=G rota=LATAM/.test(l)));
    assert.match(r.classified, /follow_the_sun/);
  });
  it('a group whose rosters are all empty is skipped, not synced with a fallback user', () => {
    const only = region('Americas', [100]);
    only.rosters[0].members = [];
    const r = sync([only]);
    assert.strictEqual(r.rules, null);
    assert.strictEqual(r.out.skipped, 'no rota with current coverage; PagerDuty objects left untouched');
  });
});

describe('PagerDutySync: classification', () => {
  it('rotas with different numbers of levels are follow_the_sun when none is an escalation-only tier', () => {
    const r = sync([region('Americas', [100, 200, 300], EIGHT_HOURS), region('EMEA', [100, 200], EIGHT_HOURS)]);
    assert.match(r.classified, /follow_the_sun/);
  });
  it('an escalation-only rota next to multi-level rotas is needs_review', () => {
    const esc = { name: 'Escalation NA', window: EIGHT_HOURS, rosters: [{ name: 'Escalation only CAL', order: 100, members: [person('esc')] }] };
    const r = sync([region('Shift 1', [100, 200]), region('Shift 2', [100, 200]), esc]);
    assert.match(r.classified, /needs_review.*escalation-only tier: Escalation NA/);
  });
});

describe('PagerDutySync: single-person levels', () => {
  it('stay direct user targets when every roster covers all hours', () => {
    const esc = (n) => ({ name: 'Escalation ' + n, window: ALWAYS, rosters: [{ name: 'Escalation only CAL', order: 100, members: [person(n)] }] });
    const r = sync([region('Shift 1', [100, 200]), region('Shift 2', [100, 200]), esc('NA'), esc('EMEA')]);
    const last = r.rules[r.rules.length - 1];
    assert.deepStrictEqual(plain(last.targets.map((t) => t.id)).sort(), ['U_EMEA', 'U_NA']);
  });
  it('become a windowed schedule when a region only covers part of the day (no always-on group)', () => {
    const esc = (n) => ({ name: 'Escalation ' + n, window: EIGHT_HOURS, rosters: [{ name: 'Escalation only CAL', order: 100, members: [person(n)] }] });
    const r = sync([region('Shift 1', [100, 200], EIGHT_HOURS), region('Shift 2', [100, 200], EIGHT_HOURS), esc('NA'), esc('EMEA')]);
    const last = r.rules[r.rules.length - 1];
    assert.strictEqual(last.targets.length, 1);
    assert.match(last.targets[0].id, /^SCHED:/);
    const escSchedule = r.out.schedules.find((s) => /escalation/.test(s.name));
    assert.deepStrictEqual(plain(escSchedule.events.map((e) => e.rota)).sort(), ['Escalation EMEA', 'Escalation NA']);
  });
});

describe('PagerDutySync: logging', () => {
  it('writes every line under one Source, with the version, a run id, the group and a line number', () => {
    const written = [];
    const { sync: s } = load({
      log: (m, src) => written.push({ level: 'info', m, src }),
      logWarning: (m, src) => written.push({ level: 'warn', m, src }),
      logError: (m, src) => written.push({ level: 'error', m, src }),
    });
    s._logVersionAndStart('syncGroup(G)');
    s._logGroup = 'My Group';
    s._log('info', 'PagerDutySync: hello');
    s._log('warn', 'careful');
    s._log('error', 'broken');
    assert.deepStrictEqual(written.map((w) => w.level), ['info', 'info', 'warn', 'error']);
    assert.ok(written.every((w) => w.src === 'PagerDutySync'), 'every line passes the PagerDutySync source');
    const prefix = /^\[PDSync v24\.\d+ ([0-9a-f]{6})( My Group)?\] #\d{3} /;
    assert.ok(written.every((w) => prefix.test(w.m)), written.map((w) => w.m).join('\n'));
    assert.strictEqual(new Set(written.map((w) => prefix.exec(w.m)[1])).size, 1, 'one run id for the whole run');
    assert.match(written[1].m, /#002 hello$/, 'the redundant "PagerDutySync: " is dropped and lines are numbered');
    assert.match(written[0].m, /event=run_start entry="syncGroup\(G\)" version=v24\.\d+-/);
  });
  it('falls back to gs.info/warn/error where the sourced methods do not exist', () => {
    const { sync: s, logs } = load();
    s._logVersionAndStart('x');
    s._log('warn', 'w');
    assert.ok(logs.some((l) => /^WARN \[PDSync .*\] #\d{3} w$/.test(l)));
  });
  it('the constructor warning (fallback user not configured) already carries the version and Source', () => {
    const written = [];
    load({ getProperty: () => '', logWarning: (m, src) => written.push({ m, src }) });
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].src, 'PagerDutySync');
    assert.match(written[0].m, /^\[PDSync v24\.\d+ -\] #001 x_pd_integration\.default_user is not set/);
  });
  it('falls back to gs.info/warn/error when a sourced method throws', () => {
    const boom = () => { throw new Error('not allowed'); };
    const { sync: s, logs } = load({ log: boom, logWarning: boom, logError: boom });
    s._logVersionAndStart('x');
    s._log('info', 'i');
    s._log('warn', 'w');
    s._log('error', 'e');
    assert.deepStrictEqual(plain(logs.map((l) => l.split(' ')[0])), ['INFO', 'INFO', 'WARN', 'ERR']);
    assert.ok(logs.every((l) => /\[PDSync /.test(l)));
  });
  it('never throws, even if every logging method throws', () => {
    const boom = () => { throw new Error('no'); };
    const { sync: s } = load({ log: boom, logWarning: boom, logError: boom, info: boom, warn: boom, error: boom });
    assert.doesNotThrow(() => { s._log('info', 'i'); s._log('warn', 'w'); s._log('error', 'e'); });
  });
  it('formats events as key=value, quoting values that need it', () => {
    const { sync: s, logs } = load();
    s._logEvent('info', 'classified', { group: 'Major Incident (Global)', shape: 'needs_review', reason: '' }, 'text');
    assert.match(logs[0], /event=classified group="Major Incident \(Global\)" shape=needs_review reason="" -- text$/);
  });
  it('names every fallback-user substitution once per run, with the reason and where', () => {
    const { sync: s, logs } = load();
    s._logVersionAndStart('x');
    const emails = { 'known@x.com': 'U1' };
    const ctx = 'roster "Americas / Primary"';
    s._resolveUser('known@x.com', emails, ctx);
    s._resolveUser('unknown@x.com', emails, ctx);
    s._resolveUser('unknown@x.com', emails, ctx);
    s._resolveUser('', emails, ctx);
    s._resolveUser('nobody@x.com', emails); // no context: used for coverage spans that are skipped, not substituted
    const fallbacks = logs.filter((l) => /event=fallback_user/.test(l));
    assert.strictEqual(fallbacks.length, 2);
    assert.match(fallbacks[0], /reason=no_pagerduty_user_with_this_email context="roster \\"Americas \/ Primary\\"" email=unknown@x.com fallback_user=FALLBACK/);
    assert.match(fallbacks[1], /reason=member_has_no_email/);
  });
  it('names the roster when a single-person level has nobody active and the fallback user is used', () => {
    const { sync: s, logs } = load();
    s._logVersionAndStart('x');
    assert.strictEqual(s._pickDirectUser([], AS_OF, {}, 'roster "EMEA / Escalation"'), 'FALLBACK');
    assert.ok(logs.some((l) => /event=fallback_user reason=no_active_members context="roster \\"EMEA \/ Escalation\\""/.test(l)), logs.join('\n'));
  });
});

describe('PagerDutySync: each event is built in its own rota\'s time zone', () => {
  const esc = (name, tz, window) => ({ name, tz, window: window || EIGHT_HOURS,
    rosters: [{ name: 'Escalation only CAL', order: 100, members: [person(name.replace(/\W+/g, ''))] }] });
  const tzOf = (r, rota) => {
    const all = [].concat.apply([], r.out.schedules.map((sc) => plain(sc.events)));
    return all.filter((e) => e.rota === rota).map((e) => e.tz);
  };

  it('Wintel escalation tier: every rota keeps its own zone (PagerDuty rejects Asia/Manila, so it is mapped to Singapore)', () => {
    const r = sync([
      region('Shift 1', [100, 200], EIGHT_HOURS), region('Shift 2', [100, 200], EIGHT_HOURS),
      esc('Escalation CECM LATAM', 'Mexico/General'), esc('Escalation CECP Manila', 'Asia/Manila'),
      esc('Management Escalation EMEA', 'Europe/London'), esc('Management Escalation NA', 'US/Eastern'),
    ]);
    assert.match(r.classified, /needs_review/);
    assert.deepStrictEqual(tzOf(r, 'Escalation CECM LATAM'), ['America/Mexico_City']);
    assert.deepStrictEqual(tzOf(r, 'Escalation CECP Manila'), ['Asia/Singapore']);
    assert.deepStrictEqual(tzOf(r, 'Management Escalation EMEA'), ['Europe/London']);
    assert.deepStrictEqual(tzOf(r, 'Management Escalation NA'), ['America/New_York']);
  });

  it('follow-the-sun levels: each region\'s event uses that region\'s zone', () => {
    const regionIn = (name, tz) => Object.assign(region(name, [100, 200], EIGHT_HOURS), { tz });
    const r = sync([regionIn('Americas', 'US/Eastern'), regionIn('EMEA', 'Europe/London'), regionIn('APAC', 'Asia/Manila')]);
    assert.match(r.classified, /follow_the_sun/);
    assert.deepStrictEqual(tzOf(r, 'Americas'), ['America/New_York', 'America/New_York']);
    assert.deepStrictEqual(tzOf(r, 'EMEA'), ['Europe/London', 'Europe/London']);
    assert.deepStrictEqual(tzOf(r, 'APAC'), ['Asia/Singapore', 'Asia/Singapore']);
  });

  it('rotas with identical windows share one simultaneous event only when they share a zone', () => {
    const same = sync([region('Shift', [100, 200], EIGHT_HOURS), esc('Escalation A', 'Asia/Manila'), esc('Escalation B', 'Asia/Singapore')], { realIdenticalDetection: true });
    const merged = [].concat.apply([], same.out.schedules.map((sc) => plain(sc.events))).filter((e) => e.roster === 'every_member');
    assert.strictEqual(merged.length, 1, 'Manila and Singapore are the same zone, so they merge');
    assert.strictEqual(merged[0].tz, 'Asia/Singapore');

    const differ = sync([region('Shift', [100, 200], EIGHT_HOURS), esc('Escalation A', 'Europe/London'), esc('Escalation B', 'America/New_York')], { realIdenticalDetection: true });
    const none = [].concat.apply([], differ.out.schedules.map((sc) => plain(sc.events))).filter((e) => e.roster === 'every_member');
    assert.strictEqual(none.length, 0, 'identical UTC windows in zones with different daylight saving must stay separate events');
    assert.deepStrictEqual(tzOf(differ, 'Escalation A'), ['Europe/London']);
    assert.deepStrictEqual(tzOf(differ, 'Escalation B'), ['America/New_York']);
  });

  it('the scoped catch-all schedule builds each rota\'s event in that rota\'s zone', () => {
    const { sync: s } = load();
    const emails = { 'm@x.com': 'MGR' };
    const rotas = [
      { sys_id: 'r1', name: 'NA', schedule_time_zone: 'US/Eastern', catch_all: 'group_manager', group_manager_email: 'm@x.com' },
      { sys_id: 'r2', name: 'EMEA', schedule_time_zone: 'Europe/London', catch_all: 'group_manager', group_manager_email: 'm@x.com' },
    ];
    const windows = { r1: Object.assign({}, EIGHT_HOURS, { anchorUtcIso: '2025-04-02T13:00:00Z', startTimeOfDay: '13:00:00' }),
      r2: Object.assign({}, EIGHT_HOURS, { anchorUtcIso: '2025-03-31T08:00:00Z', startTimeOfDay: '08:00:00' }) };
    let built;
    s._upsertScheduleV3 = (name, tz, d, events) => { built = plain(events); return 'S'; };
    s._buildScopedCatchAllRule('G', rotas, windows, emails, true, {});
    assert.deepStrictEqual(built.map((e) => e.start_time.time_zone), ['America/New_York', 'Europe/London']);
  });
});
