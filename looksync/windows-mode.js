/* VENDORED from ~/look-sync commit 3fa3800 (windows-mode.js), Owen-Silva/look-sync.
   Do not edit this copy: change ~/look-sync, run its tests, then `node looksync/vendor.js <commit>`. */
'use strict';
/*
 * windows-mode.js - resolve theme "system" from the Windows APPS mode
 * (Look Sync contract, section 3). Zero dependencies, CommonJS.
 *
 * Reads HKCU\...\Themes\Personalize AppsUseLightTheme with reg.exe. Do not use
 * prefers-color-scheme or nativeTheme.shouldUseDarkColors for this: Quartz's
 * siteTheme overrides nativeTheme.themeSource, so those reflect the site theme.
 * Re-read on nativeTheme 'updated'.
 *
 *   appsMode()      -> Promise<{ light: true|false|null, reason }>
 *   appsModeSync()  -> { light, reason }
 *   resolveTheme(mode, light) -> 'light' | 'dark'
 */
const { execFile, execFileSync } = require('child_process');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
const ARGS = ['query', KEY, '/v', 'AppsUseLightTheme'];

function parseRegOutput(text) {
  const m = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(text || ''));
  if (!m) return { light: null, reason: 'AppsUseLightTheme not found in the registry output' };
  return { light: parseInt(m[1], 16) !== 0, reason: null };
}

function unsupported() {
  return process.platform === 'win32' ? null
    : { light: null, reason: 'Not Windows (' + process.platform + '): no apps mode to read' };
}

function appsMode() {
  const u = unsupported();
  if (u) return Promise.resolve(u);
  return new Promise(resolve => {
    execFile('reg', ARGS, { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      if (err) {
        // A missing value means Windows has never been switched: light is the OS default.
        if (/unable to find/i.test(String(err.message))) return resolve({ light: true, reason: 'AppsUseLightTheme is not set; Windows default is light' });
        return resolve({ light: null, reason: "Couldn't read Windows apps mode: " + (err.code || err.message) });
      }
      resolve(parseRegOutput(stdout));
    });
  });
}

function appsModeSync() {
  const u = unsupported();
  if (u) return u;
  try {
    return parseRegOutput(execFileSync('reg', ARGS, { windowsHide: true, timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (err) {
    if (/unable to find/i.test(String(err.stderr || err.message))) return { light: true, reason: 'AppsUseLightTheme is not set; Windows default is light' };
    return { light: null, reason: "Couldn't read Windows apps mode: " + (err.code || err.message) };
  }
}

// mode: 'system' | 'light' | 'dark'. light: the apps-mode reading (null = unknown -> dark,
// the agreed seed; the caller shows the reason from appsMode()).
function resolveTheme(mode, light) {
  if (mode === 'light' || mode === 'dark') return mode;
  return light === true ? 'light' : 'dark';
}

module.exports = { appsMode, appsModeSync, resolveTheme, parseRegOutput, KEY };
