#!/usr/bin/env node
// Learns which record `type` labels go with which table from a real Update Set XML (e.g. a release of the
// integration app), or from a directory of its disassembled YAML (its src/), and writes lib/known-types.json. The packager
// uses it to reject mislabelled records. What is learned is added to what is already known, so run it once per source.
//   node scripts/learn-types.js <update-set.xml | src-directory>
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const YAML = require('yaml');
const { mainTable } = require('./lib/packager');

const KNOWN_FILE = path.join(__dirname, 'lib', 'known-types.json');

function yamlFiles(dir, out = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yamlFiles(full, out);
    else if (e.name.endsWith('.yaml')) out.push(full);
  });
  return out;
}

(async () => {
  const source = process.argv[2];
  if (!source) { console.error('usage: learn-types.js <update-set.xml | src-directory>'); process.exit(1); }
  const found = []; // { table, type }
  if (fs.statSync(source).isDirectory()) {
    yamlFiles(source).forEach((f) => {
      let doc;
      try { doc = YAML.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return; }
      const table = doc && doc.payload && doc.payload.record_update && mainTable(doc.payload.record_update);
      if (table && doc.type) found.push({ table, type: doc.type });
    });
  } else {
    const doc = await xml2js.parseStringPromise(fs.readFileSync(source, 'utf8'), { explicitArray: false });
    for (const r of [].concat(doc.unload.sys_update_xml)) {
      const payload = await xml2js.parseStringPromise(r.payload);
      const table = mainTable(payload.record_update);
      if (table) found.push({ table, type: r.type });
    }
  }
  const known = fs.existsSync(KNOWN_FILE) ? JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8')) : {};
  found.forEach(({ table, type }) => {
    known[table] = known[table] || [];
    if (!known[table].includes(type)) known[table].push(type);
  });
  const out = {};
  Object.keys(known).sort().forEach((t) => { out[t] = known[t].slice().sort(); });
  fs.writeFileSync(KNOWN_FILE, JSON.stringify(out, null, 2) + '\n');
  console.log(`read ${found.length} records from ${source}; ${Object.keys(out).length} tables are now known`);
})();
