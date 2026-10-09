const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const xml2js = require('xml2js');
const P = require('../lib/packager');

const ROOT = path.join(__dirname, '..', '..');
const APP = '39a9d9664f834e00dd657bb28110c77b';
const SET_ID = 'a'.repeat(32);

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
  const all = Object.assign({
    'defaults.yaml': 'createdBy: Tester\nupdatedBy: Tester\nversionPrefix: test-v\nversion: 1.2.3\n',
    'sys_remote_update_set.yaml': `application:\n  _: ${APP}\n  $:\n    display_value: App\napplication_scope: x_scope\nremote_sys_id: ${'b'.repeat(32)}\nsys_id: ${SET_ID}\nname: x\n`
  }, files);
  Object.keys(all).forEach((f) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), all[f]);
  });
  return dir;
}
const record = (name, extra = '') => `name: ${name}\ntype: Script Include\ntarget_name: ${name}\napplication:\n  _: ${APP}\npayload:\n  record_update:\n    sys_script_include:\n      name: ${name}\n      sys_created_by: someone-else\n      script:\n        $ref: ${name}.js\n${extra}`;
const withRecords = (...names) => fixture(names.reduce((acc, n) => Object.assign(acc, { [`${n}.yaml`]: record(n), [`${n}.js`]: `// ${n} & <tags>\n` }), {}));
const problemsOf = (fn) => { try { fn(); } catch (e) { return e.problems || [e.message]; } return []; };

