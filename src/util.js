export const KEY = 'lin_dynamic_persona_v5';
export const OLD_KEY = 'lin_dynamic_persona_v4';
export const VERSION = 5;
export const LEGACY_VERSIONS = [1, 2, 3, 4, 5];
export const clone = x => structuredClone(x);

export function id() {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
        globalThis.crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const clamp = (v, min, max, fallback = min) => Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback;
export const text = (v, n = 1800) => String(v ?? '').slice(0, n).replace(/\u0000/g, '');

export function visible(v) {
    return text(v, 1000000).replace(/<!--[\s\S]*?(?:-->|$)/g, '')
        .replace(/<(think(?:ing)?|reasoning|analysis|lin_cot|details|script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
        .replace(/<[^>]*>/g, '').trim();
}

export function effective(m) {
    const v = visible(m?.mes);
    return !m?.is_user && !m?.is_system && !m?.extra?.tool_invocations?.length &&
        !m?.extra?.isSmallSys && !m?.extra?.tool_calls?.length && !m?.extra?.aborted && !m?.extra?.error && !m?.extra?.is_error && /[\p{L}\p{N}]/u.test(v) &&
        !/^(?:generation (?:failed|stopped)|network error|\[?empty\]?|生成失败|请求出错)\s*$/i.test(v) &&
        !/^(?:\[?(?:API|Proxy|Gateway|Vertex|OpenRouter|Upstream|Server)\s*Error\b|Error:\s*(?:4\d\d|5\d\d)\b|(?:很抱歉|抱歉|对不起)[，,\s]*作为(?:一个|一名)?(?:AI|人工智能|语言模型)|As an (?:AI|artificial intelligence|large language model)\b|I(?:'m| am) sorry,\s*but I (?:cannot|can't) (?:fulfill|comply with|continue|generate)\b)/i.test(v);
}

export const ooc = v => /^(?:\s*[【\[(]?\s*(?:OOC\b|戏外|场外|暂停扮演|仅摘要)|\s*\/)/i.test(visible(v));

const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Fallback(bytes) {
    const len = bytes.length;
    const bitLenHi = Math.floor((len * 8) / 0x100000000);
    const bitLenLo = (len * 8) >>> 0;
    const paddedLen = ((len + 9 + 63) & ~63);
    const buf = new Uint8Array(paddedLen);
    buf.set(bytes);
    buf[len] = 0x80;
    const view = new DataView(buf.buffer);
    view.setUint32(paddedLen - 8, bitLenHi, false);
    view.setUint32(paddedLen - 4, bitLenLo, false);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));

    for (let offset = 0; offset < paddedLen; offset += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) >>> 0;
            h = g; g = f; f = e; e = (d + temp1) >>> 0;
            d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
        }
        h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map(v => v.toString(16).padStart(8, '0')).join('');
}

export async function hash(v) {
    const bytes = new TextEncoder().encode(v);
    if (typeof globalThis.crypto?.subtle?.digest === 'function') {
        return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    }
    return sha256Fallback(bytes);
}

export async function deadline(promise, ms, fallback) {
    let timer;
    try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); })]); }
    finally { clearTimeout(timer); }
}

export const byteTokens = v => Math.ceil(new TextEncoder().encode(String(v || '')).length / 3);

export function legacySignature(m) {return JSON.stringify([!!m.is_user,!!m.is_system,m.original_avatar||'',m.name||'',visible(m.mes),!!m.extra?.tool_invocations?.length]);}
const signatures=new WeakMap();
export function fingerprintMessage(m){
 if(!m)return '';const flag=!!(m.extra?.tool_calls?.length||m.extra?.tool_invocations?.length||m.extra?.aborted||m.extra?.error||m.extra?.is_error||m.extra?.isSmallSys);
 const meta=JSON.stringify([!!m.is_user,!!m.is_system,m.original_avatar||'',m.name||'',m.swipe_id??0,m.send_date??'',flag]);const hit=signatures.get(m);
 if(hit?.meta===meta&&hit.raw===m.mes)return hit.sig;
 const sig=JSON.stringify([meta,visible(m.mes)]);signatures.set(m,{raw:m.mes,meta,sig});return sig;
}
export class Fingerprints {
    rows = [];
    sigCache = new Map();
    async of(chat) {
        const next = [{ hash: 'root', parent: null, index: -1 }];
        let prefixMatch = true;
        for (let i = 0; i < chat.length; i++) {
            const signature = fingerprintMessage(chat[i]), parent = next[i].hash, cached = this.rows[i];
            if (prefixMatch && cached?.signature === signature && cached.parent === parent) {
                next.push(cached);
                continue;
            }
            prefixMatch = false;
            const cacheKey = `${parent}\n${signature}`;
            let h = this.sigCache.get(cacheKey);
            if (!h) {
                h = await hash(cacheKey);
                if (this.sigCache.size > 8192) {
                    const firstKey = this.sigCache.keys().next().value;
                    this.sigCache.delete(firstKey);
                }
                this.sigCache.set(cacheKey, h);
            }
            next.push({ hash: h, parent, signature, index: i });
        }
        this.rows = next.slice(1);
        return next;
    }
}
