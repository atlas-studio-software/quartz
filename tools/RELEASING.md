# Cutting a Quartz release

Quartz's in-app updater (`updater.js`) offers whatever GitHub calls the **latest release** of
`Owen-Silva/quartz`. A release is a tag named `v<version>` (the `version` in `package.json`) on the
default branch, plus a GitHub release for that tag. Drafts and pre-releases are never "latest",
so the updater never sees them.

1. Start from a clean, pushed default branch:

   ```
   git switch master
   git pull --ff-only
   git status
   ```

2. Bump the version in `package.json` and `package-lock.json`, commit and push:

   ```
   npm version 0.2.0 --no-git-tag-version
   git commit -am "Quartz 0.2.0"
   git push origin master
   ```

   A version bump on its own does not make users run `npm ci`; the updater only runs it when the
   dependencies themselves change.

3. Sign the tag, verify it, push it, and publish the release (the notes are what users see behind
   "What's new"):

   ```
   node tools/release-tag.js --push
   gh release create v0.2.0 --verify-tag --title "Quartz 0.2.0" --notes-file notes.md
   ```

   `release-tag.js` refuses a dirty tree, a HEAD that is not on the pushed default branch, and an
   existing tag. It signs `v<version>` with `git tag -s` (SSH signing, all settings on its own
   command line), verifies it exactly as the updater will, and only then pushes. A tag that does not
   verify is deleted again and nothing is pushed. Never push a release tag by hand: an unsigned tag
   is refused by every copy that has a key (see "Signed release tags" below).

   `--generate-notes` instead of `--notes-file` lists the commits since the last release.

4. Check what the updater will see:

   ```
   gh api repos/Owen-Silva/quartz/releases/latest --jq .tag_name
   ```

Rules that keep updates safe:

- The tag must be on the default branch, so every user's clone can fast-forward to it.
- Never move or delete a published tag. If a release is wrong, publish a newer one.
- To try a release without offering it to anyone, create it with `--draft` or `--prerelease`.
- Every release tag is signed (step 3). An unsigned one is not offered to anyone who has a key.

## Installer

`Quartz-Setup.exe` (per-user NSIS, unsigned unless SignPath signing is on, below) is built by the `installer` workflow, never on a
desktop: Actions > installer > Run workflow, on `master` after the version bump. It builds the
installer, installs it on the runner, launches it, checks the native modules, the updater and the
default-browser registration, uninstalls it (`tools/installer/install-test.js`, summary line
`install-test: N passed, M failed`), and puts the installer on a **draft** release `v<version>`.
It never publishes, never creates a tag, and refuses to touch a published release.

To publish that draft, the tag still has to be signed first, or every clone with a key refuses it:

1. `node tools/release-tag.js --push` (step 3 above) on the same commit the draft was built from.
2. Open the draft, check it names that tag and has `Quartz-Setup.exe`, then **Publish release**.

The asset name never changes, so `releases/latest/download/Quartz-Setup.exe` always gets the newest
one, and installed copies offer "Download the installer" once it is the latest release.

### Code signing (SignPath), once the project is accepted

Signing is off until the repository variable `SIGNPATH_ORGANIZATION_ID` is set. With it (and the
secret `SIGNPATH_API_TOKEN`, the variables `SIGNPATH_PROJECT_SLUG` and `SIGNPATH_POLICY_SLUG`, and
optionally `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`), the same Run workflow also:

1. uploads the unsigned `Quartz-Setup.exe` and submits it to SignPath, then waits up to an hour;
2. an approver approves the request in SignPath (every release, by hand);
3. checks the signed file with `Get-AuthenticodeSignature` (Status `Valid`, or the job fails;
   summary line `quartz-installer: signed OK: ...`), and only then swaps it in and recomputes
   `Quartz-Setup.exe.sha256`;
4. runs the install test on the signed file and puts it on the draft, with the signed notes block
   of `tools/installer/draft-notes.md` (which links the code signing policy).

Nothing else hashes the installer: there is no `latest.yml` (electron-builder `publish: null`), and
installed copies only link to the release asset. Never change the file after it is signed. Signing
is separate from the signed release tags below: `release-tag.js` still signs the tag before the
draft is published. When the first signed release is out, update the SmartScreen sentence in the
README's Install section and the "Not live yet" line of its Code signing policy.

## Signed release tags

The updater installs a release only when its tag is signed by a key in `release-signers` as that file
is in the copy the user ALREADY has (read before anything is fetched; a release cannot vouch for
itself), and only when the signed tag names exactly the commit being installed. A copy with no key in
the file (every copy from before signing existed) installs the release that brings the file once, and
says in the card that the signature was not checked; after that it insists.

One-time setup on the machine that cuts releases: an ed25519 key with its private half outside the
repository, its public half in `release-signers`, and git told where it is (repository config only):

```
ssh-keygen -t ed25519 -N "" -C quartz-release-signing -f <path-to-key>
git config quartz.releaseSigningKey <path-to-key>
```

(`--key=<path>` or `QUARTZ_RELEASE_KEY` work too.) Checking needs git 2.34+ and OpenSSH 8.2+ on both
sides; Git for Windows and Windows 11's own OpenSSH qualify.

### Rotating the signing key

A new key only counts once a release signed by an OLD key has put it in `release-signers`:

1. Generate the new key. Add its public line to `release-signers` (keep the old line while both are
   in use, or replace it to retire the old key) and commit that with the next version bump.
2. Cut that release with the OLD key: `node tools/release-tag.js --push --key=<old key>`. It is
   verified against the previous release's file, which is what users have installed, so the new key
   cannot sign it yet; when the new file no longer holds the old key, the tool says the next release
   needs the new one.
3. From the following release on, sign with the new key (`git config quartz.releaseSigningKey <new key>`).

The updater only ever looks at the LATEST release and checks it against the copy's own file. A copy
still older than the rotation release when the first new-key release comes out sees a key it does
not trust and has to update by hand once (as for a lost key, below). To keep that group small, keep
BOTH keys in the file in the rotation release and go on signing with the old key for a few releases
(several weeks) before switching to the new one.

### If the signing key is lost

No release can be signed for the copies that only trust it, so they stop offering updates; the card
says the release is "signed by a key this copy of Quartz does not trust". Publish a release whose
`release-signers` holds a new key, signed with the new key, and tell users to update by hand once
(`git pull --ff-only origin <tag>` in the app folder, then `npm ci` if the release changed the
dependencies). From that release on, their copy trusts the new key.
