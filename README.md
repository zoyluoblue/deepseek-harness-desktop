# DeepSeek Harness Desktop

English | [中文](README.zh.md)

![Cover art for DeepSeek Harness Desktop: the white DeepSeek whale beside the words DEEPSEEK HARNESS above a large DESKTOP wordmark in a blue-to-violet gradient on a near-black field, with the line the open-source DeepSeek coding agent, as an app and the platforms macOS, Windows and Linux](assets/desktop-cover.png)

**DeepSeek Harness Desktop is a desktop app for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), the open-source coding agent from DeepSeek AI.** It is a signed, notarized installer for macOS, Windows, and Linux that carries the whole harness with it — the agent loop, its plugin runtime, and a Node 24 runtime — so running a DeepSeek coding agent takes no terminal, no `npm install`, and no Node on your machine. Download, open, point it at a folder, and start working.

![The DeepSeek Harness Desktop main window on macOS: a dark two-pane layout with a Workspaces sidebar listing the orbit-api project, and a centred composer that reads Into the Unknown with a workspace picker, a Standard mode agent preset, a Workspace Write permission selector, and a DeepSeek-V4-Pro model selector](assets/desktop-home.png)

## What it is

The harness itself already ships a browser UI you can start with `npx @deepseek-ai/dsh web`. This app is that same product as a real desktop application:

- **One installer per platform.** macOS Apple Silicon and Intel, Windows x64, Linux x64.
- **Nothing to install first.** The app bundles its own Node 24 runtime and the full plugin closure. You do not need Node, pnpm, or a checkout.
- **Signed and notarized on macOS.** Both architectures pass Gatekeeper with `Notarized Developer ID`, so there is no right-click → Open dance.
- **Auto-updating.** The app checks GitHub Releases on launch, downloads in the background, and installs on quit.
- **The same data as the CLI.** Sessions, workspaces, settings, and credentials live in `~/.dsh`, so the desktop app and `dsh web` see the same history.

## Download

