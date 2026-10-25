// Brainrot Casino — serveur (Netlify Function + Netlify Blobs)
// Tout ce qui touche aux coins, aux spins et aux droits admin est décidé ici,
// jamais dans le navigateur des joueurs.
// ===== Plateforme Cloudflare : toutes les données sont dans un Durable Object (SQLite) =====
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { DurableObject } from "cloudflare:workers";
let SQL = null; // base SQLite du Durable Object, fixée à chaque requête
function sqlStore(sql) {
  const ver = (k) => { const r = sql.exec("SELECT ver FROM kv WHERE k = ?", k).toArray()[0]; return r ? String(r.ver) : null; };
  function write(k, v, o) {
    if (o && o.onlyIfMatch) {
      const r = sql.exec("UPDATE kv SET v = ?, ver = ver + 1 WHERE k = ? AND ver = ? RETURNING ver", v, k, Number(o.onlyIfMatch)).toArray()[0];
      return r ? { modified: true, etag: String(r.ver) } : { modified: false };
    }
    if (o && o.onlyIfNew) {
      const r = sql.exec("INSERT INTO kv (k, v, ver) VALUES (?, ?, 1) ON CONFLICT(k) DO NOTHING RETURNING ver", k, v).toArray()[0];
      return r ? { modified: true, etag: String(r.ver) } : { modified: false };
    }
    const r = sql.exec("INSERT INTO kv (k, v, ver) VALUES (?, ?, 1) ON CONFLICT(k) DO UPDATE SET v = excluded.v, ver = kv.ver + 1 RETURNING ver", k, v).toArray()[0];
    return { modified: true, etag: String(r.ver) };
  }
  const read = (k) => { const r = sql.exec("SELECT v, ver FROM kv WHERE k = ?", k).toArray()[0]; return r || null; };
  return {
    async get(k, o) { const r = read(k); if (!r) return null; return o && o.type === "json" ? JSON.parse(r.v) : r.v; },
    async getWithMetadata(k, o) { const r = read(k); if (!r) return null; return { data: o && o.type === "json" ? JSON.parse(r.v) : r.v, etag: String(r.ver), metadata: {} }; },
    async set(k, v, o) { return write(k, String(v), o); },
    async setJSON(k, v, o) { return write(k, JSON.stringify(v), o); },
    async delete(k) { sql.exec("DELETE FROM kv WHERE k = ?", k); },
    async list({ prefix }) {
      const rows = sql.exec("SELECT k FROM kv WHERE k >= ? AND k < ?", prefix, prefix + "￿").toArray();
      return { blobs: rows.map((r) => ({ key: r.k, etag: "" })), directories: [] };
    },
  };
}
const P = {
  store: () => sqlStore(SQL),
  sha: (s) => crypto.createHash("sha256").update(s).digest("hex"),
  hashPw: (pass, salt) => crypto.scryptSync(String(pass), salt, 32).toString("hex"),
  hmac: (key, msg) => crypto.createHmac("sha256", key).update(msg).digest("base64url"),
  safeEq: (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); },
  randInt: (min, max) => crypto.randomInt(min, max),
  randHex: (n) => crypto.randomBytes(n).toString("hex"),
};


// ---------- Réglages du casino ----------
const START = 10;          // coins de départ
const BONUS = 0.25;        // +25 % quand on échange un gain de spin en coins
const OWNERS = { layola: "Layola", boruteo: "Boruteo" }; // comptes owners créés de base (mot de passe 123)
const DEFAULT_PASSWORD = "123";
const CLOSE_PASSWORD = "FrenchFries"; // mot de passe pour fermer / rouvrir le site

const BRAINROTS = {
  esok:      { name: "Esok Sekolah",             price: 15 },
  nuclearo:  { name: "Nuclearo Dinossauro",      price: 20 },
  tangtang:  { name: "Tang Tang Keletang",       price: 25 },
  puggy:     { name: "Money Money Puggy",        price: 30 },
  lavadorito:{ name: "Lavadorito Spinito",       price: 30 },
  garama:    { name: "Garama And Madungdung",    price: 50 },
  burguro:   { name: "Burguro And Fryuro",       price: 180 },
  capitano:  { name: "Capitano Moby",            price: 180 },
  cerberus:  { name: "Cerberus",                 price: 200 },
  venuspino: { name: "Venuspino",                price: 900 },
  dragon:    { name: "Dragon Cannelloni",        price: 1100 },
  supreme:   { name: "La Supreme Combinasion",   price: 2500 },
  antonio:   { name: "Antonio",                  price: 7000 },
  skibidi:   { name: "Skibidi Toilet",           price: 18000 },
  // Gain de spin uniquement (pas dans la boutique) : un owner donne un Garama Color avec la mutation de son choix
  // Ancien gain de spin (gardé pour l'historique), plus dans la boutique ni dans les spins
  garamacolor: { name: "Garama Color (mutation au hasard)", price: 300, hidden: true },
};

// Garama Color : valeur dans les paniers selon la mutation
const MUTATIONS = [
  ["Candy", 210], ["Lava", 240], ["Radioactive", 250], ["Galaxy", 270], ["Yin Yang", 275], ["Cursed", 275],
  ["Bloodrot", 280], ["Divine", 285], ["Cyber", 285], ["Phantom", 340], ["Crystal", 375], ["Eclipse", 475],
];

// Brainrots "au choix" : le joueur choisit lequel en l'ajoutant au panier.
// estimate: true = pas de prix fixe, un owner fait une estimation après le ticket.
const CHOICES = {
  any1b2b: { name: "Brainrot à 1B ou 2B/s", label: "au choix", own: true,
    note: "N'importe quel brainrot du jeu qui fait 1B ou 2B par seconde. Tu choisis lequel des deux.",
    options: {
      "1b": { name: "Brainrot 1B/s", price: 100 },
      "2b": { name: "Brainrot 2B/s", price: 200 },
    } },
  garamacolor: { name: "Garama Color", label: "Garama Color", own: true,
    note: "Garama Color = un Garama And Madungdung avec une mutation. Tu choisis laquelle.",
    options: Object.fromEntries(MUTATIONS.map(([m, price]) => [m.toLowerCase().replace(/\s+/g, ""), { name: `Garama ${m}`, price }])) },
  any5b: { name: "Brainrot à 5B/s", label: "5B/s",
    note: "Tu choisis quel brainrot à 5B par seconde tu échanges.",
    options: {
      popcuru:    { name: "Popcuru",            price: 1700 },
      burguro:    { name: "Burguro And Fryuro", price: 1600 },
      cerberus:   { name: "Cerberus",           price: 1700 },
      pizzaranch: { name: "Pizza And Ranch",    price: 1900 },
      venuspino:  { name: "Venuspino",          price: 2000 },
      cookimilky: { name: "Cooki And Milky",    price: 2000 },
      autre:      { name: "Autre (à préciser)", price: 0, estimate: true },
    } },
  any10b: { name: "Brainrot à 10B/s", label: "10B/s",
    note: "Tu choisis quel brainrot à 10B par seconde tu échanges.",
    options: {
      venuspino:    { name: "Venuspino",               price: 7000 },
      dragon:       { name: "Dragon Cannelloni",       price: 7000 },
      hydraserpent: { name: "Hydra Serpent",           price: 7400 },
      hydradragon:  { name: "Hydra Dragon Cannelloni", price: 0, estimate: true },
      griffin:      { name: "Griffin",                 price: 10000 },
      aquanini:     { name: "Dragon Aquanini",         price: 11000 },
      autre:        { name: "Autre (à préciser)",      price: 0, estimate: true },
    } },
};