describe('packager: loading and validation', () => {
  it('inlines $ref files, including a .js -> .es12.js fallback', () => {
    const dir = withRecords('A');
    fs.renameSync(path.join(dir, 'A.js'), path.join(dir, 'A.es12.js'));
    const { records } = P.load(dir);
    assert.ok(records[0].payload.record_update.sys_script_include.script.startsWith('// A & <tags>'));
  });

  it('reports every problem at once, and fails', () => {
    const dir = fixture({
      'A.yaml': record('A'), // A.js missing
      'B.yaml': 'name: B\ntype: Script Include\n', // no target_name, payload
      'C.yaml': ':\n  - bad: [yaml'
    });
    const problems = problemsOf(() => P.load(dir)).join('\n');
    assert.match(problems, /A\.yaml: \$ref "A\.js" not found/);
    assert.match(problems, /B\.yaml: "target_name" is missing/);
    assert.match(problems, /B\.yaml: "payload" is missing/);
    assert.match(problems, /C\.yaml: cannot parse yaml/);
  });

  it('rejects two files using the same update name', () => {
    const dir = withRecords('A');
    fs.writeFileSync(path.join(dir, 'A2.yaml'), record('A'));
    assert.match(problemsOf(() => P.load(dir)).join('\n'), /update name "A" is already used by A\.yaml/);
  });

  it('rejects a record from another application scope', () => {
    const dir = withRecords('A');
    fs.writeFileSync(path.join(dir, 'A.yaml'), record('A').replace(APP, 'c'.repeat(32)));
    assert.match(problemsOf(() => P.load(dir)).join('\n'), /differs from the update set's/);
  });

  it('requires defaults.yaml and sys_remote_update_set.yaml with valid ids', () => {
    const dir = withRecords('A');
    fs.writeFileSync(path.join(dir, 'defaults.yaml'), 'createdBy: x\n');
    fs.writeFileSync(path.join(dir, 'sys_remote_update_set.yaml'), 'application_scope: s\nsys_id: nope\n');
    const problems = problemsOf(() => P.load(dir)).join('\n');
    assert.match(problems, /defaults\.yaml: "version" is missing/);
    assert.match(problems, /sys_id must be 32 hex/);
    assert.match(problems, /remote_sys_id must be 32 hex/);
  });

  it('fails on a missing directory and on an empty one', () => {
    assert.match(problemsOf(() => P.load('/nonexistent-dir'))[0], /source directory not found/);
    assert.match(problemsOf(() => P.load(fixture({}))).join('\n'), /no records found/);
  });

  it('rejects a record whose type label is not what exports of its table use (the "Table Column" mistake)', () => {
    const dir = fixture({
      'D.yaml': 'name: sys_dictionary_x_t_a\ntype: Table Column\ntarget_name: T.A\napplication:\n  _: ' + APP + '\npayload:\n  record_update:\n    sys_dictionary:\n      element: a\n'
    });
    assert.match(problemsOf(() => P.load(dir)).join('\n'), /type "Table Column" is not what exports of sys_dictionary records use \("Dictionary"\)/);
    fs.writeFileSync(path.join(dir, 'D.yaml'), fs.readFileSync(path.join(dir, 'D.yaml'), 'utf8').replace('Table Column', 'Dictionary'));
    assert.deepStrictEqual(problemsOf(() => P.load(dir)), []);
  });

  it('does not judge tables it has never seen', () => {
    const dir = fixture({ 'N.yaml': 'name: n1\ntype: Whatever\ntarget_name: N\napplication:\n  _: ' + APP + '\npayload:\n  record_update:\n    some_new_table:\n      a: b\n' });
    assert.deepStrictEqual(problemsOf(() => P.load(dir)), []);
  });

  it('requires a dictionary record to be named the way the platform names it (null for the table itself)', () => {
    const dict = (name, element) => `name: ${name}\ntype: Dictionary\ntarget_name: T\napplication:\n  _: ${APP}\npayload:\n  record_update:\n    sys_dictionary:\n      $:\n        element: "${element}"\n        table: x_t\n      name: x_t\n`;
    const bad = fixture({ 'a.yaml': dict('sys_dictionary_x_t_', ''), 'b.yaml': dict('sys_dictionary_x_t_other', 'col') });
    const problems = problemsOf(() => P.load(bad)).join('\n');
    assert.match(problems, /a\.yaml: update name "sys_dictionary_x_t_" should be "sys_dictionary_x_t_null"/);
    assert.match(problems, /b\.yaml: update name "sys_dictionary_x_t_other" should be "sys_dictionary_x_t_col"/);
    const good = fixture({ 'a.yaml': dict('sys_dictionary_x_t_null', ''), 'b.yaml': dict('sys_dictionary_x_t_col', 'col') });
    assert.deepStrictEqual(problemsOf(() => P.load(fixture({ 'a.yaml': dict('sys_dictionary_x_t_NULL', '') }))), [], 'import set tables use _NULL');
    assert.deepStrictEqual(problemsOf(() => P.load(good)), []);
  });

  it('applies exclude rules', () => {
    const dir = withRecords('Keep', 'MockUtil');
    const { records } = P.load(dir, { exclude: [{ type: 'Script Include', targetNameIncludes: 'Mock' }] });
    assert.deepStrictEqual(records.map((r) => r.name), ['Keep']);
  });
});

describe('packager: output', () => {
  const now = new Date('2026-10-08T17:03:12Z');
  const build = (dir, opts) => P.build(P.load(dir), Object.assign({ now }, opts));

  it('derives record ids from the update set and record name: stable, unique, and not shared with another update set', () => {
    const a = build(withRecords('A', 'B', 'C')).items.map((i) => i.sys_id);
    const again = build(withRecords('C', 'B', 'A')).items.map((i) => i.sys_id).sort();
    assert.deepStrictEqual(a.slice().sort(), again);
    assert.strictEqual(new Set(a).size, 3);
    assert.ok(a.every((id) => /^[a-f0-9]{32}$/.test(id)));
    assert.ok(!a.includes('0'.repeat(32)), 'must not use the app packager\'s index-based ids');
    // same record name, different update set -> different id
    const other = withRecords('A');
    fs.writeFileSync(path.join(other, 'sys_remote_update_set.yaml'), fs.readFileSync(path.join(other, 'sys_remote_update_set.yaml'), 'utf8').replace(SET_ID, 'd'.repeat(32)));
    assert.notStrictEqual(build(other).items[0].sys_id, build(withRecords('A')).items[0].sys_id);
  });

  it('stamps UTC regardless of the machine time zone', () => {
    const script = `const P=require(${JSON.stringify(path.join(ROOT, 'packager', 'lib', 'packager'))});console.log(P.utcStamp(new Date('2026-06-17T17:54:28Z')))`;
    ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo'].forEach((tz) => {
      const r = spawnSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8' });
      assert.strictEqual(r.stdout.trim(), '2026-06-17 17:54:28', tz);
    });
  });

  it('names the update set from the defaults and links every record to it', () => {
    const { updateSet, items } = build(withRecords('A'));
    assert.strictEqual(updateSet.name, 'test-v1.2.3');
    assert.strictEqual(updateSet.application_version, '1.2.3');
    assert.strictEqual(items[0].remote_update_set._, SET_ID);
    assert.strictEqual(items[0].payload_hash, 0);
  });

  it('produces XML that round-trips: payloads are escaped, authorship is normalized everywhere', async () => {
    const dir = withRecords('A');
    const loaded = P.load(dir);
    const xml = P.toXml(P.build(loaded, { now }), loaded.defaults);
    assert.deepStrictEqual(await P.verifyXml(xml, 1), []);
    assert.ok(!xml.includes('someone-else'));
    const doc = await xml2js.parseStringPromise(xml, { explicitArray: false });
    assert.match(doc.unload.sys_update_xml.payload, /<script>\/\/ A &amp; &lt;tags&gt;/);
  });

  it('verifyXml catches a broken payload and a wrong record count', async () => {
    const loaded = P.load(withRecords('A'));
    const xml = P.toXml(P.build(loaded, { now }), loaded.defaults).replace('<record_update>', '<record_update><oops>');
    const problems = await P.verifyXml(xml, 2);
    assert.ok(problems.some((p) => /expected 2/.test(p)));
    assert.ok(problems.some((p) => /not well-formed/.test(p)));
  });
});

