'use strict';
/*
 * install-mode.js -- is this Quartz an INSTALLED copy (Quartz-Setup.exe), or one run from a folder?
 *
 * Quartz runs two ways:
 *   - from a folder (a git clone, a zip): `electron .`, or the Quartz.exe that
 *     tools/make-quartz-exe.js stamps inside node_modules\electron\dist, with the folder on the
 *     command line. Electron's default app loads the folder and sets process.defaultApp.
 *   - installed by Quartz-Setup.exe (electron-builder, NSIS, per user): Quartz.exe in
 *     %LOCALAPPDATA%\Programs\Quartz with the app inside its own resources\app folder. No
 *     default app, so process.defaultApp is unset.
 *
 * Why not app.isPackaged: Electron decides that from the exe's file NAME alone (anything but
 * electron.exe counts as packaged), so a folder copy started through the stamped Quartz.exe
 * already reports isPackaged = true. Every installed-only path keys off installedCopy() instead,
 * so a folder copy, however it is started, behaves exactly as it did before installers existed.
 *
 * Pure: the caller passes what it read from Electron, so tests/install-mode-test.js runs it in
 * plain node.
 */
const path = require('path');

/**
 * @param {object} o
 * @param {boolean} [o.defaultApp]    process.defaultApp
 * @param {string}  [o.appPath]       app.getAppPath()
 * @param {string}  [o.resourcesPath] process.resourcesPath
 * @param {string}  [o.platform]      process.platform
 * @returns {boolean} true only for an app that lives inside its own exe's resources folder and
 *   was not loaded by Electron's default app.
 */
function installedCopy(o) {
  const d = o || {};
  if (d.defaultApp === true) return false;
  const app = String(d.appPath || '');
  const res = String(d.resourcesPath || '');
  if (!app || !res) return false;
  const p = d.platform === 'win32' || (d.platform == null && process.platform === 'win32') ? path.win32 : path.posix;
  const fold = (s) => (p === path.win32 ? s.toLowerCase() : s);
  const rel = p.relative(fold(p.resolve(res)), fold(p.resolve(app)));
  return !!rel && !rel.startsWith('..') && !p.isAbsolute(rel);
}

/** installedCopy() for the running Electron app. */
function detect(app) {
  return installedCopy({
    defaultApp: process.defaultApp,
    appPath: app && typeof app.getAppPath === 'function' ? app.getAppPath() : '',
    resourcesPath: process.resourcesPath,
    platform: process.platform,
  });
}

/** The installer behind every "download the new version" link: a stable asset name. */
const INSTALLER_URL = 'https://github.com/atlas-studio-software/quartz/releases/latest/download/Quartz-Setup.exe';

module.exports = { installedCopy, detect, INSTALLER_URL };
