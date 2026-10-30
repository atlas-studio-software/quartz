# Credits and third-party notices

Quartz's own code is licensed under the GNU General Public License, version 3 only
(see [LICENSE](LICENSE), plus the section 7 permission in [LICENSE-EXCEPTIONS.md](LICENSE-EXCEPTIONS.md)). This
file lists what the repository carries, downloads or names that is **not** Quartz's
own work, and the terms each comes under.

## Files in this repository that are NOT covered by the GPL

### Background photos: `assets/backgrounds/`

The 23 built-in backgrounds (full images, `thumbs/` and `catalog.json`) are
photographs from [Unsplash](https://unsplash.com), used under the
[Unsplash License](https://unsplash.com/license). Each photo, its photographer and
its source page are listed in [assets/backgrounds/CREDITS.md](assets/backgrounds/CREDITS.md)
and in `catalog.json` (Settings credits the photographer of the photo you pick).

The Unsplash License is not a free-software licence: it does not allow compiling the
photos to build a similar or competing service, or selling unaltered copies. The GPL
does not apply to these files. If you redistribute Quartz, either keep them under the
Unsplash License's terms or remove them.

### Brave logo: `assets/brave/*.svg`

These are Brave Software's logo files, unchanged, shown on the search results page as
the "Powered by Brave" attribution that the Brave Search API terms describe (section
4(d)). Where they came from and why they are here is in
[assets/brave/SOURCE.md](assets/brave/SOURCE.md). The Brave name and logo are
trademarks of Brave Software, Inc. They are not covered by the GPL, and Quartz is not
affiliated with or endorsed by Brave.

## Runtime: Electron, Chromium and Widevine

- **Electron for Content Security (castlabs ECS)**, pinned in `package.json` as
  `github:castlabs/electron-releases#v44.9.3+wvcus`: MIT License, copyright castLabs
  GmbH (the `LICENSE` of [castlabs/electron-releases](https://github.com/castlabs/electron-releases))
  and the Electron contributors (after `npm ci`, `node_modules/electron/dist/LICENSE`).
  That repository holds the install scripts and documentation; the runtime itself
  (`electron.exe`, which the installer ships as `Quartz.exe`, and its DLLs) is a prebuilt
  binary that castLabs builds from Electron with its Widevine changes.
- **Chromium**, which Electron embeds: BSD-style licence plus the notices of its
  bundled third-party code, all collected in
  `node_modules/electron/dist/LICENSES.chromium.html`.
- **Widevine Content Decryption Module**: proprietary software from Google. It is
  **not in this repository** and not in the npm package. The castlabs runtime
  downloads and installs it on first launch (Chromium's component updater), under
  Google's terms. See the DRM section of the [README](README.md#widevine-and-drm).

## npm dependencies

Counted from `package-lock.json` (production tree, 86 packages). All are compatible
with GPL-3.0:

| Licence | Packages |
| --- | --- |
| MIT | 59 |
| ISC | 7 |
| MPL-2.0 | 12: the Ghostery ad blocker family (`@ghostery/adblocker*`, `@ghostery/url-parser`, `@remusao/*`) |
| Apache-2.0 | 4: `@mozilla/readability`, `detect-libc`, `sumchecker`, `tunnel-agent` |
| BSD-2-Clause | 1: `@electron-internal/extract-zip` |
| BSD-3-Clause | 1: `ieee754` |
| BSD-2-Clause OR MIT OR Apache-2.0 | 1: `rc` |
| MIT OR WTFPL | 1: `expand-template` |

Each package's own licence text is in its folder under `node_modules/` after install.

## Downloaded at runtime (not in this repository)

The Phone tab fetches two tools the first time it is used, into Quartz's profile folder:

- **Android SDK Platform-Tools** (`adb`), from
  `https://dl.google.com/android/repository/platform-tools-latest-windows.zip`:
  Google's Android SDK terms; adb itself is Apache-2.0.
- **The scrcpy server** v4.1, from Genymobile's GitHub releases (the download is
  checked against a pinned SHA-256 in `phone.js`): Apache-2.0, copyright Genymobile
  and Romain Vimont.

## Names of services

YouTube, Disney+, Hulu, Prime Video, ESPN, the NHL, Brave and Unsplash are trademarks of
their respective owners. Quartz and its Lumen view refer to them by name only to say which
site a feature works with. Quartz is an unofficial, independent project: it is not
affiliated with, sponsored by or endorsed by any of them. The Lumen view draws service names
as plain text badges and bundles none of their logos. The live scores use public,
undocumented ESPN and NHL feeds, unofficially and for personal, non-commercial use.
