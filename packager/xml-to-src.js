#!/usr/bin/env node
// One-off / refresh tool: disassembles an Update Set XML exported from an instance into the YAML layout the
// packager reads (src/<category>/<type>/<name>.yaml, script bodies in sibling .js files via $ref), plus
// src/defaults.yaml and src/sys_remote_update_set.yaml. Existing files in --out are left alone unless --force.
//   node packager/xml-to-src.js <update-set.xml> [--out=src] [--force]
// After the first conversion, src/ is the source and `npm run package` builds from it; use this again only
// to pull in records captured on an instance.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xml2js = require('xml2js');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..');
const DIRS = {
  'Script Include': 'Server Development/Script Includes', 'Script Action': 'Server Development/Script Actions',
  'Business Rule': 'Server Development/Business Rules', 'UI Action': 'Server Development/UI Actions',
  'Event Registration': 'Server Development/Event Registry', 'Scheduled Script Execution': 'Server Development/Scheduled Script Executions',
  'Table': 'Data Model/Tables', 'Dictionary': 'Data Model/Columns', 'Choice list': 'Data Model/Choice lists',
  'Field Label': 'Other/Field Label', 'Access Control': 'Access Control/Access Controls', 'Access Roles': 'Access Control/Roles',
  'Role': 'Access Control/User roles', 'Form Layout': 'Forms & UI/Forms', 'List Layout': 'Forms & UI/List layouts',
  'Application Menu': 'Navigation/Application menus', 'Module': 'Navigation/Modules'
};
const DROP = ['sys_id', 'sys_recorded_at', 'sys_created_on', 'sys_updated_on', 'remote_update_set', 'payload_hash', 'update_set'];

const safe = (s) => String(s).replace(/[\/\\:*?"<>|]/g, '-').trim() || 'record';

(async () => {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const out = path.resolve(ROOT, (args.find((a) => a.startsWith('--out=')) || '--out=src').split('=')[1]);
  const force = args.includes('--force');
  if (!file) { console.error('usage: xml-to-src.js <update-set.xml> [--out=src] [--force]'); process.exit(1); }
  const doc = await xml2js.parseStringPromise(fs.readFileSync(file, 'utf8'), { explicitArray: false });
  const set = doc.unload.sys_remote_update_set;
  const recs = [].concat(doc.unload.sys_update_xml);
  const write = (rel, text) => {
    const p = path.join(out, rel);
    if (fs.existsSync(p) && !force) { console.log('exists, kept:', rel); return; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };

  const used = new Set();
  for (const r of recs) {
    const dir = DIRS[r.type];
    if (!dir) { console.error(`no directory for type "${r.type}" (${r.name}); add it to DIRS`); process.exit(1); }
    let base = safe(r.target_name || r.name);
    if (used.has(dir + '/' + base)) base += ' - ' + r.name.slice(-8);
    used.add(dir + '/' + base);
    const payload = await xml2js.parseStringPromise(r.payload, { explicitArray: false });
    const rec = payload.record_update[Object.keys(payload.record_update).find((k) => k !== '$')];
    if (typeof rec.script === 'string' && rec.script.trim()) {
      write(`${dir}/${base}.js`, rec.script.endsWith('\n') ? rec.script : rec.script + '\n');
      rec.script = { $ref: `${base}.js` };
    }
    const item = Object.assign({}, r);
    DROP.forEach((k) => delete item[k]);
    item.payload = payload;
    write(`${dir}/${base}.yaml`, YAML.stringify(item));
  }

  const s = Object.assign({}, set);
  write('sys_remote_update_set.yaml', YAML.stringify(s));
  write('defaults.yaml', YAML.stringify({ createdBy: 'snow-rota-sync', updatedBy: 'snow-rota-sync', versionPrefix: 'PagerDuty Sync v', version: '24' }));
  console.log(`${recs.length} records -> ${path.relative(process.cwd(), out)}`);
})();
