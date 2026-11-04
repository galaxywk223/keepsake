# Keepsake

**简体中文** | [English](README.en.md)

[![CI](https://github.com/galaxywk223/keepsake/actions/workflows/ci.yml/badge.svg)](https://github.com/galaxywk223/keepsake/actions/workflows/ci.yml)
[![Android](https://github.com/galaxywk223/keepsake/actions/workflows/android.yml/badge.svg)](https://github.com/galaxywk223/keepsake/actions/workflows/android.yml)
[![Release](https://img.shields.io/github/v/release/galaxywk223/keepsake)](https://github.com/galaxywk223/keepsake/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Android-blue)](#安装)
[![License](https://img.shields.io/github/license/galaxywk223/keepsake)](LICENSE)

Keepsake 是一款本地优先的抖音、小红书、B 站、TikTok 素材下载与管理工具，提供 Windows 桌面端和 Android 端。粘贴分享链接即可批量下载视频、图集和实况图，还能提取音频，并在本地媒体库中统一预览和整理。所有数据只保存在你自己的设备上。

> [!WARNING]
> 本项目仅供个人学习和研究使用，**禁止用于商业用途或任何违法用途**。请只下载你有权保存的内容，并遵守相关法律法规和平台用户协议。使用本项目即表示你同意[免责声明](DISCLAIMER.md)。

![下载界面](docs/screenshots/download.png)

## 功能

### Windows 桌面端

- 从分享文案、短链接或作品链接中批量提取**抖音**、**小红书**、**B 站**、**TikTok** 的作品。
- 小红书实况图会同时保存静态图和对应的短视频，在媒体库中归为同一作品。
- B 站视频自动合并音视频流，优先选择兼容性最好的 H.264 编码；多 P 视频按链接中的 `?p=` 下载对应分 P。未登录时最高 480P，登录后可下载账号可观看的最高画质。
- TikTok 支持视频和图文作品，优先下载无水印的 H.264 版本。
- 下载图片或视频资源，并实时显示进度。
- 从已下载的视频提取 MP3 音频（192 kbps），安装包已内置 FFmpeg。
- 自动索引本地下载目录，多图作品按作品归组。
- 媒体库支持搜索、按类型筛选、排序，以及网格和列表两种视图。
- 支持媒体预览、重命名、打开文件、在资源管理器中定位和移入回收站。
- 用独立的 Edge/Chrome 配置保存登录状态，不影响你日常使用的浏览器。
- 自动检查 GitHub Release，可在后台下载更新并重启安装。

### Android 端

- 应用内登录抖音，粘贴分享链接即可解析和下载作品（Android 端暂只支持抖音）。
- 提供下载任务列表、本地媒体库和媒体查看器。
- 使用本地 FFmpegKit 提取 MP3 音频，不上传任何文件。
- 支持把媒体导出到系统相册或媒体库。
- 数据保存在应用私有目录，卸载即清除。

## 安装

### Windows

从 [GitHub Releases](https://github.com/galaxywk223/keepsake/releases/latest) 下载最新安装包 `Keepsake-Setup-<版本号>.exe`，支持 Windows 10/11 x64。

- 安装包没有商业代码签名，Windows SmartScreen 可能提示“未知发布者”，点击“更多信息 → 仍要运行”即可。
- 安装范围为当前用户。卸载时会保留应用数据和已下载的媒体。
- v1.1.0 起支持应用内更新；v1.0.0 用户需要手动安装一次新版本。

### Android

Android 端目前还没有发布正式安装包，计划通过 `android-v*` 预发布版本提供 APK，届时会出现在 [Releases](https://github.com/galaxywk223/keepsake/releases) 页面。现在可以按下方[开发](#开发)一节自行构建。系统要求 Android 8.0（API 26）或更高版本。

各版本的变更见 [CHANGELOG.md](CHANGELOG.md)。

## 使用流程

1. 在设置页确认系统里有可用的 Edge 或 Chrome。
2. 点击“配置登录”，在弹出的独立浏览器窗口中，在各平台的标签页登录需要使用的平台（B 站、TikTok 不登录也可以下载公开作品）。
3. 在下载页粘贴分享文案或作品链接，然后点击解析。小红书请使用 App 中“分享 → 复制链接”得到的链接，其中包含访问所需的参数。
4. 选择要下载的作品，创建下载任务。
5. 在媒体库中预览、筛选和管理本地文件。

![设置界面](docs/screenshots/settings.png)

## 数据目录（Windows）

| 路径 | 内容 |
| --- | --- |
| `%LOCALAPPDATA%\OriginalMediaLibrary\library.db` | SQLite 数据库 |
| `%LOCALAPPDATA%\OriginalMediaLibrary\thumbnails` | 缩略图缓存 |
| `%LOCALAPPDATA%\OriginalMediaLibrary\browser-profile` | 独立浏览器登录环境 |
| `%USERPROFILE%\Downloads\Keepsake` | 新安装的默认下载目录 |

已有安装会继续使用数据库中保存的下载目录，新安装默认使用 `Keepsake` 目录。下载目录可以在设置页修改。

## 路线图

- [x] 小红书支持（桌面端）
- [x] B 站支持（桌面端）
- [x] TikTok 支持（桌面端）
- [ ] Android 端支持更多平台
- [ ] 快手等更多站点
- [ ] macOS 与 Linux 构建
- [ ] Android 正式安装包

欢迎通过 [Issue](https://github.com/galaxywk223/keepsake/issues/new/choose) 提出建议，也欢迎直接提交 Pull Request。

## 开发

桌面端：

```powershell
npm ci
npm run dev
```

生产构建与安装包：

```powershell
npm run build
npm run dist
```

质量检查：

```powershell
npm run lint
npm run typecheck
npm test
npm run test:e2e
```

Android 端需要 JDK 17 和 Android SDK 35，构建前要先用 `android/scripts/build-ffmpeg.sh` 生成本地 FFmpegKit AAR（参考 [android.yml](.github/workflows/android.yml)）：

```bash
cd android
./gradlew assembleDebug
```

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 技术架构

- **桌面端**：Electron 主进程负责窗口生命周期、SQLite、文件系统、下载队列和浏览器自动化；Context Bridge 暴露受限的桌面 API，IPC 输入用 Zod 校验；渲染层使用 React、TypeScript、TanStack Query 和 Radix UI；自定义 `oml-media://` 协议按媒体 ID 提供预览流，并限制在下载目录范围内；electron-vite 负责三层构建，electron-builder 生成 NSIS x64 安装包。
- **站点扩展**：站点解析按平台拆分在 `src/main/platforms/`，每个站点实现一个 `SiteExtractor`，新增站点只需加一个模块。
- **Android 端**：Kotlin + Jetpack Compose，使用 Room 保存数据，WebView 负责登录，FFmpegKit 负责音频转换。

详细的边界和数据流见[架构说明](docs/ARCHITECTURE.md)。

## 已知限制

- 桌面端目前只支持 Windows 10/11 x64，暂无 macOS 和 Linux 构建。
- 安装包没有代码签名；暂不支持托盘模式；不包含任何遥测。
- 下载功能依赖各平台的页面接口和登录状态，平台调整可能导致功能失效。小红书风控较严，可能需要在登录浏览器中完成验证。TikTok 需要当前网络能访问 tiktok.com。B 站番剧、大会员专享内容不在支持范围内。

## 免责声明

本项目与抖音、字节跳动、TikTok、小红书、哔哩哔哩、Microsoft、Google 均无关联。完整条款见 [DISCLAIMER.md](DISCLAIMER.md)。

## 开源信息

源代码以 [MIT License](LICENSE) 开源。第三方软件许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，隐私说明见 [PRIVACY.md](PRIVACY.md)（Windows）和 [PRIVACY-ANDROID.md](PRIVACY-ANDROID.md)（Android），安全问题报告流程见 [SECURITY.md](SECURITY.md)。

如果这个项目对你有帮助，欢迎点一个 ⭐ Star。