Get the latest installer from the [Releases page](https://github.com/zoyluoblue/deepseek-harness-desktop/releases/latest).

| Platform | File | Notes |
| --- | --- | --- |
| macOS (Apple Silicon) | `DeepSeek-Harness-<version>-arm64.dmg` | Signed and notarized |
| macOS (Intel) | `DeepSeek-Harness-<version>.dmg` | Signed and notarized |
| Windows x64 | `DeepSeek-Harness-Setup-<version>.exe` | Unsigned; SmartScreen warns on first run — choose **More info → Run anyway** |
| Linux x64 | `DeepSeek-Harness-<version>.AppImage` | `chmod +x`, then run |
| Linux x64 (Debian/Ubuntu) | `dsh-desktop_<version>_amd64.deb` | `sudo dpkg -i …` |

## What working in it looks like

The agent reads your code, runs commands, edits files, and tracks its own to-do list, and every step is visible as it happens.

![A DeepSeek Harness Desktop session in progress: the agent has injected its system prompt and skill catalog, thought about the task, then run a Bash listing and read README.md, package.json, src/server.js, src/predict.js and src/catalog.js as individually expandable tool cards, with a live status bar showing turns, steps, LLM time, tokens per second and cache hit rate](assets/desktop-session.png)

When it finishes, it reports what it changed and how it verified the change.

![The completed session: a Changes I made summary listing a GET /health endpoint added to src/server.js, a refactor of src/predict.js into named exported functions, and a new test/predict.test.js, noting that npm test passes and curl against the health endpoint returned HTTP 200, with a Produced row linking the three files it wrote and a To-dos strip reading 4 completed](assets/desktop-result.png)

Every model request and tool call is recorded, and the **Trajectory** tab shows the raw sequence — the exact arguments sent and the exact output returned, alongside a per-step token and duration timeline.

![The Trajectory tab of a DeepSeek Harness Desktop session: a stacked bar timeline of input, model and tool time across steps, above an interleaved list of ASSISTANT and TOOL rows showing raw tool calls such as write, todo_write, bash npm install, bash npm test and job_kill with their truncated arguments and returned output](assets/desktop-trajectory.png)

Settings holds the pieces you set once: the default agent preset, the default permission mode, interface language, theme, and your model credentials.

![The DeepSeek Harness Desktop Settings dialog on the General tab: rows for Agent preset set to Standard mode, Permission set to Workspace Write, Language set to English, an Appearance selector offering Light, Dark and System, and an Enter behaviour while busy option, with General, Models, Plugins and Agent presets in the left rail](assets/desktop-settings.png)

## Requirements

- **macOS 14+** (Apple Silicon or Intel), **Windows 10/11 x64**, or a **glibc-based Linux x64** desktop.
- A **DeepSeek API key**, entered in Settings on first run. The app talks to DeepSeek's API; nothing else leaves your machine.
- About **700 MB** of disk. The installer is large because it carries a complete Node runtime and the harness's plugin tree rather than downloading them later.

## Frequently asked questions

**What is DeepSeek Harness Desktop?**
A desktop application that runs the open-source DeepSeek Harness coding agent locally. It gives the agent a graphical interface — sessions, workspaces, tool cards, permission modes — instead of a terminal.

**Do I need to install Node.js or the `dsh` CLI first?**
No. The app bundles Node 24 and the entire harness runtime. Installing it is the only step.

**How is this different from `npx @deepseek-ai/dsh web`?**
It runs the same product. The difference is packaging: a signed installer, a real application window, bundled runtimes, and automatic updates instead of a terminal command and a browser tab.

**Is it official?**
No. This is an independent desktop packaging of DeepSeek's open-source harness, maintained in this fork. The harness itself is by [DeepSeek AI](https://github.com/deepseek-ai/deepseek-harness).

**Where does my data go?**
Sessions, settings, and credentials stay in `~/.dsh` on your machine. The agent sends model requests to the DeepSeek API; the app adds no telemetry endpoint of its own and no account system.

**Can I use it alongside the CLI?**
Yes. Both read and write the same `~/.dsh`, so a session you start in the app is visible from `dsh web`, and the reverse.

**Does it run offline?**
The app launches offline, but the agent needs network access to reach the model API.

**Why does Windows warn me about the installer?**
It is not yet signed with an Authenticode certificate, so SmartScreen flags it as unrecognized. The macOS builds are signed and notarized.

**Which models can it use?**
Whatever the harness's DeepSeek provider exposes — currently DeepSeek-V4-Pro and DeepSeek-V4-Flash, each with a selectable reasoning effort.

**How do I control what the agent is allowed to touch?**
Each session carries a permission mode. **Workspace Write** confines edits to the selected workspace; stricter and looser modes are selectable per session and as a default in Settings.

## How it works

The desktop app is a thin shell around the harness rather than a reimplementation of it:

1. The Electron main process spawns `dsh web` as a child process, running on the **Node 24 runtime bundled inside the app** — the harness needs `node:sqlite` and zstd from Node ≥ 22.19, which Electron's embedded Node does not guarantee.
2. That child binds a loopback port chosen by the OS and prints its URL when the plugin tree has settled.
3. The window loads that URL. The UI you see is the harness's own web client, unmodified.

The harness's plugin loader resolves bare package names through a real `node_modules` layout, so the runtime closure ships as an ordinary file tree inside the app rather than inside an asar archive.

## Building from source

Requires Node `^22.19 || >=24`, pnpm 11, and a checkout of this repository.

```sh
pnpm install
pnpm run build
pnpm run package:desktop
```

The installer for your current platform lands in `desktop/out/`. Cross-building is deliberately not attempted: the runtime closure contains per-architecture native packages that the installer selects from the host, so each target builds on a machine of that architecture. See [desktop/README.md](desktop/README.md) for the packaging contract, signing secrets, and release process.

## Relationship to upstream

This repository is a fork of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). Everything outside `desktop/` is upstream's work, tracked as closely as practical; `desktop/` is the packaging layer added here. The harness is a developer preview and iterates quickly — **expect compatibility-breaking changes**.

For the harness itself — its architecture, plugin model, SDKs, and CLI — start with [upstream's documentation](https://github.com/deepseek-ai/deepseek-harness), [docs/architecture.md](docs/architecture.md), and [docs/development.md](docs/development.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
