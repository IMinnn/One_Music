# 和音独立后端

负责账号与会话、QQ / 网易云平台适配、歌单与收藏、歌词接口、音频传输和 SQLite 持久化。该目录具有独立的依赖、锁文件、测试、配置和 Dockerfile，不依赖客户端工程。

```powershell
cd harmony-backend
npm ci
npm start
```

默认监听 `http://127.0.0.1:47832`，健康检查为 `/api/health`。复制 `.env.example` 为 `.env` 可设置监听地址、持久化目录和生产环境参数。默认只提供 API，不提供网页页面。

```powershell
npm test
npm run dev
```

独立部署可在该目录执行 `docker build -t harmony-backend .`。生产环境需要 HTTPS 反向代理、匹配的 `PUBLIC_ORIGIN`、`COOKIE_SECURE=true` 和持久化数据卷。不要将开发数据或平台凭据提交到源码。

前后端分开部署时，由 Web 服务器提供客户端 `harmony/web/` 的静态资源，并将同一站点的 `/api/` 代理到本服务。网页和 Windows 远程账号模式都访问这个同源站点。只有 API 的默认后端根路径返回 404；也可显式设置 `WEB_DIR` 挂载已部署的前端资源。界面更新只需更新静态资源，无需改动业务服务源码。

源码位于 `src/`，测试位于 `tests/`，接口说明见 [docs/后端与数据说明.md](docs/后端与数据说明.md)。配置 `WEB_DIR` 可显式附带静态资源，但默认不依赖任何前端目录。

客户端位于相邻的 `harmony/`，通过 `file:../harmony-backend` 引用本包。网页预览与桌面本地模式复用本包并显式传入前端目录、原数据目录；业务源码只有这一份。客户端开发时先在本工程安装依赖，再到客户端执行 `npm ci`。

以后按需求分别修改：前端布局和交互在客户端，接口与业务数据在本工程。只有接口契约变化才同时修改两端；是否打包 Windows EXE 由用户另行指示。
