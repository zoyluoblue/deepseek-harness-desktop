# dsh-desktop

Electron desktop shell for the DeepSeek Harness Web GUI. The shell is thin by design: the Electron main process launches the harness web surface (`dsh web --port 0`) as a child process on a bundled Node 24 runtime, waits for the `dsh web: <url>` readiness line, and shows that loopback URL in a `BrowserWindow`. Everything else — the `/api` protocol, the React frontend, sessions, settings, credentials — is the unmodified web product. Sessions and settings live in the shared `~/.dsh` (`$DSH_HOME`), so the app and a CLI install see the same state.

This directory is its own isolated pnpm workspace (see `pnpm-workspace.yaml` here): Electron's ~100MB binary download must not tax root `pnpm install` runs or CI. The harness runtime closure the app bundles is owned by the root-workspace member `runtime/` (a dependency-only deploy root on `@deepseek-ai/dsh`), materialized with `pnpm deploy` by `scripts/prepare-runtime.ts` and shipped as a real, symlink-free file tree under the app's resources — the Cordis Loader and app-boot's profile symlink farm require an actual `node_modules` layout, so the runtime never enters the asar.

## Commands

```sh
pnpm run package:desktop   # from the repo root: one-click installer for the host platform
```

From this directory (requires `pnpm install` here first):

```sh
pnpm run dev        # Electron over the repo source launch (needs a built apps/web dist)
pnpm run smoke      # dev-mode self check: boot harness, load UI, screenshot, exit
pnpm run package    # build repo + prepare runtime + electron-builder for the host platform
```

`package` flags (append after `--`): `--skip-build` reuses existing repo `lib/`+`dist` artifacts, `--skip-runtime` reuses `runtime-staging/` and `vendor-node/`, `--publish <mode>` forwards to electron-builder (default `never`).

A packaged app also supports `--smoke` (used by CI and manual verification): it boots the bundled harness, loads the UI, writes a screenshot to the temp dir, prints `SMOKE OK`, and exits.

## Targets

Each target packages on a host of that same architecture — the runtime closure contains per-target optional packages (sharp and its libvips, koffi, ripgrep, node-addon-require-builtin) that pnpm installs for the current host only, and `prepare-runtime` refuses a staging tree whose platform packages name a different target. `.github/workflows/desktop-release.yml` runs the four-target matrix: macOS arm64 (dmg+zip), macOS x64 (dmg+zip), Windows x64 (NSIS), Linux x64 (AppImage+deb).

The two macOS targets share one `latest-mac.yml`, because electron-updater has no arch-suffixed feed on macOS and selects a build by testing the artifact URL for `arm64`. Each leg emits a feed covering only its own arch, so the `merge-mac-feed` job unions them after the matrix completes. macOS x64 builds on `macos-15-intel`, the last x86_64 image GitHub offers (available through Fall 2027); after that an Intel build needs self-hosted hardware or cross-staging.

## Releases and auto-update

Push a `desktop-v*` tag (after bumping `version` in this package.json to match) to build all four targets and publish installers plus the electron-updater feed to a GitHub Release of this repository. The app checks that feed at startup and installs updates on quit. Non-tag workflow runs upload unsigned artifacts instead of publishing.

Signing activates through CI secrets and is skipped when they are absent (builds stay unsigned and macOS users must right-click → Open past Gatekeeper):

| Secret | Purpose |
| --- | --- |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | macOS Developer ID Application certificate (.p12, base64 or file URL) and its password |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | notarytool credentials; all three present ⇒ notarization on |
| `APPLE_API_KEY_B64` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` | App Store Connect API key (base64 `.p8`) as an alternative to the Apple ID pair |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows Authenticode certificate and password |

macOS auto-update only works on signed builds (electron-updater requirement); unsigned builds log the failure and continue.

## Known limitations

- `dsh plugin` (out-of-tree plugin install) expects pnpm on PATH; the packaged app does not bundle pnpm, so profile plugin management is a CLI-install feature.
- The bundled runtime serves the `web` profile; other profiles remain CLI territory.
- Linux sandboxing uses the landlock-run/bwrap chain only where the host provides it, unchanged from the npm distribution.