// Chances en % (le total de chaque spin doit faire 100)
const BOXES = [
  { k: "basic", name: "Spin Bronze", cost: 33, loot: [
    { k: "esok", chance: 30, rarity: "common" },
    { k: "nuclearo", chance: 30, rarity: "common" },
    { k: "puggy", chance: 20, rarity: "uncommon" },
    { k: "lavadorito", chance: 13, rarity: "rare" },
    { k: "garama", chance: 7, rarity: "legend" },
  ]},
  { k: "high", name: "Spin Argent", cost: 115, loot: [
    { k: "lavadorito", chance: 47, rarity: "common" },
    { k: "garama", chance: 31, rarity: "uncommon" },
    { k: "burguro", chance: 9, rarity: "rare" },
    { k: "capitano", chance: 7, rarity: "rare" },
    { k: "cerberus", chance: 4.5, rarity: "epic" },
    { k: "dragon", chance: 1.5, rarity: "legend" },
  ]},
  { k: "ultra", name: "Spin Or", cost: 420, loot: [
    { k: "capitano", chance: 32, rarity: "uncommon" },
    { k: "cerberus", chance: 30, rarity: "rare" },
    { k: "garamacolor", v: "crystal", chance: 20, rarity: "rare" },
    { k: "garamacolor", v: "eclipse", chance: 13, rarity: "epic" },
    { k: "venuspino", chance: 4, rarity: "epic" },
    { k: "dragon", chance: 0.7, rarity: "legend" },
    { k: "supreme", chance: 0.25, rarity: "legend" },
    { k: "skibidi", chance: 0.05, rarity: "mythic" },
  ]},
];

// Nom et valeur d'un brainrot, normal ("cerberus") ou au choix ("any5b" + "popcuru")
function fullName(g, o) { return g.own ? o.name : `${o.name} (${g.label})`; }
function itemOf(k, v) {
  if (!v) { const b = BRAINROTS[k]; return b ? { key: k, name: b.name, price: b.price } : null; }
  const g = CHOICES[k], o = g && g.options[v];
  return o ? { key: `${k}:${v}`, name: fullName(g, o), price: o.price, estimate: !!o.estimate } : null;
}

// ---------- Outils ----------
class HttpErr extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpErr(status, message, extra); };
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const store = () => P.store();
const now = () => Date.now();
const sha = (s) => P.sha(s);

