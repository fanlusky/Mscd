const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
    const data = { settings: { concurrency: 2 }, downloads: [], downloadTasks: [] };
    const files = new Map();
    const directories = new Map();
    const failWrites = new Set();
    const store = {
        get: () => data,
        update: (patch) => Object.assign(data, patch),
        persist() {},
        upsertDownloadTask(id, patch) {
            let task = data.downloadTasks.find((t) => t.id === id);
            if (!task) data.downloadTasks.push(task = { id });
            Object.assign(task, patch);
        },
        updateTaskTrack(id, trackId, patch) {
            Object.assign(data.downloadTasks.find((t) => t.id === id).tracks.find((t) => t.id === trackId), patch);
        },
    };
    function directory(name) {
        return {
            name,
            queryPermission: async () => 'granted',
            async getDirectoryHandle(child) {
                const key = name + '/' + child;
                if (!directories.has(key)) directories.set(key, directory(key));
                return directories.get(key);
            },
            async getFileHandle(filename, options = {}) {
                const key = name + '/' + filename;
                if (!options.create && !files.has(key)) throw Object.assign(new Error(), { name: 'NotFoundError' });
                return { async createWritable() {
                    let content;
                    return {
                        async write(value) { content = value; },
                        async close() {
                            if (failWrites.has(filename)) throw new Error('disk write failed');
                            files.set(key, content);
                        },
                    };
                } };
            },
        };
    }
    const parent = directory('Downloads');
    const context = vm.createContext({ store, config: { download: { retry: 0, retryDelay: 0, concurrency: 2 } }, Blob, AbortController, setTimeout, console, window: { showDirectoryPicker() {} }, parent });
    const source = fs.readFileSync(require.resolve('../src/downloader.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
    vm.runInContext(source + `
        getSavedDirHandle = async () => parent;
        downloadWithThreads = async () => new Blob(['song']);
        applyDetectedExt = async () => {};
        globalThis.downloader = new Downloader({});
        downloader.expandDownloadEntries = (songs) => songs;
        downloader.writeTags = async (blob) => blob;
        downloader._recordHistory = () => {};
        downloader.prepare = async (song) => ({ url: song.id, filename: song.title + '.mp3' });
    `, context);
    return { downloader: context.downloader, data, files, directories, context, failWrites };
}

test('saves each song before the batch ends; failed songs do not affect saved files; retry reuses folder', async () => {
    const { downloader, data, files, directories } = setup();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let fail = true;
    downloader.prepare = async (song) => {
        if (song.id === 'slow') await gate;
        if (song.id === 'bad' && fail) throw new Error('source unavailable');
        return { url: song.id, filename: song.title + '.mp3' };
    };
    const running = downloader.downloadAsZip([
        { id: 'ok', title: 'First' }, { id: 'slow', title: 'Second' }, { id: 'bad', title: 'Third' },
    ], 320);
    for (let i = 0; i < 100 && !files.size; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(files.size, 1, 'first song is already committed while another song is pending');
    const firstPath = [...files.keys()][0];
    assert.match(firstPath, /Downloads\/MSCD_\d+\/First\.mp3$/);
    release();
    const result = await running;
    assert.equal(result.successful, 2);
    assert.equal(result.failed, 1);
    assert.equal(files.size, 2);
    const originalFile = files.get(firstPath);
    fail = false;
    await downloader.retryTask(result.taskId);
    assert.equal(files.size, 3);
    assert.equal(directories.size, 1, 'retry writes to the same folder');
    assert.equal(files.get(firstPath), originalFile, 'successful song is not overwritten');
    assert.equal(data.downloadTasks[0].tracks.every((t) => t.status === 'done'), true);
});

test('unsupported browsers fail before starting downloads or creating a task', async () => {
    const { downloader, context, data } = setup();
    context.window = {};
    await assert.rejects(downloader.downloadAsZip([{ id: '1' }], 320), /Chrome.*Edge/);
    assert.equal(data.downloadTasks.length, 0);
});

test('a file close failure is reported without losing other files and can be retried', async () => {
    const { downloader, files, failWrites, data } = setup();
    failWrites.add('Broken.mp3');
    const result = await downloader.downloadBatchToDisk([
        { id: 'ok', title: 'Saved' }, { id: 'bad', title: 'Broken' },
    ], 320);
    assert.equal(result.successful, 1);
    assert.equal(result.failed, 1);
    assert.equal(files.size, 1);
    assert.equal(data.downloadTasks[0].tracks[1].status, 'error');
    failWrites.clear();
    await downloader.retryTask(result.taskId);
    assert.equal(files.size, 2);
});
