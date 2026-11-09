const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
module.exports = ({ app, ipcMain, dialog, trusted, getWindow }) => {
  const indexPath = () => path.join(app.getPath('userData'), 'local-music.json');
  const load = async () => { try { return JSON.parse(await fs.readFile(indexPath(), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
  const supported = name => /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(name);
  let pending = Promise.resolve();
  ipcMain.handle('local-files:list', async event => { if (!trusted(event)) throw new Error('访问被拒绝'); await pending; return load(); });
  ipcMain.handle('local-files:pick', async (event, kind) => {
    if (!trusted(event)) throw new Error('访问被拒绝');
    const result = await dialog.showOpenDialog(getWindow(), { title: kind === 'folder' ? '导入本地音乐文件夹' : '导入本地音乐文件', properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'], filters: [{ name: '音频文件', extensions: ['mp3','wav','flac','ogg','m4a','aac'] }] });
    if (result.canceled) return null;
    const paths = [];
    async function walk(folder) {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        const target = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(target);
        else if (entry.isFile() && supported(entry.name)) paths.push(target);
      }
    }
    if (kind === 'folder') { for (const folder of result.filePaths) await walk(folder); }
    else paths.push(...result.filePaths.filter(supported));
    const operation = pending.then(async () => {
      const records = await load(), known = new Set(records.map(r => r.id));
      for (const filePath of paths) {
        const id = 'file-' + createHash('sha256').update(path.resolve(filePath).toLowerCase()).digest('hex');
        if (!known.has(id)) { records.push({ id, name: path.basename(filePath), path: filePath }); known.add(id); }
      }
      // Persist paths only; never copy audio into the app library.
      await fs.writeFile(indexPath(), JSON.stringify(records, null, 2)); return records;
    });
    pending = operation.catch(() => {}); return operation;
  });
  ipcMain.handle('local-files:read', async (event, id) => {
    if (!trusted(event)) throw new Error('访问被拒绝');
    await pending; const record = (await load()).find(r => r.id === id);
    if (!record) throw new Error('未找到本地音乐记录');
    try { return await fs.readFile(record.path); } catch { throw new Error('原文件已移动、删除或无法读取，请重新选择文件'); }
  });
};
