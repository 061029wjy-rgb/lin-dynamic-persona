class FakeObjectStore {
    constructor(map, tx) {
        this.map = map;
        this.tx = tx;
    }
    _schedule(op) {
        const req = { result: undefined, error: null, onsuccess: null, onerror: null };
        this.tx._enqueue(() => {
            req.result = op();
            if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
        });
        return req;
    }
    get(key) {
        return this._schedule(() => {
            const v = this.map.get(key);
            return v !== undefined ? structuredClone(v) : undefined;
        });
    }
    getAll() {
        return this._schedule(() => Array.from(this.map.values(), v => structuredClone(v)));
    }
    put(value) {
        return this._schedule(() => {
            const k = value?.key;
            if (k === undefined) throw new Error('Missing keyPath "key"');
            this.map.set(k, structuredClone(value));
            return k;
        });
    }
    delete(key) {
        return this._schedule(() => {
            this.map.delete(key);
        });
    }
    clear() {
        return this._schedule(() => {
            this.map.clear();
        });
    }
}

class FakeTransaction {
    constructor(db, storeNames, mode) {
        this.db = db;
        this.storeNames = Array.isArray(storeNames) ? storeNames : [storeNames];
        this.mode = mode;
        this.aborted = false;
        this.error = null;
        this.oncomplete = null;
        this.onerror = null;
        this.onabort = null;
        this.queue = [];
        this.snapshots = new Map();
        queueMicrotask(() => this._drain());
    }
    objectStore(name) {
        if (!this.db.stores.has(name)) throw new Error(`Store ${name} not found`);
        return new FakeObjectStore(this.db.stores.get(name), this);
    }
    _enqueue(fn) {
        this.queue.push(fn);
    }
    abort() {
        if (this.aborted) return;
        this.aborted = true;
        for (const [name, snap] of this.snapshots.entries()) {
            this.db.stores.set(name, snap);
        }
        queueMicrotask(() => {
            if (typeof this.onabort === 'function') this.onabort({ target: this });
        });
    }
    _drain() {
        // The fixture executes each transaction in one microtask. Snapshot when it starts,
        // not when queued: aborting writer B must never undo writer A's earlier commit.
        if (this.mode === 'readwrite') {
            for (const name of this.storeNames) {
                const s = this.db.stores.get(name);
                if (s) this.snapshots.set(name, new Map(s));
            }
        }
        try {
            while (this.queue.length > 0 && !this.aborted) {
                const fn = this.queue.shift();
                fn();
            }
            if (!this.aborted) {
                if (typeof this.oncomplete === 'function') this.oncomplete({ target: this });
            }
        } catch (err) {
            this.error = err;
            if (!this.aborted) {
                for (const [name, snap] of this.snapshots.entries()) {
                    this.db.stores.set(name, snap);
                }
                if (typeof this.onerror === 'function') this.onerror({ target: this });
            }
        }
    }
}

class FakeDB {
    constructor(name, version) {
        this.name = name;
        this.version = version;
        this.stores = new Map();
        this.onversionchange = null;
        this.objectStoreNames = {
            contains: s => this.stores.has(s),
        };
    }
    createObjectStore(name) {
        if (!this.stores.has(name)) this.stores.set(name, new Map());
        return new FakeObjectStore(this.stores.get(name), { _enqueue: fn => fn() });
    }
    transaction(names, mode = 'readonly') {
        return new FakeTransaction(this, names, mode);
    }
    close() {}
}

export class IDBFactory {
    constructor() {
        this.dbs = new Map();
    }
    open(name, version = 1) {
        const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
        queueMicrotask(() => {
            try {
                let db = this.dbs.get(name);
                const isNew = !db || db.version < version;
                if (!db) {
                    db = new FakeDB(name, version);
                    this.dbs.set(name, db);
                } else if (db.version < version) {
                    db.version = version;
                }
                req.result = db;
                if (isNew && typeof req.onupgradeneeded === 'function') {
                    req.onupgradeneeded({ target: req });
                }
                if (typeof req.onsuccess === 'function') {
                    req.onsuccess({ target: req });
                }
            } catch (err) {
                req.error = err;
                if (typeof req.onerror === 'function') req.onerror({ target: req });
            }
        });
        return req;
    }
}
