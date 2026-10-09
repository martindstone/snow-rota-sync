/**
 * Builds a ServiceNow Update Set XML from a directory of Update Set records stored as YAML (the layout used by
 * the PagerDuty ServiceNow integration app (and by pd-ep-renotify): one record per .yaml, script bodies in sibling files via `$ref`).
 *
 * Differences from the integration app's own packager, on purpose:
 *  - record sys_ids are derived from (update set id, record name), not from the file's position, so two update
 *    sets never share record ids and a rebuild yields the same ids;
 *  - timestamps are UTC;
 *  - input is validated up front and every problem is reported together; any problem fails the build;
 *  - files are read in sorted order, so output does not depend on the file system.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const YAML = require('yaml');
const xml2js = require('xml2js');

class PackageError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.problems = problems;
  }
}

const HEX32 = /^[a-f0-9]{32}$/;
const NOT_A_TABLE = new Set(['$', 'sys_es_latest_script', 'sys_translated_text']);

/** The table a record_update is about: its first child element that is not bookkeeping. */
function mainTable(recordUpdate) {
  return Object.keys(recordUpdate || {}).find((k) => !NOT_A_TABLE.has(k));
}

/** type labels the platform's own exports use per table, learned from a real release (scripts/learn-types.js). */
function defaultKnownTypes() {
  try { return require('./known-types.json'); } catch (e) { return null; }
}

function walk(dir, base = dir, out = []) {
  fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .forEach((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, base, out);
      else if (e.name.endsWith('.yaml')) out.push(path.relative(base, full));
    });
  return out;
}

/** Replaces every `{ $ref: 'file' }` node with the file's text. `.js` falls back to `.es12.js`, like the app. */
function resolveRefs(node, dir, file, problems) {
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, dir, file, problems));
  if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string') {
      const candidates = [node.$ref];
      if (node.$ref.endsWith('.js')) candidates.push(node.$ref.replace(/\.js$/, '.es12.js'));
      for (const c of candidates) {
        const p = path.join(dir, c);
        if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
      }
      problems.push(`${file}: $ref "${node.$ref}" not found next to the yaml`);
      return '';
    }
    const out = {};
    Object.keys(node).forEach((k) => { out[k] = resolveRefs(node[k], dir, file, problems); });
    return out;
  }
  return node;
}

function utcStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}`;
}

function deterministicSysId(updateSetId, recordName) {
  return crypto.createHash('md5').update(`${updateSetId}:${recordName}`).digest('hex');
}

// Tables the integration app's packager stamps authorship onto (kept only for byte-comparing with its releases).
const LEGACY_AUTHORSHIP_TABLES = ['catalog_script_client', 'catalog_ui_policy', 'fx_price', 'sc_cat_item_producer', 'sys_app_module',
  'sys_dictionary', 'sys_documentation', 'sys_properties', 'sys_script', 'sys_script_include', 'sys_security_acl',
  'sys_security_acl_role', 'sys_transform_map', 'sys_ui_action', 'sys_ui_page', 'sys_user_role_contains', 'sysevent_register',
  'sysevent_script_action'];

/** `exclude` rules: [{ type, targetNameStartsWith, targetNameIncludes, nameMatches }]; a rule matches when all its keys match. */
function isExcluded(record, rules) {
  return (rules || []).some((r) => {
    if (r.type !== undefined && record.type !== r.type) return false;
    if (r.targetNameStartsWith !== undefined && !String(record.target_name || '').startsWith(r.targetNameStartsWith)) return false;
    if (r.targetNameIncludes !== undefined && !String(record.target_name || '').includes(r.targetNameIncludes)) return false;
    if (r.nameMatches !== undefined && !new RegExp(r.nameMatches).test(String(record.name || ''))) return false;
    return true;
  });
}

/**
 * Loads and checks a source directory. Throws PackageError listing every problem found.
 * @returns {{defaults:Object, updateSet:Object, records:Object[], files:number}}
 */
function load(from, { exclude = [], knownTypes = defaultKnownTypes() } = {}) {
  const problems = [];
  if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) throw new PackageError([`source directory not found: ${from}`]);

  const files = walk(from);
  const loaded = {};
  files.forEach((f) => {
    try {
      const doc = YAML.parse(fs.readFileSync(path.join(from, f), 'utf8'));
      loaded[f] = resolveRefs(doc, path.dirname(path.join(from, f)), f, problems);
    } catch (e) {
      problems.push(`${f}: cannot parse yaml: ${e.message}`);
    }
  });

  const defaults = loaded['defaults.yaml'];
  const updateSet = loaded['sys_remote_update_set.yaml'];
  if (!defaults) problems.push('defaults.yaml is missing');
  if (!updateSet) problems.push('sys_remote_update_set.yaml is missing');
  delete loaded['defaults.yaml'];
  delete loaded['sys_remote_update_set.yaml'];

  if (defaults) {
    ['createdBy', 'updatedBy', 'versionPrefix', 'version'].forEach((k) => {
      if (defaults[k] === undefined || defaults[k] === null || String(defaults[k]) === '') problems.push(`defaults.yaml: "${k}" is missing`);
    });
  }
  if (updateSet) {
    if (!HEX32.test(String(updateSet.sys_id || ''))) problems.push('sys_remote_update_set.yaml: sys_id must be 32 hex characters');
    if (!HEX32.test(String(updateSet.remote_sys_id || ''))) problems.push('sys_remote_update_set.yaml: remote_sys_id must be 32 hex characters');
    if (!updateSet.application || !(HEX32.test(String(updateSet.application._ || '')) || updateSet.application._ === 'global')) problems.push('sys_remote_update_set.yaml: application sys_id is missing');
    if (!updateSet.application_scope) problems.push('sys_remote_update_set.yaml: application_scope is missing');
  }

  const records = [];
  const byName = {};
  const guids = {};
  Object.keys(loaded).forEach((f) => {
    const r = loaded[f];
    if (!r || typeof r !== 'object') return; // parse problem already reported
    const where = (msg) => `${f}: ${msg}`;
    ['name', 'type', 'target_name', 'payload'].forEach((k) => { if (r[k] === undefined || r[k] === null || r[k] === '') problems.push(where(`"${k}" is missing`)); });
    if (r.payload && !r.payload.record_update) problems.push(where('payload has no record_update'));
    if (typeof r.name !== 'string') return;

    if (isExcluded(r, exclude)) return;

    const dict = r.payload && r.payload.record_update && r.payload.record_update.sys_dictionary;
    if (dict && dict.$ && dict.$.table) {
      const expectedName = `sys_dictionary_${dict.$.table}_${dict.$.element || 'null'}`;
      // the platform writes the table's own entry as _null, or _NULL for import set tables: only the letters matter, not their case
      if (r.name.toLowerCase() !== expectedName.toLowerCase()) problems.push(where(`update name "${r.name}" should be "${expectedName}" (what the platform names this dictionary record)`));
    }

    const table = r.payload && mainTable(r.payload.record_update);
    const expected = knownTypes && table && knownTypes[table];
    if (expected && !expected.includes(r.type)) {
      problems.push(where(`type "${r.type}" is not what exports of ${table} records use (${expected.map((t) => `"${t}"`).join(', ')})`));
    }

    if (byName[r.name]) problems.push(where(`update name "${r.name}" is already used by ${byName[r.name]}`));
    byName[r.name] = f;

    if (updateSet && updateSet.application && r.application && r.application._ !== updateSet.application._) {
      problems.push(where(`application ${r.application._} differs from the update set's ${updateSet.application._}`));
    }
    if (r.update_guid) {
      if (guids[r.update_guid]) problems.push(where(`update_guid is also used by ${guids[r.update_guid]}`));
      guids[r.update_guid] = f;
    }
    records.push(r);
  });

  if (!records.length) problems.push('no records found');
  if (problems.length) throw new PackageError(problems);
  return { defaults, updateSet, records, files: files.length };
}

/**
 * Applies defaults and returns the structures to serialize.
 * @param {{legacy?:boolean, now?:Date}} opts legacy reproduces the app's index-based ids and its authorship stamping,
 *   including the stray elements it adds to sys_documentation wrappers. Only for comparing with its releases.
 */
