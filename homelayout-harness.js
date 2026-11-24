// homelayout-harness.js - pure-node test for homelayout.js's default Home (run: node homelayout-harness.js).
// The look (2026-11-24): Clock, the logo + Search and Markets show by default; every other piece is one
// switch away in Customize; a Home someone customised keeps exactly what they chose; free placement (v2)
// is unchanged. One summary line: "homelayout: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');
const HL = require('./homelayout');

let pass = 0, fail = 0;
function check(ok, what, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + what + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}

const ids = HL.PIECES.map((p) => p.id);
const d = HL.defaults();
const shown = ids.filter((id) => d.hidden.indexOf(id) < 0);
check(shown.join() === 'clock,logo,search,markets', 'default Home: Clock, logo, Search, Markets', shown);
check(d.hidden.join() === 'media,saved,links,stats,apps,session', 'the other six start switched off', d.hidden);
check(d.v === 2 && Array.isArray(d.place) && d.place.length === 0, 'the default is still free placement v2, nothing moved');
check(HL.PIECES.find((p) => p.id === 'clock').column === 'left' && HL.PIECES.find((p) => p.id === 'markets').column === 'right'
  && HL.PIECES.find((p) => p.id === 'search').column === 'centre', 'Clock left, Search centre, Markets right');
check(ids.length === 10, 'all ten pieces still exist (Customize can show any of them)');

check(JSON.stringify(HL.sanitize(null)) === JSON.stringify(d), 'nothing stored = the default Home');
check(HL.isDefault(null) && HL.toStored(HL.defaults()) === null, 'the default is stored as null, as before');
const all = HL.sanitize({ v: 2, hidden: [], place: [] });
check(all.hidden.length === 0, 'a stored Home with nothing hidden keeps everything shown (a saved choice wins)', all);
check(!HL.isDefault(all) && HL.toStored(all) !== null, 'and it is kept as a choice, not folded back into the default');
const mine = HL.sanitize({ v: 2, hidden: ['markets'], place: [{ id: 'clock', h: 'l', x: 40, v: 't', y: 30 }] });
check(mine.hidden.join() === 'markets' && mine.place.length === 1 && mine.place[0].id === 'clock', 'a customised Home: exactly its hidden list and places', mine);
check(HL.sanitize('junk').hidden.join() === d.hidden.join() && HL.sanitize([1, 2]).hidden.join() === d.hidden.join(), 'junk stored = the default Home');
const reset = HL.apply(mine, { op: 'reset' });
check(reset.ok && HL.isDefault(reset.layout), 'Reset brings the new default back');

const css = fs.readFileSync(path.join(__dirname, 'newtab.css'), 'utf8');
check(/@media \(max-width: 1023px\) \{\s*body \{ --home-fold: 1; \}/.test(css), 'the Home folds to one column only below 1024px');
check(!/@media \(max-width: 1295px\) \{\s*body \{ --home-fold: 1; \}/.test(css), 'not at 1295px any more (three columns down to 1024)');

console.log('homelayout: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
