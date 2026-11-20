# Releasing Tuya Home to the Cindy marketplace

Checklist for a public-market submission (third-party plugin, submitted from the
client). Official plugins are a different route: they go through
`github.com/makecindy/cindy-official-plugins` and need exactly four locales
(`zh-CN`/`en`/`ja`/`ko`), an `assets/icon.png`, and the repo CI.

## The one rule that costs the most

**A version number is consumed forever the moment a submission is accepted.**
A rejection, a cancellation or a later unpublish does not free it. Never submit
a package you know is incomplete just to see what happens — bump first, then
submit.

## Before you start

- [ ] `cd plugin && node tests/smoke.mjs` — all checks green
- [ ] `cd plugin && python tests/check_manifest.py` — `FAILURES: 0`
- [ ] `version` in `ghost.json` is one that has **never** been submitted
- [ ] `icon` is set (see below) — cosmetic, but it is the first thing a user sees
- [ ] no `.cindy` artefacts committed inside `plugin/` (they belong in `dist/`; the
      packer writes `plugin/tuya-home-<version>.cindy`, which `*.cindy` already ignores)
- [ ] `cd plugin && python tests/check_manifest.py` still reports `FAILURES: 0`
      after the version bump — it also compares the docs with the shipped capabilities
- [ ] no credentials anywhere in the package (`tools/.env` lives outside `plugin/`)
- [ ] the advanced gate is still closed by default

## Icon

The host converts the image to 1024x1024 PNG. Either drop a file at
`plugin/assets/icon.png` and set `"icon": "assets/icon.png"` in `ghost.json`, or
generate one through the agent's image capability (needs the user's consent, one
attempt only — do not retry, and never commit a placeholder colour block).

## Steps

1. `ghost_forge_install({ dir: "...\plugin", namespace: "local" })` — install the
   exact version you are about to submit. The submission snapshots the
   *installed* plugin, not the source folder.
2. `ghost_contribution_prepare({ ghost_id: "tuya-home", namespace: "local" })` —
   read-only preflight: freezes the installed package, returns `preparedId`,
   version, sha256, size and any `blockers`. Nothing is uploaded and no version
   is consumed here. `canSubmit: true` means the host is willing.
3. Read the summary. If a blocker mentions `RELEASE_NOTES_REQUIRED`, the plugin
   has been listed before and `ghost.json` needs a top-level plain-text
   `releaseNotes` describing everything that changed since the listed version.
   First listing does not need it.
4. `ghost_contribution_submit({ prepared_id })` — the actual submission.
   `202 / processing` means "still processing", **not** "accepted for review".
5. `ghost_contribution_status({ local_id })` until the action ends.
6. `ghost_my_plugins` — the only place that shows the real review outcome.

## If it goes wrong

- `PLUGIN_GHOST_ID_CONFLICT` — the `ghost.json.id`, not the display name, is
  taken. Do not rename to dodge it without asking: fix ID only for a genuinely
  new plugin, keep it for an update of your own.
- A rejected version cannot be reused. Fix, bump, reinstall, prepare, submit.
- Only one version per plugin may be under review at a time.

## Do not

- edit the host-managed install directory (`.../cindy-brain/_ns/local/tuya-home`)
- put private keys or the API key in the package, the repo, or a commit
- publish the project-credential signing work as if it were finished — the
  advanced tools are gated for a reason (see `docs/VERIFIED.md`)
