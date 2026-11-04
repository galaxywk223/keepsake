# Keepsake

[简体中文](README.md) | **English**

[![CI](https://github.com/galaxywk223/keepsake/actions/workflows/ci.yml/badge.svg)](https://github.com/galaxywk223/keepsake/actions/workflows/ci.yml)
[![Android](https://github.com/galaxywk223/keepsake/actions/workflows/android.yml/badge.svg)](https://github.com/galaxywk223/keepsake/actions/workflows/android.yml)
[![Release](https://img.shields.io/github/v/release/galaxywk223/keepsake)](https://github.com/galaxywk223/keepsake/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Android-blue)](#installation)
[![License](https://img.shields.io/github/license/galaxywk223/keepsake)](LICENSE)

Keepsake is a local-first downloader and media library for Douyin, Xiaohongshu (RED), Bilibili, and TikTok, available for Windows and Android. Paste a share link to batch-download videos, image posts, and live photos, extract audio, and browse and organize everything in a local library. Your data stays on your own device.

> [!WARNING]
> This project is for personal learning and research only. **Commercial use and any unlawful use are prohibited.** Only download content you have the right to keep, and follow applicable laws and platform terms. By using this project you agree to the [Disclaimer](DISCLAIMER.md#english).

![Download screen](docs/screenshots/download.png)

> The app interface is currently available in Simplified Chinese only.

## Features

### Windows desktop

- Batch-extract posts from **Douyin**, **Xiaohongshu**, **Bilibili**, and **TikTok** via share text, short links, or post URLs.
- Xiaohongshu live photos are saved as both the still image and its short video, grouped under one item in the library.
- Bilibili videos have their separate video and audio streams merged automatically, preferring H.264 for compatibility. For multi-part videos, the part in the link's `?p=` is downloaded. Without login the cap is 480P; signed in, you get the highest quality your account can watch.
- TikTok videos and photo posts are supported, preferring the watermark-free H.264 version.
- Download images and videos with live progress.
- Extract MP3 audio (192 kbps) from downloaded videos. FFmpeg is bundled with the installer.
- Automatically index the local download folder and group multi-image posts together.
- Search, filter by media type, sort, and switch between grid and list views.
- Preview, rename, open, reveal in Explorer, or move files to the Recycle Bin.
- Keep the login session in a dedicated Edge/Chrome profile that does not touch your everyday browser.
- Check GitHub Releases for updates, download them in the background, and restart to install.

### Android

- Sign in to Douyin inside the app, then paste a share link to parse and download posts (only Douyin is supported on Android for now).
- Download task list, local media library, and media viewer.
- Extract MP3 audio locally with FFmpegKit. Nothing is uploaded.
- Export media to the system gallery or media store.
- Data lives in app-private storage and is removed when you uninstall.

## Installation

### Windows

Download the latest `Keepsake-Setup-<version>.exe` from [GitHub Releases](https://github.com/galaxywk223/keepsake/releases/latest). Windows 10/11 x64 is supported.

- The installer is not code-signed, so Windows SmartScreen may show an "unknown publisher" warning. Click "More info → Run anyway".
- The app installs for the current user only. Uninstalling keeps your app data and downloaded media.
- In-app updates are supported from v1.1.0. Users on v1.0.0 need to install a newer version manually once.

### Android

No official Android build has been published yet. APKs are planned as `android-v*` pre-releases on the [Releases](https://github.com/galaxywk223/keepsake/releases) page. Until then you can build it yourself; see [Development](#development). Requires Android 8.0 (API 26) or later.

See [CHANGELOG.md](CHANGELOG.md) (in Chinese) for version history.

## Usage

1. In Settings, check that Edge or Chrome is available on your system.
2. Click "Configure login" (配置登录) and sign in to the platforms you use in their tabs of the dedicated browser window (public Bilibili and TikTok posts work without signing in).
3. On the Download page, paste share text or a post link and parse it. For Xiaohongshu, use the link from "Share → Copy link" in the app, which carries the required access parameters.
4. Select the posts you want and create a download task.
5. Preview, filter, and manage your files in the Library.

![Settings screen](docs/screenshots/settings.png)

## Data locations (Windows)

| Path | Contents |
| --- | --- |
| `%LOCALAPPDATA%\OriginalMediaLibrary\library.db` | SQLite database |
| `%LOCALAPPDATA%\OriginalMediaLibrary\thumbnails` | Thumbnail cache |
| `%LOCALAPPDATA%\OriginalMediaLibrary\browser-profile` | Dedicated browser login profile |
| `%USERPROFILE%\Downloads\Keepsake` | Default download folder for new installs |

Existing installs keep the download folder stored in the database. You can change it in Settings.

## Roadmap

- [x] Xiaohongshu (RED) support (desktop)
- [x] Bilibili support (desktop)
- [x] TikTok support (desktop)
- [ ] More platforms on Android
- [ ] More sites such as Kuaishou
- [ ] macOS and Linux builds
- [ ] Official Android release

Ideas are welcome in [Issues](https://github.com/galaxywk223/keepsake/issues/new/choose), and so are pull requests.

## Development

Desktop:

```powershell
npm ci
npm run dev
```

Production build and installer:

```powershell
npm run build
npm run dist
```

Quality checks:

```powershell
npm run lint
npm run typecheck
npm test
npm run test:e2e
```

Android needs JDK 17 and Android SDK 35. Before building, generate the local FFmpegKit AAR with `android/scripts/build-ffmpeg.sh` (see [android.yml](.github/workflows/android.yml)):

```bash
cd android
./gradlew assembleDebug
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Architecture

- **Desktop**: The Electron main process owns the window lifecycle, SQLite, the file system, the download queue, and browser automation. A context bridge exposes a restricted desktop API, and IPC input is validated with Zod. The renderer uses React, TypeScript, TanStack Query, and Radix UI. A custom `oml-media://` protocol serves previews by media ID, restricted to the download folder. electron-vite handles the three-layer build, and electron-builder produces the NSIS x64 installer.
- **Site extractors**: Site-specific parsing lives in `src/main/platforms/`. Each site implements a `SiteExtractor`, so adding a site means adding one module.
- **Android**: Kotlin and Jetpack Compose, with Room for storage, WebView for login, and FFmpegKit for audio conversion.

See the [architecture notes](docs/ARCHITECTURE.md) (in Chinese) for boundaries and data flow.

## Known limitations

- The desktop app supports Windows 10/11 x64 only. There are no macOS or Linux builds yet.
- The installer is not code-signed. There is no tray mode, and no telemetry.
- Downloads depend on each platform's web APIs and login state, so platform changes may break them. Xiaohongshu applies stricter anti-bot checks and may ask you to complete a verification in the login browser. TikTok requires a network that can reach tiktok.com. Bilibili anime (bangumi) and premium-only content are not supported.

## Disclaimer

This project is not affiliated with Douyin, ByteDance, TikTok, Xiaohongshu, Bilibili, Microsoft, or Google. See [DISCLAIMER.md](DISCLAIMER.md#english) for the full terms.

## License

The source code is released under the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party licenses, [PRIVACY.md](PRIVACY.md) (Windows) and [PRIVACY-ANDROID.md](PRIVACY-ANDROID.md) (Android) for privacy details, and [SECURITY.md](SECURITY.md) for reporting security issues.

If you find this project useful, a ⭐ star is appreciated.
