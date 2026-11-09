<p align="center">
  <img src="assets/one-music-logo.svg" alt="One Music 和音" width="240">
</p>

# One Music · 和音

和音是一款基于 Electron 的桌面音乐播放器，可播放本地音乐，并在同一个界面里管理自建歌单、收藏和 QQ 音乐、网易云音乐的歌单。

[快速开始](#快速开始) · [项目结构](#项目结构) · [测试与构建](#测试与构建)

## 主要功能

- **本地播放**：打开本地音频，管理播放队列，支持列表循环、随机播放和单曲循环。
- **平台接入**：扫码连接 QQ 音乐和网易云音乐，搜索歌曲、浏览平台歌单，并播放当前账号有权限的曲目。
- **歌单管理**：创建、收藏和排序歌单，支持通过 `.hy` 文件导入、导出自建歌单和喜欢列表。
- **歌词与外观**：支持同步歌词、歌词点击跳转、桌面歌词及浅色和深色外观。
- **使用模式**：Windows 桌面端支持本地模式和和音账号模式。macOS 打包版直接进入本地模式。浏览器预览使用独立的示例资料库。

平台歌单以只读方式同步。平台接口变化、网络状况和账号授权均会影响曲目可用性。公开云端账号同步服务尚未发布。

## 快速开始

需要 Git、Node.js **22.14 或更高版本**及 npm。请先安装后端依赖，再安装客户端依赖。

```bash
git clone https://github.com/IMinnn/One_Music.git
cd One_Music
cd harmony-backend
npm ci
cd ../harmony
npm ci
npm run preview
```

浏览器打开 <http://127.0.0.1:47831> 即可体验。预览资料保存在 `harmony/.preview-data/`。

在 `harmony/` 下运行 `npm run desktop` 可启动 Electron 开发窗口。如需独立运行后端，在 `harmony-backend/` 下执行 `npm start`，默认监听 `127.0.0.1:47832`，健康检查路径为 `/api/health`。

## 项目结构

| 路径 | 内容 |
| --- | --- |
| [harmony/](harmony/) | Electron 客户端、共用网页界面、预览与打包脚本 |
| [harmony-backend/](harmony-backend/) | 独立 Node.js 后端、SQLite 数据存储、平台适配与业务 API |
| [assets/](assets/) | One Music 品牌标识 |

## 测试与构建

在对应目录安装依赖后运行以下命令。桌面构建产物位于 `harmony/release/`。

| 操作 | 执行目录 | 命令 |
| --- | --- | --- |
| 客户端单元测试 | `harmony/` | `npm test` |
| 后端测试 | `harmony-backend/` | `npm test` |
| 浏览器界面测试（需本地 Chrome） | `harmony/` | `npm run test:ui` |
| Windows x64 便携版（在 Windows 构建） | `harmony/` | `npm run dist` |
| macOS 安装包（在 Mac 构建，支持 Apple 芯片和 Intel） | `harmony/` | `npm run dist:mac` |

当前桌面源码版本为 **0.5.0**，独立后端包版本为 **0.4.0**。源码仓库包含构建脚本，安装包在本地生成。

- [客户端开发说明](harmony/README.md)
- [后端运行与部署](harmony-backend/README.md)
- [后端接口与数据说明](harmony-backend/docs/后端与数据说明.md)
