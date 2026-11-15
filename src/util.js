export const KEY = 'lin_dynamic_persona';
export const VERSION = 1;
export const clone = x => structuredClone(x);
export const id = () => crypto.randomUUID();
export const clamp = (v, min, max, fallback = min) => Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback;
export const text = (v, n = 1800) => String(v ?? '').slice(0, n).replace(/\u0000/g, '');
export function visible(v) {
    return text(v, 1000000).replace(/<!--[\s\S]*?(?:-->|$)/g, '')
        .replace(/<(think(?:ing)?|reasoning|analysis|lin_cot|details|script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
        .replace(/<[^>]*>/g, '').trim();
}
export function effective(m) {
    return !m?.is_user && !m?.is_system && !m?.extra?.tool_invocations?.length &&
        !m?.extra?.isSmallSys && /[\p{L}\p{N}]/u.test(visible(m?.mes)) &&
        !/^(?:generation (?:failed|stopped)|network error|\[?empty\]?|生成失败|请求出错)\s*$/i.test(visible(m.mes));
}
export const ooc = v => /^(?:\s*[【\[(]?\s*(?:OOC\b|戏外|场外|暂停扮演|仅摘要)|\s*\/)/i.test(visible(v));
export async function hash(v) {
    const bytes = new TextEncoder().encode(v);
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function deadline(promise, ms, fallback) {
    let timer;
    try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); })]); }
    finally { clearTimeout(timer); }
}
export const byteTokens = v => new TextEncoder().encode(v).length;
export function fingerprintMessage(m) {
    // No array index, selected swipe number, reasoning or generation timestamp: only selected story content.
    return JSON.stringify([!!m.is_user, !!m.is_system, m.original_avatar || '', m.name || '', visible(m.mes), !!m.extra?.tool_invocations?.length]);
}
export class Fingerprints {
    rows = [];
    async of(chat) {
        const next = [{ hash: 'root', parent: null, index: -1 }];
        for (let i = 0; i < chat.length; i++) {
            const signature = fingerprintMessage(chat[i]), parent = next[i].hash, cached = this.rows[i];
            next.push(cached?.signature === signature && cached.parent === parent ? cached :
                { hash: await hash(`${parent}\n${signature}`), parent, signature, index: i });
        }
        this.rows = next.slice(1);
        return next;
    }
}
export function safeURL(value) {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('请输入不含账号密码的 HTTP(S) API 地址');
    return u.toString().replace(/\/$/, '');
}
