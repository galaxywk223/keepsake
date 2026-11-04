# 隐私说明

Keepsake 采用本地优先的数据模型。应用不收集、上传或分析使用数据。

## 本地存储

| 数据 | 默认位置 | 用途 |
| --- | --- | --- |
| SQLite 数据库 | `%LOCALAPPDATA%\OriginalMediaLibrary\library.db` | 任务、设置与媒体索引 |
| 缩略图 | `%LOCALAPPDATA%\OriginalMediaLibrary\thumbnails` | 媒体库预览 |
| 浏览器配置 | `%LOCALAPPDATA%\OriginalMediaLibrary\browser-profile` | 抖音、小红书登录状态 |
| 媒体文件 | `%USERPROFILE%\Downloads\Keepsake` | 新安装的默认下载内容目录 |

浏览器配置可能包含由抖音、小红书和浏览器写入的 Cookie 与站点数据。应用仅在本机使用该独立配置完成用户发起的登录和下载流程。

## 网络请求

网络请求在检查 GitHub Release、解析分享链接、打开抖音或小红书登录页面和下载所选媒体时发生。更新检查从公开 GitHub Release 读取版本清单，不上传使用数据；下载目标由版本清单、分享链接重定向和对应平台页面返回的媒体地址决定。

## 删除

卸载程序保留应用数据。完整删除需要移除 `%LOCALAPPDATA%\OriginalMediaLibrary` 与已配置的下载目录。