function hashPw(pass, salt) { return P.hashPw(pass, salt); }
function checkPw(pass, u) {
  return P.safeEq(hashPw(pass, u.salt), u.hash);
}
function randId(prefix, len, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789") {
  let s = prefix;
  for (let i = 0; i < len; i++) s += alphabet[P.randInt(0, alphabet.length)];
  return s;
}
function intIn(v, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

async function secret(st) {
  let s = await st.get("config/secret");
  if (!s) { s = P.randHex(32); await st.set("config/secret", s); }
  return s;
}
async function makeToken(st, u) {
  const payload = `${u.lower}.${u.ver}.${now() + 30 * 24 * 3600 * 1000}`;
  const sig = P.hmac(await secret(st), payload);
  return `${payload}.${sig}`;
}
async function readToken(st, req) {
  const h = req.headers.get("authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const parts = t.split(".");
  if (parts.length !== 4) return null;
  const [lower, ver, exp, sig] = parts;
  const good = P.hmac(await secret(st), `${lower}.${ver}.${exp}`);
  if (!P.safeEq(sig, good)) return null;
  if (Number(exp) < now()) return null;
  const u = await getUser(st, lower);
  if (!u || String(u.ver) !== ver) return null;
  return u;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lecture/écriture protégées : si deux actions touchent le même compte en même temps,
// la deuxième est refusée au lieu d'écraser la première (pas de double dépense).
async function getUser(st, lower) {
  const r = await st.getWithMetadata("users/" + lower, { type: "json" });
  if (!r || !r.data) return null;
  Object.defineProperty(r.data, "_etag", { value: r.etag, writable: true, enumerable: false });
  return r.data;
}
async function saveUser(st, u) {
  const res = await st.setJSON("users/" + u.lower, u, u._etag ? { onlyIfMatch: u._etag } : { onlyIfNew: true });
  if (res && res.modified === false) fail(409, "Une autre action est en cours sur ce compte, réessaie.");
  if (Object.getOwnPropertyDescriptor(u, "_etag")) u._etag = res && res.etag;
  else Object.defineProperty(u, "_etag", { value: res && res.etag, writable: true, enumerable: false });
}
// Relit et modifie un compte en réessayant si quelqu'un d'autre l'a modifié entre-temps
async function mutateUser(st, lower, fn) {
  for (let i = 0; i < 8; i++) {
    const u = await getUser(st, lower);
    if (!u) return null;
    const out = fn(u);
    try { await saveUser(st, u); return { u, out }; }
    catch (e) { if (!(e instanceof HttpErr) || e.status !== 409) throw e; await sleep(20 + P.randInt(0, 80)); }
  }
  fail(503, "Le serveur est occupé, réessaie dans un instant.");
}
// Même chose pour un document partagé (fil des gros gains)
function noStock(me, spin) {
  spin.choice = "nostock";
  spin.refund = Math.ceil(spin.value * EXCHANGE_MARKUP);
  me.coins += spin.refund;
  log(me, "choice", `n'a pas pu récupérer ${spin.prizeName} (pas en stock) et reçoit ${coinsTxt(spin.refund)} · ${spin.id}`);
}
async function getCustom(st) {
  const d = await st.get("config/custom", { type: "json" });
  return (d && d.list) || [];
}
async function mutateDoc(st, key, init, fn) {
  for (let i = 0; i < 8; i++) {
    const r = await st.getWithMetadata(key, { type: "json" });
    const data = r && r.data ? r.data : init();
    const out = fn(data);
    const res = await st.setJSON(key, data, r && r.data ? { onlyIfMatch: r.etag } : { onlyIfNew: true });
    if (!res || res.modified !== false) return out;
    await sleep(20 + P.randInt(0, 80));
  }
  fail(503, "Le serveur est occupé, réessaie dans un instant.");
}

function newUser(pseudo, pass, owner) {
  const salt = P.randHex(16);
  return {
    pseudo, lower: pseudo.toLowerCase(), salt, hash: hashPw(pass, salt),
    owner: !!owner, mustChange: !!owner, coins: START, ver: 1,
    carts: [], spins: [], logs: [], ips: [], ban: null, createdAt: now(),
  };
}

function log(u, type, text, by) {
  u.logs = u.logs || [];
  u.logs.unshift({ type, text, by: by || u.pseudo, at: now() });
  if (u.logs.length > 300) u.logs.length = 300;
}
function coinsTxt(n) { return `${Number(n).toLocaleString("fr-FR")} coin${n > 1 ? "s" : ""}`; }
const DEFAULT_DISCORD = "https://discord.gg/nv4fSg3a6";
async function getDiscord(st) { const d = await st.get("config/discord", { type: "json" }); return (d && d.url) || DEFAULT_DISCORD; }
async function getClosed(st) { return st.get("config/closed", { type: "json" }); }
function activeBan(u) { return u.ban && (!u.ban.until || u.ban.until > now()) ? u.ban : null; }
function rememberIp(u, ipHash) {
  if (!ipHash) return;
  u.ips = [ipHash, ...(u.ips || []).filter((x) => x !== ipHash)].slice(0, 5);
}
async function ipBan(st, ipHash) {
  if (!ipHash) return null;
  const b = await st.get("ipban/" + ipHash, { type: "json" });
  return b && (!b.until || b.until > now()) ? b : null;
}

function mine(u) {
  return {
    pseudo: u.pseudo, owner: !!u.owner, mustChange: !!u.mustChange, coins: u.coins,
    carts: (u.carts || []).slice(0, 50), spins: (u.spins || []).slice(0, 100), ban: activeBan(u),
    dailyAt: u.dailyAt || 0, orders: (u.orders || []).slice(0, 50),
  };
}
function adminView(u) {
  return {
    pseudo: u.pseudo, owner: !!u.owner, coins: u.coins, createdAt: u.createdAt,
    carts: (u.carts || []).slice(0, 100), spins: (u.spins || []).slice(0, 200), orders: (u.orders || []).slice(0, 100),
    ban: activeBan(u), logs: (u.logs || []).slice(0, 150),
  };
}

function roll(box) {
  const r = P.randInt(0, 100000) / 1000; // 0 à 99,999
  let acc = 0;
  for (const l of box.loot) { acc += l.chance; if (r < acc) return l; }
  return box.loot[box.loot.length - 1];
}

const PSEUDO_RE = /^[A-Za-z0-9_]{3,16}$/;

// ---------- Actions ----------
async function ensureOwner(st, lower) {
  if (!OWNERS[lower]) return null;
  let u = await getUser(st, lower);
  if (!u) { u = newUser(OWNERS[lower], DEFAULT_PASSWORD, true); log(u, "owner_created", "compte owner créé"); await saveUser(st, u); }
  return u;
}

function requireReady(u) {
  const b = activeBan(u);
  if (b) fail(403, "Tu es banni du casino.", { ban: b });
  if (u.mustChange) fail(403, "Change ton mot de passe avant de jouer.");
}

async function targetOf(st, body) {
  const lower = String(body.pseudo || "").trim().toLowerCase();
  const t = lower && await getUser(st, lower);
  if (!t) fail(404, "Aucun joueur avec ce pseudo.");
  return t;
}

const routes = {
  "GET catalog": async ({ st }) => ({
    closed: await getClosed(st),
    discord: await getDiscord(st),
    start: START, bonus: BONUS, markup: EXCHANGE_MARKUP,
    brainrots: Object.entries(BRAINROTS).map(([k, b]) => ({ k, name: b.name, price: b.price, hidden: !!b.hidden })),
    choices: Object.entries(CHOICES).map(([k, g]) => ({ k, name: g.name, label: g.label, note: g.note,
      options: Object.entries(g.options).map(([v, o]) => ({ v, name: o.name, full: fullName(g, o), price: o.price, estimate: !!o.estimate })) })),
    boxes: BOXES,
  }),

  "POST signup": async ({ st, body, ipHash }) => {
    const pseudo = String(body.pseudo || "").trim(), pass = String(body.pass || "");
    if (!PSEUDO_RE.test(pseudo)) fail(400, "Le pseudo doit faire 3 à 16 caractères (lettres, chiffres ou _).");
    if (OWNERS[pseudo.toLowerCase()]) fail(400, "Ce pseudo est réservé aux owners du site.");
    if (pass.length < 4) fail(400, "Le mot de passe doit faire au moins 4 caractères.");
    const ib = await ipBan(st, ipHash);
    if (ib) fail(403, "Impossible de créer un compte : cette connexion est bannie du casino.", { ban: ib });
    if (await getUser(st, pseudo.toLowerCase())) fail(409, "Ce pseudo est déjà pris, choisis-en un autre.");
    const u = newUser(pseudo, pass, false);
    rememberIp(u, ipHash);
    log(u, "signup", "a créé son compte");
    await saveUser(st, u);
    return { token: await makeToken(st, u), me: mine(u) };
  },

  "POST login": async ({ st, body, ipHash }) => {
    const lower = String(body.pseudo || "").trim().toLowerCase(), pass = String(body.pass || "");
    const u = (await ensureOwner(st, lower)) || (lower && await getUser(st, lower));
    if (!u || !checkPw(pass, u)) fail(401, "Pseudo ou mot de passe incorrect.");
    const closed = await getClosed(st);
    if (closed && !u.owner) fail(503, "Le casino est fermé.", { closed });
    rememberIp(u, ipHash);
    log(u, "login", "s'est connecté");
    await saveUser(st, u);
    return { token: await makeToken(st, u), me: mine(u) };
  },

  "GET me": async ({ st, me }) => ({ me: mine(me), closed: await getClosed(st) }),

  "POST changepw": async ({ st, me, body }) => {
    const pass = String(body.pass || "");
    if (pass.length < 4) fail(400, "Le mot de passe doit faire au moins 4 caractères.");
    if (pass === DEFAULT_PASSWORD) fail(400, "Il faut un mot de passe différent de 123.");
    me.salt = P.randHex(16);
    me.hash = hashPw(pass, me.salt);
    me.mustChange = false;
    me.ver = (me.ver || 1) + 1; // déconnecte les autres appareils
    log(me, "password", "a changé son mot de passe");
    await saveUser(st, me);
    return { token: await makeToken(st, me), me: mine(me) };
  },

  "POST cart": async ({ st, me, body }) => {
    requireReady(me);
    const items = [];
    for (const it of Array.isArray(body.items) ? body.items : []) {
      const qty = intIn(it.qty, 1, 999);
      if (!qty) continue;
      const b = BRAINROTS[it.k], g = CHOICES[it.k], o = g && g.options[it.v];
      let line = null;
      if (b && !b.hidden && !it.v) line = { k: it.k, name: b.name, qty, price: b.price };
      else if (o) line = { k: it.k, v: it.v, name: fullName(g, o), qty, price: o.price, estimate: !!o.estimate };
      if (line && !items.find((x) => x.k === line.k && x.v === line.v)) items.push(line);
    }
    if (!items.length) fail(400, "Ton panier est vide.");
    const total = items.reduce((s, i) => s + i.price * i.qty, 0);
    const estimate = items.some((i) => i.estimate);
    const cart = { id: randId("", 8), items, total, estimate, at: now(), validated: null };
    me.carts.unshift(cart);
    log(me, "cart", `a envoyé le panier #${cart.id} (${coinsTxt(total)}${estimate ? " + brainrot à estimer" : ""})`);
    await saveUser(st, me);
    return { cart, me: mine(me) };
  },

  "POST spin": async ({ st, me, body }) => {
    requireReady(me);
    const box = BOXES.find((b) => b.k === body.box);
    if (!box) fail(400, "Ce spin n'existe pas.");
    if (me.coins < box.cost) fail(400, `Il te faut ${coinsTxt(box.cost)} pour lancer ce spin.`);
    const win = roll(box), b = itemOf(win.k, win.v);
    let id; do { id = randId("S-", 6); } while (me.spins.some((s) => s.id === id));
    const spin = { id, box: box.k, boxName: box.name, cost: box.cost, prize: b.key, prizeName: b.name,
      rarity: win.rarity, value: b.price, at: now(), choice: null, refund: 0, delivered: null };
    me.coins -= box.cost;
    me.spins.unshift(spin);
    if (me.spins.length > 1000) me.spins.length = 1000;
    log(me, "spin", `a lancé ${box.name} (${coinsTxt(box.cost)}) et gagné ${b.name} · ${id}`);
    // Brainrot pas en stock chez les owners : on rembourse son prix exact dans l'échange (+30 %)
    const stock = (await st.get("config/stock", { type: "json" })) || {};
    if (!(stock[b.key] > 0)) noStock(me, spin);
    await saveUser(st, me);
    if (b.price >= BIG_WIN && !me.owner) await feedPush(st, me.pseudo, `a eu ${b.name} au ${box.name}`, b.price);
    return { spin, me: mine(me) };
  },

  "POST choose": async ({ st, me, body }) => {
    requireReady(me);
    const spin = me.spins.find((s) => s.id === body.spinId);
    if (!spin) fail(404, "Spin introuvable.");
    if (!spin.choice) {
      if (body.choice === "coins") {
        spin.choice = "coins";
        spin.refund = Math.round(spin.value * (1 + BONUS));
        me.coins += spin.refund;
        log(me, "choice", `a échangé ${spin.prizeName} contre ${coinsTxt(spin.refund)} · ${spin.id}`);
      } else if (body.choice === "claim") {
        // Réserve 1 exemplaire dans le stock des owners
        const reserved = await mutateDoc(st, "config/stock", () => ({}), (d) => {
          if (!(d[spin.prize] > 0)) return false;
          d[spin.prize] -= 1;
          return true;
        });
        if (reserved) {
          spin.choice = "claim";
          log(me, "choice", `a choisi de récupérer ${spin.prizeName} · ${spin.id}`);
        } else noStock(me, spin);
      } else fail(400, "Choix invalide.");
      try { await saveUser(st, me); }
      catch (e) {
        if (spin.choice === "claim") await mutateDoc(st, "config/stock", () => ({}), (d) => { d[spin.prize] = (d[spin.prize] || 0) + 1; });
        throw e;
      }
    }
    return { spin, me: mine(me) };
  },

  // ----- Admin (owners uniquement) -----
  "POST admin/find": async ({ st, body }) => ({ target: adminView(await targetOf(st, body)) }),

  "POST admin/add": async ({ st, me, body }) => {
    const t = await targetOf(st, body), n = intIn(body.n, 1, 10000000);
    if (!n) fail(400, "Entre un nombre de coins supérieur à 0.");
    t.coins += n;
    log(t, "admin_add", `a ajouté ${coinsTxt(n)} à ${t.pseudo}`, me.pseudo);
    await saveUser(st, t);
    return { target: adminView(t) };
  },

  "POST admin/setbal": async ({ st, me, body }) => {
    const t = await targetOf(st, body), n = intIn(body.n, 0, 100000000);
    if (n === null) fail(400, "Entre un solde de 0 ou plus.");
    const before = t.coins;
    t.coins = n;
    log(t, body.reset ? "admin_reset" : "admin_setbal",
      `${body.reset ? "a reset les coins de" : "a mis le solde de"} ${t.pseudo} à ${coinsTxt(n)} (avant : ${coinsTxt(before)})`, me.pseudo);
    await saveUser(st, t);
    return { target: adminView(t) };
  },

  "POST admin/validate": async ({ st, me, body }) => {
    const t = await targetOf(st, body), c = t.carts.find((x) => x.id === body.cartId);
    if (!c) fail(404, "Panier introuvable.");
    if (!c.validated) {
      c.validated = { by: me.pseudo, at: now() };
      t.coins += c.total;
      log(t, "admin_validate", `a validé le panier #${c.id} de ${t.pseudo} (+${coinsTxt(c.total)})`, me.pseudo);
      await saveUser(st, t);
    }
    return { target: adminView(t) };
  },

  "POST admin/deliver": async ({ st, me, body }) => {
    const t = await targetOf(st, body), s = t.spins.find((x) => x.id === body.spinId);
    if (!s) fail(404, "Spin introuvable.");
    if (s.choice !== "claim") fail(400, "Le joueur n'a pas choisi de récupérer ce brainrot.");
    if (!s.delivered) {
      s.delivered = { by: me.pseudo, at: now() };
      log(t, "admin_deliver", `a donné ${s.prizeName} à ${t.pseudo} · ${s.id}`, me.pseudo);
      await saveUser(st, t);
    }
    return { target: adminView(t) };
  },

  // Cherche un code de panier ou un ID de spin chez tous les joueurs
  "POST admin/lookup": async ({ st, body }) => {
    const code = String(body.code || "").trim().toUpperCase().replace(/^#/, "");
    if (!/^([SE]-)?[A-Z0-9]{6,8}$/.test(code)) fail(400, "Entre un code de panier (ex. #K7PQ2M9X), un ID de spin (ex. S-4KD9QZ) ou d'échange (ex. E-7HQ2KD).");
    const spinId = code.startsWith("S-") ? code : "S-" + code;
    const { blobs } = await st.list({ prefix: "users/" });
    for (const b of blobs) {
      const u = await st.get(b.key, { type: "json" });
      if (!u) continue;
      const c = (u.carts || []).find((x) => x.id === code);
      if (c) return { kind: "cart", id: c.id, target: adminView(u) };
      const s = (u.spins || []).find((x) => x.id === spinId || x.id === code);
      if (s) return { kind: "spin", id: s.id, target: adminView(u) };
      const o = (u.orders || []).find((x) => x.id === code);
      if (o) return { kind: "order", id: o.id, target: adminView(u) };
    }
    fail(404, "Aucun panier ni spin avec ce code.");
  },

  "POST admin/deletecart": async ({ st, me, body }) => {
    const t = await targetOf(st, body), i = t.carts.findIndex((x) => x.id === body.cartId);
    if (i < 0) fail(404, "Panier introuvable.");
    const c = t.carts[i];
    t.carts.splice(i, 1);
    log(t, "admin_deletecart", `a supprimé le panier #${c.id} de ${t.pseudo} (${coinsTxt(c.total)}, ${c.validated ? "déjà validé" : "en attente"})`, me.pseudo);
    await saveUser(st, t);
    return { target: adminView(t), wasValidated: !!c.validated, total: c.total };
  },

  "POST admin/deliverorder": async ({ st, me, body }) => {
    const t = await targetOf(st, body), o = (t.orders || []).find((x) => x.id === body.orderId);
    if (!o) fail(404, "Échange introuvable.");
    if (!o.delivered) {
      o.delivered = { by: me.pseudo, at: now() };
      log(t, "admin_deliver", `a donné ${o.name} à ${t.pseudo} (échange ${o.id})`, me.pseudo);
      await saveUser(st, t);
    }
    return { target: adminView(t) };
  },

  "POST admin/ban": async ({ st, me, body }) => {
    const t = await targetOf(st, body);
    if (t.owner) fail(400, "Tu ne peux pas bannir un owner.");
    const reason = String(body.reason || "").trim().slice(0, 120);
    if (!reason) fail(400, "Écris une raison pour le bannissement.");
    const dur = intIn(body.dur, 0, 10 * 365 * 24 * 3600 * 1000);
    if (dur === null) fail(400, "Durée invalide.");
    const ban = { reason, until: dur ? now() + dur : null, by: me.pseudo, at: now() };
    t.ban = ban;
    for (const ip of t.ips || []) await st.setJSON("ipban/" + ip, { lower: t.lower, until: ban.until, reason, by: me.pseudo, at: ban.at });
    log(t, "admin_ban", `a banni ${t.pseudo} (${ban.until ? "jusqu'au " + new Date(ban.until).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) : "permanent"}) · raison : ${reason}`, me.pseudo);
    await saveUser(st, t);
    return { target: adminView(t) };
  },

  "POST admin/unban": async ({ st, me, body }) => {
    const t = await targetOf(st, body);
    t.ban = null;
    for (const ip of t.ips || []) {
      const b = await st.get("ipban/" + ip, { type: "json" });
      if (b && b.lower === t.lower) await st.delete("ipban/" + ip);
    }
    log(t, "admin_unban", `a débanni ${t.pseudo}`, me.pseudo);
    await saveUser(st, t);
    return { target: adminView(t) };
  },

  "POST admin/close": async ({ st, me, body }) => {
    if (String(body.password || "") !== CLOSE_PASSWORD) fail(403, "Mot de passe de fermeture incorrect.");
    const reason = String(body.reason || "").trim().slice(0, 200);
    if (!reason) fail(400, "Écris une raison pour la fermeture.");
    const closed = { reason, by: me.pseudo, at: now() };
    await st.setJSON("config/closed", closed);
    log(me, "admin_close", `a fermé le site · raison : ${reason}`);
    await saveUser(st, me);
    return { closed };
  },

  "POST admin/open": async ({ st, me, body }) => {
    if (String(body.password || "") !== CLOSE_PASSWORD) fail(403, "Mot de passe de fermeture incorrect.");
    await st.delete("config/closed");
    log(me, "admin_open", "a rouvert le site");
    await saveUser(st, me);
    return { closed: null };
  },

  "GET admin/logs": async ({ st }) => {
    const { blobs } = await st.list({ prefix: "users/" });
    const users = await Promise.all(blobs.map((b) => st.get(b.key, { type: "json" })));
    const all = users.filter(Boolean).flatMap((u) => (u.logs || []).slice(0, 60).map((l) => ({ ...l, who: u.pseudo })));
    all.sort((a, b) => b.at - a.at);
    return { logs: all.slice(0, 200) };
  },
};

// ====================== JEUX ======================
// Tous les tirages sont faits ici. Chaque jeu contre le casino rend en moyenne
// 94 à 97 % des mises, pour que personne ne puisse créer des coins à l'infini.
const MIN_BET = 1, MAX_BET = 20000;
const BIG_WIN = 500;          // un gain à partir de ce montant apparaît dans le fil des gros gains
const DAILY_REWARD = 5;
const EXCHANGE_MARKUP = 1.3;  // échange direct coins → brainrot : 30 % plus cher que la valeur des paniers       // récompense quotidienne
const DAILY_COOLDOWN = 20 * 3600 * 1000;
const GAME_NAMES = {
  coinflip: "Pile ou face", crash: "Crash", mines: "Mines", plinko: "Plinko", slots: "Machine à sous",
  roulette: "Roulette", blackjack: "Blackjack", race: "Course de brainrots",
};
const rnd = () => P.randInt(0, 1000000000) / 1000000000; // [0, 1)

// La mise peut être un brainrot (body.item = "garamacolor:lava") : elle vaut alors sa valeur en coins
function betOf(body, me) {
  // Les jeux se jouent uniquement avec des coins
  if (body.item) fail(400, "Tu ne peux miser que des coins.");
  const b = intIn(body.bet, MIN_BET, MAX_BET);
  if (!b) fail(400, `La mise doit être entre ${MIN_BET} et ${coinsTxt(MAX_BET)}.`);
  if (me.coins < b) fail(400, "Tu n'as pas assez de coins pour cette mise.");
  return b;
}
function gameLog(u, game, bet, payout, detail) {
  const res = payout > bet ? `gagné ${coinsTxt(payout)}` : payout > 0 ? `récupéré ${coinsTxt(payout)}` : "perdu";
  log(u, "game", `${GAME_NAMES[game]} : mise ${coinsTxt(bet)}, ${res}${detail ? " · " + detail : ""}`);
}
async function feedPush(st, pseudo, text, amount) {
  try {
    await mutateDoc(st, "feed", () => ({ list: [] }), (f) => {
      f.list.unshift({ pseudo, text, amount, at: now() });
      if (f.list.length > 20) f.list.length = 20;
    });
  } catch { /* le fil n'est pas critique */ }
}
async function finishSolo(st, me, game, bet, payout, detail) {
  gameLog(me, game, bet, payout, detail);
  await saveUser(st, me);
  if (payout >= BIG_WIN && payout > bet && !me.owner) await feedPush(st, me.pseudo, `a gagné ${coinsTxt(payout)} au ${GAME_NAMES[game]}`, payout);
}
const games = (u) => (u.game = u.game || {});
// Prochains résultats tirés à l'avance (même hasard), pour la vue spéciale de Boruteo
const DRAW = {
  coinflip: () => (rnd() < 0.5 ? "pile" : "face"),
  race: () => RACERS[P.randInt(0, RACERS.length)],
};
function peekNext(u, k) { const n = (games(u).next = games(u).next || {}); if (!(k in n)) n[k] = DRAW[k](); return n[k]; }
function takeNext(u, k) { const v = peekNext(u, k); games(u).next[k] = DRAW[k](); return v; }
const PEEK_USER = "boruteo";

// ---------- Crash ----------
const CRASH_SPEED = 0.07; // multiplicateur = e^(0,07 × secondes)
const crashMult = (g) => Math.floor(Math.exp(CRASH_SPEED * Math.max(0, now() - g.start) / 1000) * 100) / 100;
function crashPoint() { return Math.min(1000, Math.max(1, Math.floor(96 / (1 - rnd())) / 100)); }

// ---------- Mines ----------
const MINES_COUNT = 4;  // toujours 4 bombes
function minesMult(mines, k) {
  let m = 0.96;
  for (let i = 0; i < k; i++) m *= (25 - i) / (25 - mines - i);
  return Math.floor(m * 100) / 100;
}
function minesView(g) {
  return g ? { bet: g.bet, mines: g.mines, revealed: g.revealed, mult: g.revealed.length ? minesMult(g.mines, g.revealed.length) : 0,
    next: g.revealed.length < 25 - g.mines ? minesMult(g.mines, g.revealed.length + 1) : null } : null;
}

// ---------- Plinko ----------
const PLINKO_ROWS = 12;
const PLINKO_MULTS = [13, 6, 2, 1.4, 1.1, 0.85, 0.5, 0.85, 1.1, 1.4, 2, 6, 13];

// ---------- Machine à sous ----------
const SLOT_SYMBOLS = [
  { k: "esok", w: 30, x3: 5 }, { k: "nuclearo", w: 25, x3: 8 }, { k: "puggy", w: 20, x3: 12 },
  { k: "garama", w: 13, x3: 30 }, { k: "cerberus", w: 8, x3: 80 }, { k: "skibidi", w: 4, x3: 500 },
];
const SLOT_TWO = 2.8; // les 2 premiers rouleaux identiques
function slotRoll() {
  let r = rnd() * 100;
  for (const s of SLOT_SYMBOLS) { if (r < s.w) return s.k; r -= s.w; }
  return SLOT_SYMBOLS[0].k;
}

// ---------- Roulette (européenne, 37 cases) ----------
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const ROULETTE_BETS = {
  red: { name: "Rouge", mult: 2, win: (n) => RED.has(n) },
  black: { name: "Noir", mult: 2, win: (n) => n > 0 && !RED.has(n) },
  even: { name: "Pair", mult: 2, win: (n) => n > 0 && n % 2 === 0 },
  odd: { name: "Impair", mult: 2, win: (n) => n % 2 === 1 },
  low: { name: "1 à 18", mult: 2, win: (n) => n >= 1 && n <= 18 },
  high: { name: "19 à 36", mult: 2, win: (n) => n >= 19 },
  d1: { name: "1re douzaine", mult: 3, win: (n) => n >= 1 && n <= 12 },
  d2: { name: "2e douzaine", mult: 3, win: (n) => n >= 13 && n <= 24 },
  d3: { name: "3e douzaine", mult: 3, win: (n) => n >= 25 },
};

// ---------- Blackjack (cartes tirées au hasard, croupier reste à 17) ----------
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"], SUITS = ["♠", "♥", "♦", "♣"];
const drawCard = () => ({ r: RANKS[P.randInt(0, 13)], s: SUITS[P.randInt(0, 4)] });
function handValue(cards) {
  let t = 0, aces = 0;
  for (const c of cards) { if (c.r === "A") { aces++; t += 11; } else t += ["J", "Q", "K"].includes(c.r) ? 10 : Number(c.r); }
  while (t > 21 && aces) { t -= 10; aces--; }
  return t;
}
const isBJ = (cards) => cards.length === 2 && handValue(cards) === 21;
function bjView(g, done) {
  return { bet: g.bet, player: g.player, playerValue: handValue(g.player),
    dealer: done ? g.dealer : [g.dealer[0]], dealerValue: done ? handValue(g.dealer) : handValue([g.dealer[0]]),
    canDouble: g.player.length === 2 && !g.doubled, done: !!done };
}
async function bjFinish(st, me, g) {
  while (handValue(g.dealer) < 17) g.dealer.push(drawCard());
  const p = handValue(g.player), d = handValue(g.dealer);
  let payout = 0, result;
  if (p > 21) result = "bust";
  else if (d > 21 || p > d) { result = "win"; payout = g.bet * 2; }
  else if (p === d) { result = "push"; payout = g.bet; }
  else result = "lose";
  me.coins += payout;
  delete games(me).bj;
  await finishSolo(st, me, "blackjack", g.bet, payout, `toi ${p}, croupier ${d}`);
  return { ...bjView(g, true), result, payout, me: mine(me) };
}

// ---------- Course de brainrots ----------
const RACERS = ["nuclearo", "puggy", "garama", "cerberus", "lavadorito"];
const RACE_MULT = 4.75; // 5 coureurs, paie x4,75

const GAME_ROUTES = {
  "GET games/info": async () => ({
    minBet: MIN_BET, maxBet: MAX_BET, daily: DAILY_REWARD, dailyCooldown: DAILY_COOLDOWN,
    crashSpeed: CRASH_SPEED, plinkoRows: PLINKO_ROWS, plinkoMults: PLINKO_MULTS,
    slots: SLOT_SYMBOLS, slotTwo: SLOT_TWO, roulette: Object.entries(ROULETTE_BETS).map(([k, b]) => ({ k, name: b.name, mult: b.mult })),
    red: [...RED], racers: RACERS, raceMult: RACE_MULT,
  }),

  // ----- Pile ou face -----
  "POST game/coinflip": async ({ st, me, body }) => {
    requireReady(me);
    const bet = betOf(body, me), pick = body.pick === "face" ? "face" : "pile";
    const result = takeNext(me, "coinflip");
    const payout = result === pick ? Math.floor(bet * 1.95) : 0;
    me.coins += payout - bet;
    await finishSolo(st, me, "coinflip", bet, payout, `${pick} → ${result}`);
    return { result, payout, me: mine(me) };
  },

  // ----- Crash -----
  "POST game/crash/start": async ({ st, me, body }) => {
    requireReady(me);
    const old = games(me).crash;
    if (old && crashMult(old) < old.point) fail(400, "Tu as déjà une partie de Crash en cours.");
    if (old) { gameLog(me, "crash", old.bet, 0, `crash à x${old.point}`); delete games(me).crash; }
    const bet = betOf(body, me);
    me.coins -= bet;
    games(me).crash = { bet, start: now(), point: crashPoint() };
    await saveUser(st, me);
    return { bet, me: mine(me) };
  },
  "POST game/crash/status": async ({ st, me }) => {
    const g = games(me).crash;
    if (!g) return { idle: true };
    const m = crashMult(g);
    if (m >= g.point) {
      delete games(me).crash;
      await finishSolo(st, me, "crash", g.bet, 0, `crash à x${g.point}`);
      return { crashed: true, point: g.point, me: mine(me) };
    }
    return { running: true, mult: m, elapsed: now() - g.start, bet: g.bet };
  },
  "POST game/crash/cashout": async ({ st, me }) => {
    requireReady(me);
    const g = games(me).crash;
    if (!g) fail(400, "Pas de partie de Crash en cours.");
    const m = crashMult(g);
    delete games(me).crash;
    if (m >= g.point) {
      await finishSolo(st, me, "crash", g.bet, 0, `crash à x${g.point}`);
      return { crashed: true, point: g.point, me: mine(me) };
    }
    const payout = Math.floor(g.bet * m);
    me.coins += payout;
    await finishSolo(st, me, "crash", g.bet, payout, `encaissé à x${m} (crash à x${g.point})`);
    return { cashed: true, mult: m, point: g.point, payout, me: mine(me) };
  },

  // ----- Mines -----
  "GET game/mines": async ({ me }) => ({ game: minesView(games(me).mines) }),
  "POST game/mines/start": async ({ st, me, body }) => {
    requireReady(me);
    if (games(me).mines) fail(400, "Tu as déjà une partie de Mines en cours.");
    const mines = MINES_COUNT;
    const bet = betOf(body, me);
    const cells = [...Array(25).keys()];
    for (let i = 24; i > 0; i--) { const j = P.randInt(0, i + 1); [cells[i], cells[j]] = [cells[j], cells[i]]; }
    me.coins -= bet;
    games(me).mines = { bet, mines, bombs: cells.slice(0, mines), revealed: [] };
    await saveUser(st, me);
    return { game: minesView(games(me).mines), me: mine(me) };
  },
  "POST game/mines/reveal": async ({ st, me, body }) => {
    requireReady(me);
    const g = games(me).mines;
    if (!g) fail(400, "Pas de partie de Mines en cours.");
    const cell = intIn(body.cell, 0, 24);
    if (cell === null) fail(400, "Case invalide.");
    if (g.revealed.includes(cell)) return { game: minesView(g), me: mine(me) };
    if (g.bombs.includes(cell)) {
      delete games(me).mines;
      await finishSolo(st, me, "mines", g.bet, 0, `${g.mines} mine(s), bombe après ${g.revealed.length} case(s)`);
      return { boom: true, cell, bombs: g.bombs, revealed: g.revealed, me: mine(me) };
    }
    g.revealed.push(cell);
    if (g.revealed.length === 25 - g.mines) {
      const mult = minesMult(g.mines, g.revealed.length), payout = Math.floor(g.bet * mult);
      me.coins += payout;
      delete games(me).mines;
      await finishSolo(st, me, "mines", g.bet, payout, `${g.mines} mine(s), toutes les cases (x${mult})`);
      return { cleared: true, payout, mult, bombs: g.bombs, revealed: g.revealed, me: mine(me) };
    }
    await saveUser(st, me);
    return { game: minesView(g), me: mine(me) };
  },
  "POST game/mines/cashout": async ({ st, me }) => {
    requireReady(me);
    const g = games(me).mines;
    if (!g) fail(400, "Pas de partie de Mines en cours.");
    if (!g.revealed.length) fail(400, "Retourne au moins une case avant d'encaisser.");
    const mult = minesMult(g.mines, g.revealed.length), payout = Math.floor(g.bet * mult);
    me.coins += payout;
    delete games(me).mines;
    await finishSolo(st, me, "mines", g.bet, payout, `${g.mines} mine(s), ${g.revealed.length} case(s), x${mult}`);
    return { payout, mult, bombs: g.bombs, revealed: g.revealed, me: mine(me) };
  },

  // ----- Plinko -----
  "POST game/plinko": async ({ st, me, body }) => {
    requireReady(me);
    const bet = betOf(body, me);
    const path = Array.from({ length: PLINKO_ROWS }, () => (rnd() < 0.5 ? 0 : 1));
    const slot = path.reduce((a, b) => a + b, 0), mult = PLINKO_MULTS[slot];
    const payout = Math.floor(bet * mult);
    me.coins += payout - bet;
    await finishSolo(st, me, "plinko", bet, payout, `x${mult}`);
    return { path, slot, mult, payout, me: mine(me) };
  },

  // ----- Machine à sous -----
  "POST game/slots": async ({ st, me, body }) => {
    requireReady(me);
    const bet = betOf(body, me);
    const reels = [slotRoll(), slotRoll(), slotRoll()];
    let mult = 0;
    if (reels[0] === reels[1] && reels[1] === reels[2]) mult = SLOT_SYMBOLS.find((s) => s.k === reels[0]).x3;
    else if (reels[0] === reels[1]) mult = SLOT_TWO;
    const payout = Math.floor(bet * mult);
    me.coins += payout - bet;
    await finishSolo(st, me, "slots", bet, payout, mult ? `x${mult}` : "");
    return { reels, mult, payout, me: mine(me) };
  },

  // ----- Roulette -----
  "POST game/roulette": async ({ st, me, body }) => {
    requireReady(me);
    const bet = betOf(body, me);
    let type, mult, win, label;
    if (body.type === "number") {
      const n = intIn(body.number, 0, 36);
      if (n === null) fail(400, "Choisis un numéro entre 0 et 36.");
      mult = 36; win = (x) => x === n; label = `numéro ${n}`; type = "number";
    } else {
      const b = ROULETTE_BETS[body.type];
      if (!b) fail(400, "Choisis sur quoi tu paries.");
      mult = b.mult; win = b.win; label = b.name; type = body.type;
    }
    const n = P.randInt(0, 37);
    const payout = win(n) ? bet * mult : 0;
    me.coins += payout - bet;
    await finishSolo(st, me, "roulette", bet, payout, `${label} → ${n}`);
    return { number: n, color: n === 0 ? "green" : RED.has(n) ? "red" : "black", payout, type, me: mine(me) };
  },

  // ----- Blackjack -----
  "GET game/blackjack": async ({ me }) => ({ game: games(me).bj ? bjView(games(me).bj, false) : null }),
  "POST game/blackjack/start": async ({ st, me, body }) => {
    requireReady(me);
    if (games(me).bj) fail(400, "Tu as déjà une partie de Blackjack en cours.");
    const bet = betOf(body, me);
    me.coins -= bet;
    const g = { bet, player: [drawCard(), drawCard()], dealer: [drawCard(), drawCard()], doubled: false };
    if (isBJ(g.player) || isBJ(g.dealer)) {
      let payout = 0, result = "dealerbj";
      if (isBJ(g.player) && isBJ(g.dealer)) { payout = bet; result = "push"; }
      else if (isBJ(g.player)) { payout = Math.floor(bet * 2.5); result = "blackjack"; }
      me.coins += payout;
      await finishSolo(st, me, "blackjack", bet, payout, result === "blackjack" ? "Blackjack !" : "Blackjack du croupier");
      return { ...bjView(g, true), result, payout, me: mine(me) };
    }
    games(me).bj = g;
    await saveUser(st, me);
    return { ...bjView(g, false), me: mine(me) };
  },
  "POST game/blackjack/action": async ({ st, me, body }) => {
    requireReady(me);
    const g = games(me).bj;
    if (!g) fail(400, "Pas de partie de Blackjack en cours.");
    if (body.action === "hit") {
      g.player.push(drawCard());
      if (handValue(g.player) > 21) {
        delete games(me).bj;
        await finishSolo(st, me, "blackjack", g.bet, 0, `toi ${handValue(g.player)} (perdu)`);
        return { ...bjView(g, true), result: "bust", payout: 0, me: mine(me) };
      }
      if (handValue(g.player) === 21) return bjFinish(st, me, g);
      await saveUser(st, me);
      return { ...bjView(g, false), me: mine(me) };
    }
    if (body.action === "double") {
      if (g.player.length !== 2 || g.doubled) fail(400, "Tu ne peux doubler qu'avec tes 2 premières cartes.");
      if (me.coins < g.bet) fail(400, "Pas assez de coins pour doubler.");
      me.coins -= g.bet; g.bet *= 2; g.doubled = true;
      g.player.push(drawCard());
      return bjFinish(st, me, g);
    }
    if (body.action === "stand") return bjFinish(st, me, g);
    fail(400, "Action inconnue.");
  },

  // ----- Course de brainrots -----
  "POST game/race": async ({ st, me, body }) => {
    requireReady(me);
    const bet = betOf(body, me);
    if (!RACERS.includes(body.pick)) fail(400, "Choisis ton brainrot.");
    const winner = takeNext(me, "race");
    const payout = winner === body.pick ? Math.floor(bet * RACE_MULT) : 0;
    me.coins += payout - bet;
    await finishSolo(st, me, "race", bet, payout, `${BRAINROTS[body.pick].name} → gagnant ${BRAINROTS[winner].name}`);
    return { winner, payout, me: mine(me) };
  },

  // ----- Récompense quotidienne, classement, fil des gros gains -----
  // Vue spéciale réservée à Boruteo : bombes des Mines, prochain pile ou face, prochain gagnant de la course
  "GET admin/peek": async ({ st, me }) => {
    if (me.lower !== PEEK_USER) fail(403, "Réservé.");
    const had = games(me).next || {};
    const fresh = !("coinflip" in had) || !("race" in had);
    const coinflip = peekNext(me, "coinflip"), race = peekNext(me, "race");
    if (fresh) await saveUser(st, me);
    const m = games(me).mines;
    return { coinflip, race, raceName: BRAINROTS[race].name, mines: m ? { bombs: m.bombs, revealed: m.revealed, bet: m.bet } : null };
  },

  "POST daily": async ({ st, me }) => {
    requireReady(me);
    const left = (me.dailyAt || 0) + DAILY_COOLDOWN - now();
    if (left > 0) fail(400, `Reviens dans ${Math.ceil(left / 3600000)} h pour ta prochaine récompense.`);
    me.dailyAt = now();
    me.coins += DAILY_REWARD;
    log(me, "daily", `a récupéré sa récompense quotidienne (${coinsTxt(DAILY_REWARD)})`);
    await saveUser(st, me);
    return { reward: DAILY_REWARD, me: mine(me) };
  },
  // ----- Échange direct : acheter un brainrot avec ses coins -----
  "POST buy": async ({ st, me, body }) => {
    requireReady(me);
    const [k, v] = String(body.item || "").split(":");
    let it, price;
    if (k === "custom") {
      // Brainrot personnalisé ajouté par un owner : son prix est déjà le prix d'échange
      const c = (await getCustom(st)).find((x) => x.id === v);
      if (!c) fail(400, "Ce brainrot n'est plus disponible à l'échange.");
      it = { key: `custom:${c.id}`, name: c.name + (c.ps ? ` (${c.ps})` : ""), price: c.price };
      price = c.price;
    } else {
      it = itemOf(k, v);
      if (!it || it.estimate || !it.price || (!v && BRAINROTS[k] && BRAINROTS[k].hidden)) fail(400, "Ce brainrot n'est pas disponible à l'échange.");
      price = Math.ceil(it.price * EXCHANGE_MARKUP);
    }
    if (me.coins < price) fail(400, `Il te faut ${coinsTxt(price)} pour échanger ce brainrot.`);
    // Réserve 1 exemplaire dans le stock des owners
    const reserved = await mutateDoc(st, "config/stock", () => ({}), (d) => {
      if (!(d[it.key] > 0)) return false;
      d[it.key] -= 1;
      return true;
    });
    if (!reserved) fail(400, `${it.name} est en rupture de stock. Reviens plus tard !`);
    me.orders = me.orders || [];
    let id; do { id = randId("E-", 6); } while (me.orders.some((o) => o.id === id));
    const order = { id, item: it.key, name: it.name, value: it.price, price, at: now(), delivered: null };
    me.coins -= price;
    me.orders.unshift(order);
    if (me.orders.length > 500) me.orders.length = 500;
    log(me, "buy", `a échangé ${coinsTxt(price)} contre ${it.name} · ${id}`);
    try { await saveUser(st, me); }
    catch (e) { await mutateDoc(st, "config/stock", () => ({}), (d) => { d[it.key] = (d[it.key] || 0) + 1; }); throw e; }
    return { order, me: mine(me) };
  },

  // ----- Stocks de l'échange direct -----
  // Lien d'invitation du serveur Discord affiché partout sur le site
  "POST admin/discord": async ({ st, me, body }) => {
    let url = String(body.url || "").trim();
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const m = url.match(/^https?:\/\/(?:www\.)?(discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/([A-Za-z0-9-]{2,40})\/?$/i);
    if (!m) fail(400, "Mets un lien d'invitation Discord valide, par exemple https://discord.gg/abc123.");
    url = "https://discord.gg/" + m[2];
    await st.setJSON("config/discord", { url, by: me.pseudo, at: now() });
    log(me, "admin_discord", `a changé le lien Discord en ${url}`);
    await saveUser(st, me);
    return { discord: url };
  },
  "GET stock": async ({ st }) => ({ stock: (await st.get("config/stock", { type: "json" })) || {}, custom: await getCustom(st) }),
  // Ajoute ou modifie un brainrot personnalisé (image, nom, prix, argent par seconde, stock)
  "POST admin/custom": async ({ st, me, body }) => {
    const name = String(body.name || "").trim().replace(/\s+/g, " ");
    const ps = String(body.ps || "").trim().replace(/\s+/g, " ");
    const price = intIn(body.price, 1, 100000000);
    const qty = intIn(body.qty ?? 0, 0, 99999);
    const img = body.img ? String(body.img) : "";
    if (name.length < 1 || name.length > 40) fail(400, "Le nom doit faire entre 1 et 40 caractères.");
    if (ps.length > 24) fail(400, "L'argent par seconde doit faire 24 caractères maximum.");
    if (price === null) fail(400, "Le prix doit être un nombre entier de coins (au moins 1).");
    if (qty === null) fail(400, "Le stock doit être un nombre entier entre 0 et 99 999.");
    if (img && (!/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > 200000)) fail(400, "Image invalide ou trop lourde.");
    const id = body.id ? String(body.id) : null;
    const saved = await mutateDoc(st, "config/custom", () => ({ list: [] }), (d) => {
      d.list = d.list || [];
      if (id) {
        const c = d.list.find((x) => x.id === id);
        if (!c) return null;
        Object.assign(c, { name, ps, price }, img ? { img } : {});
        return c;
      }
      if (!img) return "noimg";
      if (d.list.length >= 60) return "full";
      let nid; do { nid = "c" + P.randHex(4); } while (d.list.some((x) => x.id === nid));
      const c = { id: nid, name, ps, price, img, at: now(), by: me.pseudo };
      d.list.push(c);
      return c;
    });
    if (saved === "noimg") fail(400, "Ajoute une image pour ce brainrot.");
    if (saved === "full") fail(400, "Tu as déjà 60 brainrots personnalisés, supprimes-en un d'abord.");
    if (!saved) fail(404, "Ce brainrot personnalisé n'existe plus.");
    await mutateDoc(st, "config/stock", () => ({}), (d) => { d[`custom:${saved.id}`] = qty; });
    log(me, "admin_custom", `a ${id ? "modifié" : "ajouté"} le brainrot personnalisé ${saved.name} (${coinsTxt(price)}, stock ${qty})`);
    await saveUser(st, me);
    return { stock: (await st.get("config/stock", { type: "json" })) || {}, custom: await getCustom(st) };
  },
  "POST admin/customdel": async ({ st, me, body }) => {
    const id = String(body.id || "");
    const gone = await mutateDoc(st, "config/custom", () => ({ list: [] }), (d) => {
      d.list = d.list || [];
      const i = d.list.findIndex((x) => x.id === id);
      return i < 0 ? null : d.list.splice(i, 1)[0];
    });
    if (!gone) fail(404, "Ce brainrot personnalisé n'existe plus.");
    await mutateDoc(st, "config/stock", () => ({}), (d) => { delete d[`custom:${id}`]; });
    log(me, "admin_custom", `a supprimé le brainrot personnalisé ${gone.name}`);
    await saveUser(st, me);
    return { stock: (await st.get("config/stock", { type: "json" })) || {}, custom: await getCustom(st) };
  },
  "POST admin/stock": async ({ st, me, body }) => {
    const set = {}, customIds = new Set((await getCustom(st)).map((c) => c.id));
    for (const [key, val] of Object.entries(body.stock || {})) {
      const [k, v] = key.split(":");
      const n = intIn(val, 0, 99999);
      if (k === "custom") { if (customIds.has(v) && n !== null) set[key] = n; continue; }
      const it = itemOf(k, v);
      if (!it || it.estimate || !it.price || (!v && BRAINROTS[k] && BRAINROTS[k].hidden) || n === null) continue;
      set[it.key] = n;
    }
    const keys = Object.keys(set);
    if (!keys.length) fail(400, "Aucun stock valide à enregistrer.");
    await mutateDoc(st, "config/stock", () => ({}), (d) => { Object.assign(d, set); });
    log(me, "admin_stock", `a mis à jour le stock de ${keys.length} brainrot${keys.length > 1 ? "s" : ""}`);
    await saveUser(st, me);
    return { stock: (await st.get("config/stock", { type: "json" })) || {} };
  },

  "GET leaderboard": async ({ st }) => {
    const { blobs } = await st.list({ prefix: "users/" });
    const users = (await Promise.all(blobs.map((b) => st.get(b.key, { type: "json" })))).filter((u) => u && !u.owner);
    users.sort((a, b) => b.coins - a.coins);
    return { top: users.slice(0, 10).map((u) => ({ pseudo: u.pseudo, coins: u.coins })) };
  },
  "GET feed": async ({ st }) => ({ feed: ((await st.get("feed", { type: "json" })) || { list: [] }).list }),
};
Object.assign(routes, GAME_ROUTES);

const PUBLIC = new Set(["GET catalog", "GET games/info", "POST signup", "POST login"]);

async function handler(req, context) {
  try {
    const url = new URL(req.url);
    const action = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
    const key = `${req.method} ${action}`;
    const route = routes[key];
    if (!route) return json({ error: "Action inconnue." }, 404);
    const st = store();
    let body = {};
    if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }
    const ipHash = context && context.ip ? sha("brainrot-ip:" + context.ip) : null;
    let me = null;
    if (!PUBLIC.has(key)) {
      me = await readToken(st, req);
      if (!me) return json({ error: "Ta session a expiré, reconnecte-toi." }, 401);
      if (action.startsWith("admin/") && !me.owner) return json({ error: "Réservé aux owners." }, 403);
      // Site fermé : seuls les owners peuvent encore utiliser le casino
      if (!me.owner) {
        const closed = await getClosed(st);
        if (closed) return json({ error: "Le casino est fermé.", closed }, 503);
      }
    } else if (key === "POST signup") {
      const closed = await getClosed(st);
      if (closed) return json({ error: "Le casino est fermé.", closed }, 503);
    }
    return json(await route({ st, body, me, ipHash }));
  } catch (e) {
    if (e instanceof HttpErr) return json({ error: e.message, ...(e.extra || {}) }, e.status);
    console.error(e);
    return json({ error: "Erreur du serveur, réessaie dans un instant." }, 500);
  }
}




// ===== Le casino : un seul Durable Object qui garde toutes les données =====
export class Casino extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, ver INTEGER NOT NULL) WITHOUT ROWID");
  }
  async fetch(req) {
    SQL = this.sql;
    return handler(req, { ip: req.headers.get("cf-connecting-ip") || "" });
  }
}

// ===== Point d'entrée : /api/* va au casino, le reste est le site =====
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const stub = env.CASINO.get(env.CASINO.idFromName("casino"));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};
