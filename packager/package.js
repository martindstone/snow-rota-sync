#!/usr/bin/env node
// Builds Update Set XML file(s) from the YAML records in this project. See lib/packager.js.
//
//   npm run package                     syncs script bodies into src/, then builds src/ into update_set/
//   npm run package -- --from=src       builds one directory
//
// Options: --from=<dir> (repeatable)  --out=<dir>  --config=<yaml with `exclude` rules>
//          --now=<ISO time> (reproducible output)  --legacy (reproduce the app's packager quirks, to compare with its releases only)
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { load, build, toXml, verifyXml, PackageError } = require('./lib/packager');

const ROOT = path.join(__dirname, '..');
const KNOWN = ['from', 'out', 'config', 'now', 'legacy'];

function parseArgs(argv) {
  const opts = { from: [] };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m || !KNOWN.includes(m[1])) throw new PackageError([`unknown argument: ${arg}`]);
    const [, key, value] = m;
    if (key === 'legacy') {
      if (value !== undefined) throw new PackageError(['--legacy takes no value']);
      opts.legacy = true;
    } else {
      if (value === undefined || value === '') throw new PackageError([`--${key} needs a value`]);
      if (key === 'from') opts.from.push(value); else opts[key] = value;
    }
  }
  return opts;
}

function defaultSources() {
  return ['src'];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = opts.now ? new Date(opts.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new PackageError([`--now is not a valid date: ${opts.now}`]);
  const exclude = opts.config ? (YAML.parse(fs.readFileSync(opts.config, 'utf8')).exclude || []) : [];
  const out = path.resolve(ROOT, opts.out || 'update_set');
  fs.mkdirSync(out, { recursive: true });

  for (const from of opts.from.length ? opts.from : defaultSources()) {
    const dir = path.resolve(ROOT, from);
    const loaded = load(dir, { exclude });
    const built = build(loaded, { now, legacy: !!opts.legacy });
    const records = built.items.length;
    const name = built.updateSet.name;
    const xml = toXml(built, loaded.defaults);
    const problems = await verifyXml(xml, records);
    if (problems.length) throw new PackageError(problems.map((p) => `${from}: ${p}`));
    const file = path.join(out, `${name}.xml`);
    fs.writeFileSync(file, xml);
    const types = {};
    loaded.records.forEach((r) => { types[r.type] = (types[r.type] || 0) + 1; });
    console.log(`${from}: ${records} records -> ${path.relative(process.cwd(), file)} (${(xml.length / 1024).toFixed(0)} KB)`);
    console.log('  ' + Object.keys(types).sort().map((t) => `${t}: ${types[t]}`).join(', '));
  }
}

main().catch((e) => {
  if (e instanceof PackageError) {
    console.error(`package failed with ${e.problems.length} problem(s):`);
    e.problems.forEach((p) => console.error(`  - ${p}`));
  } else {
    console.error(e);
  }
  process.exit(1);
});
