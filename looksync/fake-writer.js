#!/usr/bin/env node
/* VENDORED from ~/look-sync commit 3fa3800 (fake-writer.js), Owen-Silva/look-sync.
   Do not edit this copy: change ~/look-sync, run its tests, then `node looksync/vendor.js <commit>`. */
'use strict';
/*
 * fake-writer.js - drive the shared look file from outside an app, for
 * integration checks. Always pass --dir unless you mean the live store.
 *
 *   node fake-writer.js --dir D [--app quartz] set theme light
 *   node fake-writer.js --dir D set accent 200          (or: set accent null)
 *   node fake-writer.js --dir D set glass.dark.dim 0.6  (any glass leaf; render picture|seeThrough)
 *   node fake-writer.js --dir D --app mantle desktop builtin:snow-peak [file] [still]
 *   node fake-writer.js --dir D race N                  (N publishes as fast as possible; prints a JSON summary)
 *   node fake-writer.js --dir D torn | corrupt | newer  (damage the file on purpose)
 *   node fake-writer.js --dir D show                    (read + validate, print state)
 *   node fake-writer.js --dir D watch [seconds]         (print status / apply / desktop events)
 */
const fs = require('fs');
const path = require('path');
const LS = require('./look-sync');

function args(argv) {
  const o = { app: 'quartz', dir: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') o.dir = argv[++i];
    else if (argv[i] === '--app') o.app = argv[++i];
    else o.rest.push(argv[i]);
  }
  return o;
}

function die(msg) { process.stderr.write(msg + '\n'); process.exit(2); }

async function main() {
  const o = args(process.argv.slice(2));
  const dir = o.dir || LS.defaultDir();
  const [cmd, a, b, c] = o.rest;
  const file = path.join(dir, LS.FILE);
  const sync = LS.create({ app: o.app, dir, enabled: true });
  // Base the write on the current file, like an app that has been running.
  const cur = LS.read(dir);
  if (cur.state === 'ok') { sync.doc = cur.doc; sync.lastDocRev = cur.doc.rev; sync.lastHash = cur.hash; }

  switch (cmd) {
    case 'set': {
      if (!a) die('set needs a field');
      const [field, ...leaf] = a.split('.');
      let value;
      if (field === 'theme') value = b;
      else if (field === 'accent') value = { hue: b === 'null' ? null : Number(b) };
      else if (field === 'glass') {
        const base = cur.state === 'ok' && cur.doc.look.glass ? cur.doc.look.glass.v : JSON.parse(JSON.stringify(LS.SEED.glass));
        if (leaf[0] === 'render') base.render = b;
        else if (leaf.length === 2 && base[leaf[0]]) base[leaf[0]][leaf[1]] = Number(b);
        else die('glass leaf must be dark.X, light.X or render');
        value = base;
      } else die('unknown field ' + field);
      const r = await sync.publish(field, value);
      console.log(JSON.stringify(r));
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case 'desktop': {
      const r = await sync.publishDesktop({ ok: true, reason: null, id: a || 'builtin:snow-peak',
        type: (a || '').startsWith('builtin:') ? 'builtin' : 'picture', title: a || 'Snow peak',
        file: b || null, still: c || null, stillSize: null });
      console.log(JSON.stringify(r));
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case 'race': {
      const n = Number(a) || 50;
      let ok = 0, fail = 0; const codes = {};
      for (let i = 0; i < n; i++) {
        const r = await sync.publish('accent', { hue: (i * 7 + process.pid) % 361 });
        if (r.ok) ok++; else { fail++; codes[r.code || r.reason] = (codes[r.code || r.reason] || 0) + 1; }
      }
      console.log(JSON.stringify({ pid: process.pid, ok, fail, codes }));
      process.exit(0);
      break;
    }
    case 'torn': {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, '{"schema":1,"rev":3,"look":{"theme":{"v":"li');
      break;
    }
    case 'corrupt': {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, 'not json at all');
      break;
    }
    case 'newer': {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ schema: LS.SCHEMA + 1, rev: 1, look: {} }));
      break;
    }
    case 'show': {
      const r = LS.read(dir);
      console.log(JSON.stringify({ state: r.state, reason: r.reason, skipped: r.skipped, doc: r.doc }, null, 2));
      break;
    }
    case 'watch': {
      sync.close();
      const w = LS.create({ app: o.app, dir, enabled: true });
      for (const ev of ['status', 'apply', 'desktop']) w.on(ev, e => console.log(ev, JSON.stringify(e)));
      w.start();
      setTimeout(() => { w.close(); process.exit(0); }, (Number(a) || 30) * 1000);
      return;
    }
    default:
      die('usage: node fake-writer.js --dir D [--app A] set|desktop|race|torn|corrupt|newer|show|watch ...');
  }
  sync.close();
}

main().catch(e => die(String(e && e.stack || e)));