function build({ defaults, updateSet, records }, { now = new Date(), legacy = false } = {}) {
  const version = String(defaults.version);
  const stamp = utcStamp(now);
  const withBy = (obj) => Object.assign(obj, { sys_created_by: defaults.createdBy, sys_updated_by: defaults.updatedBy });

  const items = records.map((original, index) => {
    const item = JSON.parse(JSON.stringify(original));
    if (item.name === `sys_app_${updateSet.application._}` && item.payload.record_update.sys_app) {
      item.payload.record_update.sys_app.version = version;
    }
    if (/^sys_properties_[a-f0-9]{32}$/.test(item.name)) {
      item.update_guid = '';
      item.update_guid_history = '';
    }
    item.remote_update_set = { $: { display_value: defaults.versionPrefix + version }, _: updateSet.sys_id };
    item.sys_id = legacy ? String(index).padStart(32, '0') : deterministicSysId(updateSet.sys_id, item.name);
    item.sys_recorded_at = `${now.getTime().toString(16)}0000001`;
    withBy(item);
    if (legacy && item.payload && item.payload.record_update) {
      LEGACY_AUTHORSHIP_TABLES.forEach((table) => {
        const node = item.payload.record_update[table];
        if (!node) return;
        withBy(node);
        if (table === 'sys_documentation' && node[table]) withBy(node[table]);
      });
    }
    item.sys_created_on = stamp;
    item.sys_updated_on = stamp;
    item.payload_hash = 0;
    return item;
  });

  const set = JSON.parse(JSON.stringify(updateSet));
  set.application_version = version;
  set.name = defaults.versionPrefix + version;
  withBy(set);
  set.sys_created_on = stamp;
  set.sys_updated_on = stamp;
  return { updateSet: set, items };
}

/** Serializes to the XML string a ServiceNow instance imports. */
function toXml({ updateSet, items }, defaults) {
  const payloadBuilder = new xml2js.Builder({ renderOpts: { pretty: false } });
  items.forEach((u) => { u.payload = payloadBuilder.buildObject(u.payload); });
  const builder = new xml2js.Builder({ cdata: true });
  const xml = builder.buildObject({ unload: { sys_remote_update_set: updateSet, sys_update_xml: items } });
  // The platform records who made each change; ours is the packaging identity, including inside payloads.
  return xml
    .replace(/<sys_created_by>.*?<\/sys_created_by>/g, `<sys_created_by>${defaults.createdBy}</sys_created_by>`)
    .replace(/<sys_updated_by>.*?<\/sys_updated_by>/g, `<sys_updated_by>${defaults.updatedBy}</sys_updated_by>`);
}

/** Re-reads the XML we produced and checks it is what we meant to produce. Returns a list of problems. */
async function verifyXml(xml, expectedRecords) {
  const problems = [];
  let doc;
  try {
    doc = await xml2js.parseStringPromise(xml, { explicitArray: true });
  } catch (e) {
    return [`output is not well-formed XML: ${e.message}`];
  }
  const set = doc.unload && doc.unload.sys_remote_update_set && doc.unload.sys_remote_update_set[0];
  const recs = (doc.unload && doc.unload.sys_update_xml) || [];
  if (!set) problems.push('output has no sys_remote_update_set');
  if (recs.length !== expectedRecords) problems.push(`output has ${recs.length} records, expected ${expectedRecords}`);
  const setId = set && set.sys_id && set.sys_id[0];
  const ids = new Set();
  for (const r of recs) {
    const name = r.name && r.name[0];
    const id = r.sys_id && r.sys_id[0];
    if (ids.has(id)) problems.push(`duplicate record sys_id ${id}`);
    ids.add(id);
    const ru = r.remote_update_set && r.remote_update_set[0];
    if (!ru || ru._ !== setId) problems.push(`${name}: not linked to the update set`);
    try {
      const payload = await xml2js.parseStringPromise(r.payload[0]);
      if (!payload.record_update) problems.push(`${name}: payload is not a record_update`);
    } catch (e) {
      problems.push(`${name}: payload is not well-formed XML: ${e.message}`);
    }
  }
  return problems;
}

module.exports = { PackageError, mainTable, load, build, toXml, verifyXml, deterministicSysId, utcStamp, isExcluded };
