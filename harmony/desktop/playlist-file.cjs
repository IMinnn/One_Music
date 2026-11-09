const { writeFile } = require('node:fs/promises');

module.exports = ({ ipcMain, dialog, trusted, getWindow }) => {
  ipcMain.handle('playlists:save-file', async (event, input) => {
    if (!trusted(event)) throw new Error('访问被拒绝');
    if (typeof input?.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > 20 * 1024 * 1024) throw new Error('歌单文件不能超过 20 MB');
    JSON.parse(input.content);
    const filename = typeof input.filename === 'string' && /^和音歌单-\d{4}-\d{2}-\d{2}\.hy$/.test(input.filename) ? input.filename : '和音歌单.hy';
    const result = await dialog.showSaveDialog(getWindow(), {
      title: '导出和音歌单', defaultPath: filename,
      filters: [{ name: '和音歌单', extensions: ['hy'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return false;
    if (!/\.hy$/i.test(result.filePath)) throw new Error('请使用 .hy 文件后缀保存歌单');
    await writeFile(result.filePath, input.content, 'utf8');
    return true;
  });
};
