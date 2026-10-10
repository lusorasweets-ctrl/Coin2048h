// ZBZ Coin 2048 — server (Cloudflare Worker + KV binding named "KV")
// Secrets/vars: ADMIN_CODE (first admin code), SUPER_ID (main admin Telegram id), BOT_TOKEN (optional: can be set from the admin panel), APP_URL (optional)

const E = new TextEncoder(), hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const hmac = async (k, m) => crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), E.encode(m));
const sha = async s => hex(await crypto.subtle.digest('SHA-256', E.encode(s)));
const same = (a, b) => { a = String(a); b = String(b); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0 };
async function verify(init, token) {            // Telegram Mini App initData check
  const p = new URLSearchParams(init), h = p.get('hash'); if (!h) return null; p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  if (!same(hex(await hmac(await hmac(E.encode('WebAppData'), token), str)), h)) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 172800) return null;
  try { return JSON.parse(p.get('user')) } catch { return null }
}

// ---- game rules (all enforced here, not in the browser) ----
const PERMS = ['users', 'balance', 'block', 'msg', 'wd', 'bot'];   // what a sub-admin can be allowed to do
const AD_Z = 25, AD_MAX = 20, HY_Z = 2, HY_MAX = 15, HY_DAY = 55, COST = 10.555, ZR = .00005, KT = 25000, CAPT = 8 * 36e5, KILL_MS = 9000, REF = .05, MIN_WD = 5;
const PRIZES = Array.from({ length: 16 }, (_, i) => (i + 3) / 100);     // chest prizes 0.03 … 0.18 AZN
const TASKS = { t1: { r: .02, ok: u => u.ads >= 5 }, t5: { r: .01, ok: () => true }, t2: { r: .02, ok: u => u.g >= 1 }, t4: { r: .03, one: 1 }, t6: { r: REF, one: 1, ok: u => u.fr >= 1 } };

