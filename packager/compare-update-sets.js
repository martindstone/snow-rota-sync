#!/usr/bin/env node
// Compares two Update Set XML files record by record (matched on the record's update name).
//   node scripts/compare-update-sets.js <a.xml> <b.xml> [--ignore=field,field] [--max=10]
// Fields that legitimately differ between builds (ids, timestamps) are ignored by default.
const fs = require('fs');
const xml2js = require('xml2js');

const IGNORE = ['sys_id', 'sys_recorded_at', 'sys_created_on', 'sys_updated_on'];

async function read(file) {
  const doc = await xml2js.parseStringPromise(fs.readFileSync(file, 'utf8'), { explicitArray: false });
  const recs = [].concat(doc.unload.sys_update_xml || []);
  return { set: doc.unload.sys_remote_update_set, byName: new Map(recs.map((r) => [r.name, r])), order: recs.map((r) => r.name) };
}

const flat = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

function diffFields(a, b, ignore) {
  const out = [];
  new Set([...Object.keys(a), ...Object.keys(b)]).forEach((k) => {
    if (ignore.includes(k)) return;
    if (flat(a[k]) !== flat(b[k])) out.push(k);
  });
  return out;
}

(async () => {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  const opt = (n, d) => ((args.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d);
  const ignore = IGNORE.concat(opt('ignore', '').split(',').filter(Boolean));
  const max = Number(opt('max', 10));
  const [a, b] = await Promise.all(files.map(read));

  console.log(`A: ${a.byName.size} records   B: ${b.byName.size} records`);
  const onlyA = [...a.byName.keys()].filter((n) => !b.byName.has(n));
  const onlyB = [...b.byName.keys()].filter((n) => !a.byName.has(n));
  console.log(`only in A: ${onlyA.length}`); onlyA.slice(0, max).forEach((n) => console.log(`   ${n}  (${a.byName.get(n).type}: ${a.byName.get(n).target_name})`));
  console.log(`only in B: ${onlyB.length}`); onlyB.slice(0, max).forEach((n) => console.log(`   ${n}  (${b.byName.get(n).type}: ${b.byName.get(n).target_name})`));

  const setDiff = diffFields(a.set, b.set, ignore);
  console.log(`update set fields that differ: ${setDiff.join(', ') || 'none'}`);

  let different = 0; const byField = {}; const examples = [];
  a.byName.forEach((ra, n) => {
    const rb = b.byName.get(n);
    if (!rb) return;
    const d = diffFields(ra, rb, ignore);
    if (d.length) { different++; d.forEach((f) => { byField[f] = (byField[f] || 0) + 1; }); if (examples.length < max) examples.push([n, d]); }
  });
  console.log(`common records: ${a.byName.size - onlyA.length}, with differences: ${different}`);
  Object.keys(byField).forEach((f) => console.log(`   ${f}: ${byField[f]}`));
  examples.forEach(([n, d]) => console.log(`   e.g. ${n}: ${d.join(', ')}`));
  process.exit(onlyA.length || onlyB.length || setDiff.length || different ? 1 : 0);
})();
