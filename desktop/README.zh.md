# dsh-desktop

[English](README.md) | 中文

DeepSeek Harness Web GUI 的 Electron 桌面壳。这层壳刻意做得很薄：Electron 主进程把 harness 的 web 面（`dsh web --port 0`）作为子进程拉起，跑在内置的 Node 24 运行时上，等待 `dsh web: <url>` 就绪行，然后在 `BrowserWindow` 里展示那个回环 URL。其余一切——`/api` 协议、React 前端、会话、设置、凭据——都是未经修改的 web 产品。会话与设置存放在共享的 `~/.dsh`（`$DSH_HOME`），所以桌面应用与命令行安装看到的是同一份状态。

本目录是一个独立的 pnpm workspace（见此处的 `pnpm-workspace.yaml`）：Electron 约 100MB 的二进制下载不应拖累根目录的 `pnpm install` 或 CI。应用打包的 harness 运行时闭包归根 workspace 成员 `runtime/` 所有（一个只声明依赖、指向 `@deepseek-ai/dsh` 的 deploy root），由 `scripts/prepare-runtime.ts` 用 `pnpm deploy` 物化，并以真实、无符号链接的文件树形式放进应用资源目录——Cordis Loader 与 app-boot 的 profile 符号链接农场需要真实的 `node_modules` 布局，因此运行时永远不会进入 asar。

## 命令

```sh
pnpm run package:desktop   # from the repo root: one-click installer for the host platform
```

在本目录下执行（需先在此处 `pnpm install`）：

```sh
pnpm run dev        # Electron over the repo source launch (needs a built apps/web dist)
pnpm run smoke      # dev-mode self check: boot harness, load UI, screenshot, exit
pnpm run package    # build repo + prepare runtime + electron-builder for the host platform
```

`package` 的参数（追加在 `--` 之后）：`--skip-build` 复用已有的仓库 `lib/`+`dist` 产物，`--skip-runtime` 复用 `runtime-staging/` 与 `vendor-node/`，`--publish <mode>` 透传给 electron-builder（默认 `never`）。

打包后的应用同样支持 `--smoke`（CI 与人工验证使用）：启动内置 harness、加载 UI、把截图写入临时目录、打印 `SMOKE OK` 后退出。

## 构建目标

每个目标都在同架构的宿主机上打包——运行时闭包中含有按目标区分的可选包（sharp 及其 libvips、koffi、ripgrep、node-addon-require-builtin），pnpm 只会为当前宿主安装对应版本，而 `prepare-runtime` 会拒绝平台包指向其他目标的 staging 树。`.github/workflows/desktop-release.yml` 运行四目标矩阵：macOS arm64（dmg+zip）、macOS x64（dmg+zip）、Windows x64（NSIS）、Linux x64（AppImage+deb）。

两个 macOS 目标共用同一份 `latest-mac.yml`，因为 electron-updater 在 macOS 上没有按架构区分的 feed，而是通过检测产物 URL 中是否含 `arm64` 来选包。每条腿只产出覆盖自身架构的 feed，因此矩阵结束后由 `merge-mac-feed` 作业将两者合并。macOS x64 在 `macos-15-intel` 上构建，这是 GitHub 提供的最后一个 x86_64 镜像（可用至 2027 年秋）；此后 Intel 构建需要自托管硬件或交叉 staging。

## 发布与自动更新

推送 `desktop-v*` tag（推送前先把本 package.json 的 `version` 同步改好），即可构建全部四个目标，并把安装包与 electron-updater feed 发布到本仓库的一个 GitHub Release。应用会在启动时检查该 feed，并在退出时安装更新。非 tag 的工作流运行只上传未签名产物，不做发布。

签名通过 CI secrets 激活，缺失时自动跳过（产物保持未签名，macOS 用户需右键→打开以绕过 Gatekeeper）：

| Secret | 用途 |
| --- | --- |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | macOS Developer ID Application 证书（.p12，base64 或文件 URL）及其密码 |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | notarytool 凭据；三者齐备即开启公证 |
| `APPLE_API_KEY_B64` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` | App Store Connect API key（base64 `.p8`），作为 Apple ID 方案的替代 |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows Authenticode 证书及其密码 |

macOS 的自动更新只对已签名的构建生效（electron-updater 的要求）；未签名构建会记录失败并继续运行。

当 CI 能签名但无法公证时——这是常态，因为 `notarytool` 的钥匙串 profile 只存在于开发者本机——之后在持有凭据的机器上补完 macOS 产物：

```sh
APPLE_KEYCHAIN_PROFILE=<profile> pnpm run notarize:mac <dir-of-downloaded-artifacts>
```

它会对每个更新 zip 里的 app 做公证与装订（并重新打包，因为更新器是直接替换 app 包的），对每个 dmg 做签名与公证，并改写因重新打包而失效的 feed 哈希。用 `gh release upload --clobber` 上传结果，并删除已失效的 mac zip blockmap。公证与架构无关，所以 Apple Silicon 机器可以补完 Intel 产物。

## 已知限制

- `dsh plugin`（树外插件安装）需要 PATH 上有 pnpm；打包后的应用不内置 pnpm，因此 profile 插件管理属于命令行安装才有的能力。
- 内置运行时服务的是 `web` profile；其他 profile 仍属命令行范畴。
- Linux 沙箱只在宿主提供时才使用 landlock-run/bwrap 链路，与 npm 分发方式一致。