const r3 = n => Math.round(n * 1e3) / 1e3, r5 = n => Math.round(n * 1e5) / 1e5, today = () => new Date().toISOString().slice(0, 10);
const J = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
const kget = (env, k) => env.KV.get(k, 'json'), kput = (env, k, v, o) => env.KV.put(k, JSON.stringify(v), o);
const tg = (tok, m, b) => fetch(`https://api.telegram.org/bot${tok}/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()).catch(() => ({}));
const say = (tok, id, text, x) => tg(tok, 'sendMessage', { chat_id: id, text, ...x });
const cfgGet = async env => Object.assign({ open: true, msg: '', admins: {}, users: 0, pw: 0, app: '', channel: '', kcap: 200, smax: 15, adms: 5000, token: '', secret: '', codeh: '', bot: '', job: null, tasks: [] }, await kget(env, 'cfg'));
const TTYPES = ['chan', 'link', 'score', 'ads', 'games', 'friends'];
const tLink = t => t.link || (t.type === 'chan' && /^@\w+$/.test(t.ch || '') ? 'https://t.me/' + t.ch.slice(1) : '');
const pubTasks = c => (c.tasks || []).filter(t => t.on).map(t => ({ id: t.id, title: t.title, type: t.type, link: tLink(t), need: t.need, r: t.r, daily: t.daily ? 1 : 0 }));
const SUPERID = env => String(env.SUPER_ID || '8197921729');

const newU = t => ({ id: String(t.id), name: [t.first_name, t.last_name].filter(Boolean).join(' '), un: t.username || '', l: '', b: 0, z: 0, cx: 0, kc: 0, kd: 0, hy: HY_DAY, ha: 0, ads: 0, g: 0, ms: 0, cl: {}, o: {}, best: 0, pts: 0, fr: 0, day: '', st0: Date.now(), bk: 0, ap: null, blocked: false, chat: false, wd: [], cr: Date.now() });
function daily(u) { const d = today(); if (u.day === d) return false; Object.assign(u, { day: d, ads: 0, ha: 0, g: 0, ms: 0, kd: 0, cl: {} }); u.hy = Math.max(u.hy, HY_DAY); return true }
const pub = u => ({ b: r3(u.b), z: r5(u.z), cx: u.cx, kc: u.kc, hy: u.hy, ha: u.ha, ads: u.ads, g: u.g, ms: u.ms, cl: u.cl, o: u.o, best: u.best, pts: u.pts, fr: u.fr, st0: u.st0, wd: u.wd.slice(-20) });
const aU = (u, isA) => ({ id: u.id, name: u.name, un: u.un, b: r3(u.b), z: r5(u.z), cx: u.cx, hy: u.hy, ads: u.ads, fr: u.fr, best: u.best, blocked: u.blocked, chat: u.chat, admin: isA(u.id) });

async function audit(env, by, act, det) { const a = (await kget(env, 'audit')) || []; a.unshift({ t: Date.now(), by, act, det }); await kput(env, 'audit', a.slice(0, 200)) }
async function lbSet(env, id, u) { let l = (await kget(env, 'lb')) || []; l = l.filter(x => x.id !== id); l.push({ id, name: u.name, best: u.best }); l.sort((a, b) => b.best - a.best); await kput(env, 'lb', l.slice(0, 30)) }
async function notifyAdmins(env, c, tok, perm, text) { const ids = [SUPERID(env), ...Object.keys(c.admins).filter(i => c.admins[i].includes(perm))]; await Promise.all(ids.map(i => say(tok, i, text))) }
async function badCode(env, c, p, id) {         // admin code check with a lock after 5 wrong tries
  const lk = 'f:' + id, f = +(await env.KV.get(lk)) || 0; if (f >= 5) return 'locked';
  const ok = c.codeh ? same(await sha(String(p.c || '')), c.codeh) : !!env.ADMIN_CODE && same(p.c || '', env.ADMIN_CODE);
  if (!ok) { await env.KV.put(lk, String(f + 1), { expirationTtl: 900 }); return 'wrong' }
  if (f) await env.KV.delete(lk); return '';
}
async function setToken(env, c, token, origin) {
  token = String(token || '').trim(); const me = await tg(token, 'getMe', {}); if (!me.ok) return { error: 'token' };
  const secret = hex(crypto.getRandomValues(new Uint8Array(16)));
  const r = await tg(token, 'setWebhook', { url: origin + '/tg', secret_token: secret, allowed_updates: ['message'] }); if (!r.ok) return { error: 'webhook' };
  c.token = token; c.bot = me.result.username; c.secret = secret; await kput(env, 'cfg', c); return { ok: 1, bot: c.bot };
}

async function api(req, env) {
  const body = await req.json().catch(() => ({})), a = String(body.a || ''), p = body.p || {};
  const c = await cfgGet(env), SUPER = SUPERID(env), tok = c.token || env.BOT_TOKEN, origin = new URL(req.url).origin;
  if (!tok) {   // first set-up: no token anywhere yet. Only the main admin, with the admin code, may save one.
    if (a === 'a_token' && String(body.uid) === SUPER && !(await badCode(env, c, p, SUPER))) return setToken(env, c, p.token, origin);
    return { error: 'notoken' };
  }
  const tu = await verify(body.initData || '', tok); if (!tu) return { error: 'auth' };
  const id = String(tu.id), sup = id === SUPER, sub = c.admins[id], isAdm = sup || !!sub, perms = sup ? PERMS : (sub || []);
  let u = await kget(env, 'u:' + id), dirty = false;
  if (!u) { u = newU(tu); c.users++; await kput(env, 'cfg', c); dirty = true }
  const nm = [tu.first_name, tu.last_name].filter(Boolean).join(' ');
  if (u.name !== nm || u.un !== (tu.username || '')) { u.name = nm; u.un = tu.username || ''; dirty = true }
  if (daily(u)) dirty = true;
  if (typeof body.l === 'string' && body.l.slice(0, 2) !== u.l) { u.l = body.l.slice(0, 2); dirty = true }
  const save = async () => { if (dirty) await kput(env, 'u:' + id, u) };
  if (u.blocked && !isAdm) { await save(); return { blocked: true } }
  if (!c.open && !isAdm) { await save(); return { closed: true, msg: c.msg } }
  const ok = x => { dirty = true; return { ok: 1, u: pub(u), now: Date.now(), ...x } }, er = e => ({ error: e });
  let out;

  if (a.startsWith('a_')) {
    if (!isAdm) out = er('perm');
    else { const bad = await badCode(env, c, p, id); out = bad ? { error: 'code', why: bad } : await admin({ env, c, tok, a, p, id, sup, perms, SUPER, origin }) }
  } else switch (a) {
    case 'sync': out = { ok: 1, u: pub(u), now: Date.now(), bot: c.bot, channel: c.channel, tasks: pubTasks(c), admin: isAdm, adms: c.adms }; break;
    case 'ad_start': { const k = p.k === 'hype' ? 'hype' : 'earn'; if (k === 'earn' ? u.ads >= AD_MAX : u.ha >= HY_MAX) { out = er('limit'); break } u.ap = { k, t: Date.now() }; out = ok(); break }
    case 'ad_done': {           // reward only after a started ad and the minimum watch time
      const ap = u.ap, k = p.k === 'hype' ? 'hype' : 'earn';
      if (!ap || ap.k !== k) { out = er('bad'); break } if (Date.now() - ap.t < c.adms) { out = er('wait'); break }
      u.ap = null;
      if (k === 'earn') { if (u.ads >= AD_MAX) { dirty = true; out = er('limit'); break } u.ads++; u.z = r5(u.z + AD_Z) }
      else { if (u.ha >= HY_MAX) { dirty = true; out = er('limit'); break } u.ha++; u.hy += HY_Z }
      out = ok(); break
    }
    case 'game': {              // 2048: hype is spent here, score is capped per move
      const mv = Math.floor(+p.moves), sc = +p.score;
      if (!(mv >= 1) || mv > u.hy || !(sc >= 0) || sc > mv * c.smax) { out = er('bad'); break }
      u.hy -= mv; const z = r5(sc * 555 / 5555); u.z = r5(u.z + z); u.pts = r5(u.pts + sc); u.best = Math.max(u.best, sc); u.ms = Math.max(u.ms, sc); u.g++;
      if (sc > 0) await lbSet(env, id, u); out = ok({ got: z }); break
    }
    case 'chest': {
      if (p.kind === 'free') { if (u.cx < 1) { out = er('nof'); break } u.cx-- }
      else { if (u.z < COST - 1e-9) { out = er('nz'); break } u.z = r5(u.z - COST) }
      const prize = PRIZES[crypto.getRandomValues(new Uint32Array(1))[0] % PRIZES.length]; u.b = r3(u.b + prize); out = ok({ prize }); break
    }
    case 'kills': {             // a chest every 10 kills; kills are limited by real elapsed time and a daily cap
      const now = Date.now(); if (!u.bk) { u.bk = now; out = ok({ n: 0 }); break }
      u.bk = Math.max(u.bk, now - KILL_MS * 50);
      const n = Math.max(0, Math.min(Math.floor(+p.n) || 0, Math.floor((now - u.bk) / KILL_MS), c.kcap - u.kd));
      u.bk += n * KILL_MS; u.kd += n; u.kc += n; while (u.kc >= 10) { u.kc -= 10; u.cx++ } out = ok({ n }); break
    }
    case 'soldier': {           // passive ZBZ of the soldier (offline up to 8h)
      const k = Math.floor(Math.min(Date.now() - u.st0, CAPT) / KT); if (k <= 0) { out = er('none'); break }
      const z = r5(k * ZR); u.z = r5(u.z + z); u.st0 = Date.now() - u.st0 > CAPT ? Date.now() : u.st0 + k * KT; out = ok({ got: z }); break
    }
    case 'task': {
      const k = String(p.k), T = TASKS[k]; if (!T) { out = er('bad'); break } const done = T.one ? u.o : u.cl; if (done[k]) { out = er('exists'); break }
      if (k === 't4') {
        if (!c.channel) { out = er('nochan'); break }
        const r = await tg(tok, 'getChatMember', { chat_id: c.channel, user_id: id });
        if (!['member', 'administrator', 'creator'].includes(r.result && r.result.status)) { out = er('notjoined'); break }
      } else if (!T.ok(u)) { out = er('notyet'); break }
      done[k] = 1; u.b = r3(u.b + T.r); out = ok({ got: T.r }); break
    }
    case 'wd': {
      const amt = +p.amt, m = String(p.m), d = String(p.d || '').trim(), dg = d.replace(/\D/g, '');
      const valid = m === 'card' ? /^\d{16}$/.test(dg) : m === 'usdt' ? /^[\w-]{48}$/.test(d) : (m === 'm10' || m === 'mobile') && dg.length >= 9 && dg.length <= 12;
      if (!valid || !(amt >= MIN_WD)) { out = er('bad'); break } if (amt > u.b + 1e-9) { out = er('nofund'); break }
      if (u.wd.some(w => w.st === 'pending')) { out = er('pending'); break }
      const wid = Date.now().toString(36).padStart(9, '0') + '_' + id; u.b = r3(u.b - amt);
      const w = { id: wid, uid: id, name: u.name, un: u.un, amt, m, d: m === 'usdt' ? d : dg, op: String(p.op || '').slice(0, 12), st: 'pending', t: Date.now() };
      await kput(env, 'w:' + wid, w); u.wd.push({ id: wid, amt, m, st: 'pending', t: w.t }); u.wd = u.wd.slice(-30); c.pw = (c.pw || 0) + 1; await kput(env, 'cfg', c);
      const ML = { card: '💳 Bank kartı', m10: '📱 M10', mobile: '📞 Mobil nömrə', usdt: '💲 USDT (TON)' }, dd = m === 'card' ? w.d.replace(/(\d{4})(?=\d)/g, '$1 ') : w.d;
      await notifyAdmins(env, c, tok, 'wd', `💸 Yeni çıxarış sorğusu\n\n👤 Ad: ${u.name || '-'}\n🔗 Username: ${u.un ? '@' + u.un : '-'}\n🆔 ID: ${id}\n\n${ML[m]}${w.op ? ' (' + w.op + ')' : ''}\n💰 Məbləğ: ${amt} AZN\n📋 ${m === 'card' ? 'Kart nömrəsi' : m === 'usdt' ? 'Ünvan' : 'Nömrə'}: ${dd}\n\n💼 Qalan balans: ${u.b} AZN\n🧾 Sorğu: #${wid.split('_')[0].slice(-6).toUpperCase()}\n🕒 ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Baku' })}\n\nOyunda: Profil → ⚙ Admin → Çıxarış`); out = ok(); break
    }
    case 'tstart': {            // user opened the task link: the claim needs a short delay after this
      const T = (c.tasks || []).find(x => x.id === String(p.id) && x.on); if (!T) { out = er('bad'); break }
      u.ts = u.ts || {}; u.ts[T.id] = Date.now(); out = ok(); break
    }
    case 'ctask': {             // admin-defined task
      const T = (c.tasks || []).find(x => x.id === String(p.id) && x.on); if (!T) { out = er('bad'); break }
      const key = 'x' + T.id, done = T.daily ? u.cl : u.o; if (done[key]) { out = er('exists'); break }
      if (T.type === 'chan') {
        if (!T.ch) { out = er('chfail'); break }
        const r = await tg(tok, 'getChatMember', { chat_id: T.ch, user_id: id }); if (!r.ok) { out = er('chfail'); break }
        if (!['member', 'administrator', 'creator'].includes(r.result && r.result.status)) { out = er('notjoined'); break }
      } else if (T.type === 'link') {
        const ts = u.ts && u.ts[T.id]; if (!ts) { out = er('notyet'); break } if (Date.now() - ts < 8000) { out = er('wait'); break }
        delete u.ts[T.id];
      } else {
        const v = T.type === 'score' ? (T.daily ? u.ms : u.best) : T.type === 'ads' ? u.ads : T.type === 'games' ? u.g : u.fr;
        if (!(v >= T.need)) { out = er('notyet'); break }
      }
      done[key] = 1; u.b = r3(u.b + T.r); out = ok({ got: T.r }); break
    }
    case 'leaders': out = { ok: 1, list: (await kget(env, 'lb')) || [] }; break
    default: out = er('unknown')
  }
  await save(); return out;
}

