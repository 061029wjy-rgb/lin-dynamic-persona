class FakeNode {
    constructor(nodeType, tagName = '') {
        this.nodeType = nodeType;
        this.tagName = tagName.toUpperCase();
        this.childNodes = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.listeners = new Map();
        this.className = '';
        this.id = '';
        this.value = '';
        this.type = '';
        this.checked = false;
        this.open = false;
    }
    get isConnected() {
        let cur = this;
        while (cur) {
            if (cur._isRootBody) return true;
            cur = cur.parentNode;
        }
        return false;
    }
    get children() {
        return this.childNodes.filter(c => c.nodeType === 1);
    }
    get firstChild() {
        return this.childNodes[0] || null;
    }
    get textContent() {
        if (this.nodeType === 3) return this._text || '';
        return this.childNodes.map(c => c.textContent).join('');
    }
    set textContent(v) {
        this.childNodes = [];
        if (v !== '' && v != null) {
            const t = new FakeNode(3);
            t._text = String(v);
            t.parentNode = this;
            this.childNodes.push(t);
        }
    }
    set innerHTML(html) {
        this.childNodes = [];
        const s = String(html || '');
        const match = s.match(/<([a-z0-9]+)\s+id="([^"]+)"[^>]*><\/\1>/i);
        if (match) {
            const child = new FakeNode(1, match[1]);
            child.id = match[2];
            this.append(child);
        }
    }
    get innerHTML() {
        return this.textContent;
    }
    setAttribute(k, v) {
        const val = String(v);
        this.attributes.set(k, val);
        if (k === 'id') this.id = val;
        if (k === 'class') this.className = val;
    }
    getAttribute(k) {
        return this.attributes.get(k) ?? null;
    }
    append(...nodes) {
        for (const n of nodes) {
            if (n == null) continue;
            const child = typeof n === 'string' ? Object.assign(new FakeNode(3), { _text: n }) : n;
            if (child.parentNode) child.remove();
            child.parentNode = this;
            this.childNodes.push(child);
        }
    }
    replaceChildren(...nodes) {
        for (const c of this.childNodes) c.parentNode = null;
        this.childNodes = [];
        this.append(...nodes);
    }
    remove() {
        if (!this.parentNode) return;
        const idx = this.parentNode.childNodes.indexOf(this);
        if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
        this.parentNode = null;
    }
    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
    }
    dispatchEvent(evt) {
        const type = typeof evt === 'string' ? evt : evt.type;
        const e = typeof evt === 'string' ? { type, target: this } : { target: this, ...evt };
        for (const fn of this.listeners.get(type) || []) fn(e);
        if (typeof this[`on${type}`] === 'function') this[`on${type}`](e);
    }
    click() {
        if (this.tagName === 'INPUT' && this.type === 'checkbox') {
            this.checked = !this.checked;
            this.dispatchEvent({ type: 'change', target: this });
        }
        this.dispatchEvent({ type: 'click', target: this });
    }
    showModal() {
        this.open = true;
    }
    close() {
        this.open = false;
        this.dispatchEvent({ type: 'close', target: this });
    }
    closest(selector) {
        let cur = this;
        while (cur && cur.nodeType === 1) {
            if (matchesSelector(cur, selector)) return cur;
            cur = cur.parentNode;
        }
        return null;
    }
    querySelectorAll(selector) {
        const results = [];
        const parts = selector.trim().split(/\s+/);
        const walk = node => {
            for (const child of node.children) {
                if (matchesChain(child, parts)) results.push(child);
                walk(child);
            }
        };
        walk(this);
        return results;
    }
    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }
}

function matchesSelector(node, sel) {
    if (!node || node.nodeType !== 1) return false;
    if (sel.startsWith('#')) return node.id === sel.slice(1);
    if (sel.startsWith('.')) return (node.className || '').split(/\s+/).includes(sel.slice(1));
    return node.tagName.toLowerCase() === sel.toLowerCase();
}

function matchesChain(node, parts) {
    if (!matchesSelector(node, parts[parts.length - 1])) return false;
    let cur = node.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
        while (cur && cur.nodeType === 1 && !matchesSelector(cur, parts[i])) {
            cur = cur.parentNode;
        }
        if (!cur || cur.nodeType !== 1) return false;
        cur = cur.parentNode;
    }
    return true;
}

export class Window {
    constructor() {
        const body = new FakeNode(1, 'body');
        body._isRootBody = true;
        this.document = {
            body,
            createElement: tag => new FakeNode(1, tag),
            createTextNode: txt => Object.assign(new FakeNode(3), { _text: String(txt) }),
            querySelector: sel => body.querySelector(sel),
            querySelectorAll: sel => body.querySelectorAll(sel),
        };
        this.happyDOM = { abort: () => {} };
    }
}
