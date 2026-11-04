# 贡献指南

提交 Issue 或 Pull Request 即表示你已阅读并同意[免责声明](DISCLAIMER.md)，且贡献内容按 [MIT License](LICENSE) 授权。

## 开发环境

桌面端：

- Windows 10/11 x64
- Node.js 22 或更高版本
- npm 10 或更高版本
- Microsoft Edge 或 Google Chrome

Android 端：

- JDK 17
- Android SDK 35、NDK 25.2.9519653
- 本地 FFmpegKit AAR，需要先运行 `android/scripts/build-ffmpeg.sh` 生成（依赖项见 [android.yml](.github/workflows/android.yml)）

## 本地开发

```powershell
npm ci
npm run dev
```

## 质量检查

```powershell
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run dist
```

Android 端：

```bash
cd android
./gradlew lint test assembleDebug
```

提交应保持单一主题，并同步更新相关测试和文档。下载行为变更应覆盖登录失效、重复任务、取消任务和部分文件清理等边界。

## Pull Request

Pull Request 应包含变更目的、用户影响、验证命令和界面截图。平台接口变化导致的修复应说明观察到的响应差异，且不得提交 Cookie、媒体文件或个人数据。
