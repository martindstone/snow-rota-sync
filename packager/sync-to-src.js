#!/usr/bin/env node
// The repo's top-level .js files are the source of truth for every script in the update set. This copies their
// bodies into src/ (the `$ref` targets the packager inlines), so `npm run package` always ships what is in git.
//   node packager/sync-to-src.js           write src/ script files
//   node packager/sync-to-src.js --check   change nothing; exit 1 if src/ is out of date (used by the tests)
//
// A "body" is everything from the first top-level `(function` to the end of the file: the header comments in
// those files document how to create the record by hand and are not part of the script.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SD = 'src/Server Development';
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const body = (f) => { const s = read(f); const i = s.indexOf('\n(function'); if (i < 0) throw new Error(`${f}: no top-level (function`); return s.slice(i + 1).replace(/\s+$/, ''); };

/** The script of the unique-group rule and of the mark-pending rules, as the fix scripts embed them. */
function embedded(file, constName) {
  const m = new RegExp(`${constName} = (?:\\{[\\s\\S]*?script: )?\\[([\\s\\S]*?)\\]\\.join\\('\\\\n'\\)`).exec(read(file));
  if (!m) throw new Error(`${file}: cannot find ${constName}`);
  return m[1].split('\n').map((l) => l.trim()).filter(Boolean).map((l) => eval(l.replace(/,$/, ''))).join('\n'); // eslint-disable-line no-eval
}

const targets = {};
targets[`${SD}/Script Includes/PagerDutySync.js`] = read('PagerDutySync.js');
targets[`${SD}/Script Actions/PagerDuty Sync - Script Action.js`] = body('pagerduty_sync_script_action.js');
const syncAll = body('ui_action_sync_all.js');
const syncThis = body('ui_action_sync_this.js');
const exportCfg = body('ui_action_export_oncall_config.js');
const markPending = body('business_rules_mark_pending.js');

const uiDir = `${SD}/UI Actions`;
fs.readdirSync(path.join(ROOT, uiDir)).filter((f) => f.endsWith('.js')).forEach((f) => {
  targets[`${uiDir}/${f}`] = /^Sync All/.test(f) ? syncAll : /^Sync This/.test(f) ? syncThis : /^Export/.test(f) ? exportCfg : null;
});
const brDir = `${SD}/Business Rules`;
fs.readdirSync(path.join(ROOT, brDir)).filter((f) => f.endsWith('.js')).forEach((f) => {
  targets[`${brDir}/${f}`] = /Unique Group/.test(f) ? embedded('fix_script_create_sync_group_table.js', 'UNIQUE_RULE') : markPending;
});

const jobScript = (name) => {
  const m = new RegExp(`name: '${name}'[\\s\\S]*?script: '([^']*)'`).exec(read('fix_script_create_sync_queue_rules_and_jobs.js'));
  if (!m) throw new Error(`cannot find the script of job "${name}" in fix_script_create_sync_queue_rules_and_jobs.js`);
  return m[1];
};
['PagerDuty Sync - Process Pending', 'PagerDuty Sync - Nightly Catch-All'].forEach((n) => { targets[`${SD}/Scheduled Script Executions/${n}.js`] = jobScript(n); });

const problems = [];
// The queue fix script embeds the mark-pending rule too: it must be the same text.
if (embedded('fix_script_create_sync_queue_rules_and_jobs.js', 'RULE_SCRIPT').trim() !== markPending.replace(/^\s+/, '').trim()) {
  problems.push('RULE_SCRIPT in fix_script_create_sync_queue_rules_and_jobs.js differs from the body of business_rules_mark_pending.js');
}
Object.keys(targets).forEach((t) => { if (targets[t] === null) problems.push(`no source known for ${t}`); });

const check = process.argv.includes('--check');
let changed = 0;
Object.keys(targets).sort().forEach((t) => {
  if (targets[t] === null) return;
  const p = path.join(ROOT, t);
  const current = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  if (current === targets[t]) return;
  changed++;
  if (check) problems.push(`${t} is out of date (run: npm run sync-src)`); else { fs.writeFileSync(p, targets[t]); console.log('updated', t); }
});
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(check ? 'src/ scripts are in sync with the repo' : `${Object.keys(targets).length} scripts checked, ${changed} updated`);
