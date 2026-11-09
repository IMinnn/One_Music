import { createApp } from './app.js';

const app = createApp({ webDir: process.env.WEB_DIR || undefined });
const url = await app.listen(Number(process.env.PORT || 47832), process.env.HOST || '127.0.0.1');
console.log(`和音服务已启动：${url}`);
console.log(`数据目录：${app.dataDir}`);
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, async () => { await app.close(); process.exit(0); });