async function admin(X) {
  const { env, c, tok, a, p, id, sup, perms, SUPER, origin } = X, need = k => sup || perms.includes(k), NO = { error: 'perm' };
  const find = i => kget(env, 'u:' + String(i).trim()), isA = i => String(i) === SUPER || !!c.admins[String(i)];
  switch (a) {
    case 'a_login': return { sup, perms, cfg: { open: c.open, msg: c.msg, bot: c.bot, app: c.app, channel: c.channel, kcap: c.kcap, smax: c.smax, adms: c.adms, token: !!(c.token || env.BOT_TOKEN), admins: sup ? c.admins : undefined, tasks: sup ? c.tasks : undefined, super: SUPER, PERMS } };
    case 'a_stats': return { users: c.users, pending: c.pw || 0, open: c.open };
    case 'a_users': {
      if (!need('users')) return NO;
      if (p.q) { const t = await find(p.q); return { list: t ? [aU(t, isA)] : [], cursor: '' } }
      const l = await env.KV.list({ prefix: 'u:', limit: 20, cursor: p.cursor || undefined });
      const us = (await Promise.all(l.keys.map(k => kget(env, k.name)))).filter(Boolean); return { list: us.map(t => aU(t, isA)), cursor: l.list_complete ? '' : l.cursor };
    }
    case 'a_user': { if (!need('users')) return NO; const t = await find(p.id); if (!t) return { error: 'none' }; return { u: aU(t, isA), wds: t.wd.slice(-10).reverse() } }
    case 'a_bal': {             // add / subtract / set: AZN (b), ZBZ (z), chests (cx), hype (hy)
      if (!need('balance')) return NO; const t = await find(p.id), v = +p.v;
      if (!t || !Number.isFinite(v) || !['b', 'z', 'cx', 'hy'].includes(p.k) || !['add', 'sub', 'set'].includes(p.mode)) return { error: 'bad' };
      const old = t[p.k]; let n = Math.max(0, p.mode === 'set' ? v : p.mode === 'sub' ? old - v : old + v); n = p.k === 'b' ? r3(n) : p.k === 'z' ? r5(n) : Math.floor(n);
      t[p.k] = n; await kput(env, 'u:' + t.id, t); await audit(env, id, 'bal', `${t.id} ${p.k} ${old}→${n}`); return { ok: 1, u: aU(t, isA) };
    }
    case 'a_block': {           // admins cannot be blocked: remove admin rights first
      if (!need('block')) return NO; const t = await find(p.id); if (!t) return { error: 'none' }; if (isA(t.id)) return { error: 'admin' };
      t.blocked = !!p.on; await kput(env, 'u:' + t.id, t); await audit(env, id, p.on ? 'block' : 'unblock', t.id); return { ok: 1, u: aU(t, isA) };
    }
    case 'a_msg': {
      if (!need('msg')) return NO; const text = String(p.text || '').slice(0, 3500); if (!text) return { error: 'bad' };
      if (p.to === 'all') { c.job = { text, cursor: null, sent: 0 }; await kput(env, 'cfg', c); await audit(env, id, 'msg', 'all'); return { ok: 1, started: 1 } }
      const t = await find(p.to); if (!t) return { error: 'none' }; if (!t.chat) return { error: 'nochat' };
      await say(tok, t.id, text); await audit(env, id, 'msg', t.id); return { ok: 1 };
    }
    case 'a_wds': {
      if (!need('wd')) return NO; const l = await env.KV.list({ prefix: 'w:', limit: 1000 });
      let all = (await Promise.all(l.keys.slice(-30).map(k => kget(env, k.name)))).filter(Boolean).reverse(); if (p.st) all = all.filter(w => w.st === p.st); return { list: all };
    }
    case 'a_wdset': {           // paid / rejected (rejected refunds the AZN) / pending
      if (!need('wd')) return NO; const w = await kget(env, 'w:' + p.wid); if (!w || !['paid', 'rejected', 'pending'].includes(p.st)) return { error: 'none' };
      const was = w.st; if (was !== p.st) {
        const t = await find(w.uid);
        if (t) { if (p.st === 'rejected') t.b = r3(t.b + w.amt); if (was === 'rejected') t.b = r3(Math.max(0, t.b - w.amt)); const x = t.wd.find(q => q.id === w.id); if (x) x.st = p.st; await kput(env, 'u:' + t.id, t); if (t.chat && p.st !== 'pending') await say(tok, t.id, p.st === 'paid' ? `✅ ${w.amt} AZN` : `❌ ${w.amt} AZN ↩`) }
        c.pw = Math.max(0, (c.pw || 0) + (p.st === 'pending' ? 1 : was === 'pending' ? -1 : 0)); await kput(env, 'cfg', c);
      }
      w.st = p.st; await kput(env, 'w:' + w.id, w); await audit(env, id, 'wd', `${w.id} ${p.st}`); return { ok: 1 };
    }
    case 'a_bot': {             // stop / start the bot for maintenance (admins keep access)
      if (!need('bot')) return NO; c.open = !!p.open; if (typeof p.msg === 'string') c.msg = p.msg.slice(0, 500); await kput(env, 'cfg', c); await audit(env, id, 'bot', c.open ? 'start' : 'stop'); return { ok: 1, open: c.open };
    }
    case 'a_cfg': {
      if (!sup) return NO;
      if (typeof p.app === 'string') c.app = p.app.trim(); if (typeof p.channel === 'string') c.channel = p.channel.trim();
      if (p.kcap >= 0) c.kcap = Math.floor(p.kcap); if (p.smax > 0) c.smax = +p.smax; if (p.adms >= 0) c.adms = Math.floor(p.adms);
      await kput(env, 'cfg', c); await audit(env, id, 'cfg', JSON.stringify(p).slice(0, 120)); return { ok: 1 };
    }
    case 'a_token': { if (!sup) return NO; const r = await setToken(env, c, p.token, origin); if (r.ok) await audit(env, id, 'token', r.bot); return r }
    case 'a_code': { if (!sup) return NO; const n = String(p.n || ''); if (n.length < 6) return { error: 'short' }; c.codeh = await sha(n); await kput(env, 'cfg', c); await audit(env, id, 'code', ''); return { ok: 1 } }
    case 'a_admin': {           // main admin only; the main admin itself can never be changed or removed
      if (!sup) return NO; const i = String(p.id || '').trim();
      if (!/^\d+$/.test(i)) return { error: 'bad' }; if (i === SUPER) return { error: 'super' };
      if (p.del) delete c.admins[i]; else { if (Object.keys(c.admins).length >= 20 && !c.admins[i]) return { error: 'limit' }; c.admins[i] = (p.perms || []).filter(x => PERMS.includes(x)) }
      await kput(env, 'cfg', c); await audit(env, id, p.del ? 'admin-del' : 'admin-set', i + ' ' + (c.admins[i] || []).join(',')); return { ok: 1, admins: c.admins };
    }
    case 'a_task': {            // main admin: add / change / delete tasks
      if (!sup) return NO; c.tasks = c.tasks || [];
      if (p.op === 'del') { c.tasks = c.tasks.filter(t => t.id !== String(p.id)); await kput(env, 'cfg', c); await audit(env, id, 'task-del', String(p.id)); return { ok: 1, tasks: c.tasks } }
      const x = p.task || {}, title = String(x.title || '').trim().slice(0, 60), r = r3(+x.r), need = Math.floor(+x.need) || 0;
      if (!title || !TTYPES.includes(x.type) || !(r > 0) || r > 100) return { error: 'bad' };
      const link = String(x.link || '').trim().slice(0, 200), ch = String(x.ch || '').trim().slice(0, 64);
      if (link && !/^https?:\/\//.test(link)) return { error: 'bad' }; if (x.type === 'link' && !link) return { error: 'bad' }; if (x.type === 'chan' && !ch) return { error: 'bad' };
      if (['score', 'ads', 'games', 'friends'].includes(x.type) && need < 1) return { error: 'bad' };
      const t = { id: String(x.id || '') || Date.now().toString(36), title, type: x.type, link, ch, need, r, daily: x.daily ? 1 : 0, on: x.on === false || x.on === 0 ? 0 : 1 };
      const i = c.tasks.findIndex(q => q.id === t.id); if (i >= 0) c.tasks[i] = t; else { if (c.tasks.length >= 30) return { error: 'limit' }; c.tasks.push(t) }
      await kput(env, 'cfg', c); await audit(env, id, 'task-set', t.id + ' ' + t.title); return { ok: 1, tasks: c.tasks };
    }
    case 'a_audit': return sup ? { list: (await kget(env, 'audit')) || [] } : NO;
  }
  return { error: 'unknown' };
}

async function webhook(req, env) {
  const c = await cfgGet(env), tok = c.token || env.BOT_TOKEN;
  if (c.secret && req.headers.get('x-telegram-bot-api-secret-token') !== c.secret) return new Response('forbidden', { status: 403 });
  const m = (await req.json().catch(() => ({}))).message;
  if (tok && m && m.text && m.text.startsWith('/start')) {
    const f = m.from, fid = String(f.id), adm = fid === SUPERID(env) || !!c.admins[fid];
    let u = await kget(env, 'u:' + fid), isNew = false; if (!u) { u = newU(f); c.users++; isNew = true }
    if (u.blocked && !adm) return new Response('ok');
    u.chat = true; const ref = (m.text.split(' ')[1] || '').replace('ref_', '');
    if (ref && ref !== fid && !u.rf && (isNew || Date.now() - u.cr < 36e5)) { const inv = await kget(env, 'u:' + ref); if (inv && !inv.blocked) { u.rf = ref; inv.fr++; inv.b = r3(inv.b + REF); await kput(env, 'u:' + ref, inv); if (inv.chat) await say(tok, ref, `🎉 ${u.name} +${REF} AZN`) } }
    await kput(env, 'u:' + fid, u); if (isNew) await kput(env, 'cfg', c);
    if (!c.open && !adm) await say(tok, fid, c.msg || '🛠 Texniki işlər gedir. Tezliklə qayıdacağıq.\n🛠 Maintenance in progress.');
    else { const app = c.app || env.APP_URL; await say(tok, fid, '🧩 Coin 2048', app ? { reply_markup: { inline_keyboard: [[{ text: '▶ Play', web_app: { url: app } }]] } } : {}) }
  }
  return new Response('ok');
}
async function broadcast(env) {   // admin message to everyone, 20 users per run
  const c = await cfgGet(env), tok = c.token || env.BOT_TOKEN; if (!tok || !c.job) return;
  const l = await env.KV.list({ prefix: 'u:', limit: 20, cursor: c.job.cursor || undefined });
  for (const k of l.keys) { const u = await kget(env, k.name); if (u && u.chat && !u.blocked) { await say(tok, u.id, c.job.text); c.job.sent++ } }
  if (l.list_complete) c.job = null; else c.job.cursor = l.cursor; await kput(env, 'cfg', c);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST,GET,OPTIONS' } });
    if (url.pathname === '/api' && req.method === 'POST') return J(await api(req, env).catch(e => ({ error: 'server', why: e.message })));
    if (url.pathname === '/tg' && req.method === 'POST') return webhook(req, env);
    return new Response('zbz-api ok');
  },
  async scheduled(e, env) { await broadcast(env) }
};