describe('packager: command line', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'packager', 'package.js'), ...args], { encoding: 'utf8' });

  it('exits non-zero and lists the problems when the input is bad', () => {
    const r = run(`--from=${fixture({ 'A.yaml': record('A') })}`, `--out=${fs.mkdtempSync(path.join(os.tmpdir(), 'out-'))}`);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /package failed with 1 problem/);
  });

  it('rejects unknown options and empty values instead of guessing', () => {
    assert.strictEqual(run('--release=false').status, 1);
    assert.match(run('--release=false').stderr, /unknown argument/);
    assert.match(run('--from=').stderr, /--from needs a value/);
    assert.match(run('--now=yesterday').stderr, /not a valid date/);
  });

  it('builds a package and exits 0', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
    const r = run(`--from=${withRecords('A')}`, `--out=${out}`, '--now=2026-10-08T17:03:12Z');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(out, 'test-v1.2.3.xml')));
  });
});

describe('this project: src/ -> Update Set', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'packager', ...args.shift().split('/')), ...args], { encoding: 'utf8' });
  const SRC = path.join(ROOT, 'src');

  it('src/ scripts match the repo files they are generated from', () => {
    const r = run('sync-to-src.js', '--check');
    assert.strictEqual(r.status, 0, r.stderr);
  });

  it('builds with no problems, identically twice, with unique record ids', async () => {
    const build = () => {
      const loaded = P.load(SRC);
      const built = P.build(loaded, { now: new Date('2026-10-09T00:00:00Z') });
      return { loaded, built, xml: P.toXml(built, loaded.defaults) };
    };
    const a = build();
    assert.strictEqual(a.xml, build().xml);
    assert.deepStrictEqual(await P.verifyXml(a.xml, a.built.items.length), []);
    assert.strictEqual(new Set(a.built.items.map((i) => i.sys_id)).size, a.built.items.length);
    assert.strictEqual(a.built.updateSet.application_scope, 'global');
  });

  it('ships the Script Include exactly as in git, and the jobs the way the README says', async () => {
    const loaded = P.load(SRC);
    const byTarget = (t) => loaded.records.filter((r) => r.target_name === t);
    const field = (r, table, f) => r.payload.record_update[table][f];
    const si = byTarget('PagerDutySync')[0];
    assert.strictEqual(field(si, 'sys_script_include', 'script'), fs.readFileSync(path.join(ROOT, 'PagerDutySync.js'), 'utf8'));
    assert.strictEqual(field(si, 'sys_script_include', 'access'), 'public');
    const pending = byTarget('PagerDuty Sync - Process Pending')[0];
    assert.strictEqual(field(pending, 'sysauto_script', 'active'), 'false', 'Process Pending must ship inactive');
    assert.match(field(pending, 'sysauto_script', 'script'), /^new global\.PagerDutySync\(\)\.processPending\(\);/);
    assert.strictEqual(field(byTarget('PagerDuty Sync - Nightly Catch-All')[0], 'sysauto_script', 'active'), 'true');
  });

  it('every script that calls PagerDutySync from a rule, job or action qualifies it with global.', () => {
    const loaded = P.load(SRC);
    loaded.records.forEach((r) => {
      const table = P.mainTable(r.payload.record_update);
      if (!['sys_script', 'sysauto_script', 'sysevent_script_action', 'sys_ui_action'].includes(table)) return;
      const script = r.payload.record_update[table].script || '';
      assert.ok(!/new PagerDutySync\(/.test(script), `${r.target_name} uses an unqualified PagerDutySync`);
    });
  });

  it('keeps the unique-group rule and the enrollment table in the package', () => {
    const loaded = P.load(SRC);
    const names = loaded.records.map((r) => r.target_name);
    assert.ok(names.includes('PagerDuty Sync Group - Unique Group'));
    assert.ok(loaded.records.some((r) => r.type === 'Table' && r.payload.record_update.sys_db_object.name === 'u_pagerduty_sync_group'));
  });
});
