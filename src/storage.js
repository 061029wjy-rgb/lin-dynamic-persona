import { VERSION, clone, id } from './util.js';
import { validateState } from './model.js';
const STORES = ['streams', 'nodes', 'vectors'];
export class Database {
    constructor(accountId, indexedDB = globalThis.indexedDB) { this.name = `lin-dynamic-persona-v1-${accountId}`; this.indexedDB = indexedDB; }
    async open() {
        if (this.db) return this;
        if (!this.indexedDB) throw new Error('浏览器不支持 IndexedDB；已安全停用人格注入');
        this.db = await new Promise((resolve, reject) => {
            const r = this.indexedDB.open(this.name, VERSION);
            r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'key' }); };
            r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
            r.onblocked = () => reject(new Error('数据库升级被其他页面占用'));
        });
        this.db.onversionchange = () => this.close();
        return this;
    }
    close() { this.db?.close(); this.db = null; }
    async transaction(names, mode, run) {
        await this.open();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(names, mode); let result;
            tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('事务取消'));
            try { result = run(tx); } catch (e) { tx.abort(); reject(e); }
        });
    }
    async get(store, key) {
        let value;
        await this.transaction([store], 'readonly', tx => { const r = tx.objectStore(store).get(key); r.onsuccess = () => { value = r.result; }; });
        return value;
    }
    async all(store) {
        let value;
        await this.transaction([store], 'readonly', tx => { const r = tx.objectStore(store).getAll(); r.onsuccess = () => { value = r.result; }; });
        return value;
    }
    put(store, value) { return this.transaction([store], 'readwrite', tx => tx.objectStore(store).put(clone(value))); }
    remove(store, key) { return this.transaction([store], 'readwrite', tx => tx.objectStore(store).delete(key)); }
    async commit(stream, node, expectedRevision) {
        return this.transaction(['streams', 'nodes'], 'readwrite', tx => {
            const r = tx.objectStore('nodes').get(node.key);
            r.onsuccess = () => {
                if (expectedRevision !== undefined && (r.result?.revision ?? -1) !== expectedRevision) { tx.abort(); return; }
                tx.objectStore('nodes').put(clone(node)); tx.objectStore('streams').put(clone(stream));
            };
        });
    }
    async export() { return { format: 'lin-dynamic-persona', version: VERSION, exportedAt: new Date().toISOString(), streams: await this.all('streams'), nodes: await this.all('nodes') }; }
    async import(data) {
        if (data?.format !== 'lin-dynamic-persona' || data.version !== VERSION || !Array.isArray(data.streams) || !Array.isArray(data.nodes)) throw new Error('不支持的备份格式或版本');
        if (data.nodes.length > 100000) throw new Error('备份过大');
        const streamIds = new Set(data.streams.map(s => s.id));
        for (const s of data.streams) if (!s.id || s.key !== s.id || typeof s.owner !== 'string') throw new Error('存档数据无效');
        for (const n of data.nodes) {
            if (!streamIds.has(n.stream) || n.key !== `${n.stream}:${n.hash}` || !/^(root|[0-9a-f]{64})$/.test(n.hash)) throw new Error('分支索引无效');
            validateState(n.state);
            if (!Array.isArray(n.history)) throw new Error('修订历史无效');
            for (const r of n.history) validateState(r.state);
        }
        // Import into fresh namespaces. Never overwrite a live branch, even for an identical backup.
        const mapping = new Map(data.streams.map(s => [s.id, id()]));
        const streams = data.streams.map(s => ({ ...clone(s), id: mapping.get(s.id), key: mapping.get(s.id), owner: `import:${mapping.get(s.id)}`, importedOwner: s.owner, imported: true }));
        const nodes = data.nodes.map(n => ({ ...clone(n), stream: mapping.get(n.stream), key: `${mapping.get(n.stream)}:${n.hash}` }));
        await this.transaction(['streams', 'nodes'], 'readwrite', tx => {
            for (const s of streams) tx.objectStore('streams').put(s);
            for (const n of nodes) tx.objectStore('nodes').put(n);
        });
        return streams;
    }
    async clearVectors() { return this.transaction(['vectors'], 'readwrite', tx => tx.objectStore('vectors').clear()); }
}
