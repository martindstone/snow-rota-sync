# Packager

Builds the importable Update Set from the records under `src/`. Adapted from the packager in `pd-ep-renotify`
(same record layout and checks); the differences are listed at the end.

```
npm install            # once: xml2js and yaml (and mocha for the tests)
npm run package        # sync-to-src, then src/ -> update_set/<name>.xml
npm run sync-src       # only copy the repo's scripts into src/
npm test               # packager tests + "src/ matches git" + project checks
```

`npm run package -- --now=2026-10-09T00:00:00Z` makes the output reproducible (record ids are already stable: md5 of
update set id + record name).

## Where things live

| | |
|---|---|
| `PagerDutySync.js`, `ui_action_*.js`, `pagerduty_sync_script_action.js`, `business_rules_mark_pending.js`, the embedded rule scripts in the two `fix_script_*.js`, and the job scripts in `fix_script_create_sync_queue_rules_and_jobs.js` | **Source of truth for every script.** Edit these. |
| `src/**/*.js` | Generated copies of those scripts (`packager/sync-to-src.js`). Don't edit; `npm test` fails if they are stale. |
| `src/**/*.yaml` | One Update Set record per file (table, columns, ACLs, rules, UI Actions, jobs...). Edit these by hand for non-script settings, or capture them from an instance (below). |
| `src/defaults.yaml`, `src/sys_remote_update_set.yaml` | Name prefix, version (**bump `version` for every release**) and the Update Set record. Global scope: the application id is the literal `global`. |
| `update_set/` | Built XML. Commit the one you tested. |

## Changing something

- A script: edit the repo's top-level `.js` file, `npm run package`.
- A setting on a record (a Business Rule condition, a UI Action's table, a column): edit its `.yaml` in `src/` and rebuild.
- A new kind of record, or one easier to set up in the UI: build it on the dev instance in an Update Set, export it, then pull it in with
  `node packager/xml-to-src.js <export.xml> --out=src` (existing files are kept unless `--force`). Add a mapping for any new script in
  `packager/sync-to-src.js`.

## What it checks (all problems are listed together; any problem fails the build)

Every `$ref` file exists; yaml parses; required keys on every record; update names and guids unique; every record belongs to the Update
Set's application; dictionary records are named the way the platform names them; each record's `type` is what exports of its table use
(`packager/lib/known-types.json`, learned from real exports with `packager/learn-types.js`); after writing, the XML is re-read: well formed,
right record count, unique ids, every payload parses, every record linked to the Update Set.

## Differences from the pd-ep-renotify copy

- Output goes to `update_set/`; there are no add-ons, only `src/`.
- Accepts `global` as the Update Set's application id.
- `npm run package` runs `sync-to-src.js` first, so the XML always contains what is in git.
- `known-types.json` also learned from this project's own export; the integration-app comparison tests were dropped.

## Not verified here

The Scheduled Job records (`src/Server Development/Scheduled Script Executions/`) were modelled on the renotify project's job record
and have not been imported yet. The previous export from the dev instance did not contain jobs at all (the instance does not track
them), so the first import on a clean instance should check that both jobs arrive, with "Process Pending" **inactive**. The fix script
still creates them by name if they are missing.
