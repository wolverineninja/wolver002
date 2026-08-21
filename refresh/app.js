"use strict";

/* Same template + render code as the local Refresher app; the only difference
   is the data layer: instead of a local Python backend at /api/*, this talks to
   the real admin API and holds per-visitor state (pile key, personal tokens) in
   localStorage. The render* functions below are byte-for-byte the local app's. */

const API = "https://admin.wolver002.com";
const $ = (s) => document.querySelector(s);
let last = null;
let skew = 0;
let keyShown = false;      // is the pile key revealed right now?
let keyValue = "";         // the revealed value while shown

/* ---------------- client state (persisted) ---------------- */
function jget(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
function sset(k, v) { try { v == null || v === "" ? localStorage.removeItem(k) : localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)); } catch (e) {} }

// The Key is persisted in a browser cookie (1 year) so it survives sessions.
function getCookie(name) {
  const m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/([.*+?^${}()|[\]\\])/g, "\\$1") + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}
function setCookie(name, val, days) {
  const base = name + "=" + encodeURIComponent(val || "") + "; path=/; SameSite=Lax";
  document.cookie = val ? (base + "; max-age=" + (days * 86400)) : (base + "; max-age=0");
}

// Cookie is the source of truth; fall back to the old localStorage value once.
let PILE_KEY = getCookie("wolver_key") || (function () { try { return localStorage.getItem("wolver_pile_key") || ""; } catch (e) { return ""; } })();
let SOURCE = (function () { try { return localStorage.getItem("wolver_source") || "pile"; } catch (e) { return "pile"; } })();
if (SOURCE !== "personal") SOURCE = "pile";
let PERSONAL = jget("wolver_personal", []);          // [{id, view_key, label, mask, account}]
let USE_ID = jget("wolver_use_id", null);
let ENABLED = jget("wolver_enabled", true);
let SEQ = jget("wolver_seq", 0);
let LAST_REFRESH = 0;
let LAST_ERROR = "";
let poll = null;

// Website account: register/login gives a stateless signed session (sent as
// X-Session). The account links a Discord, then mints ONE key tied to it.
let SESSION = (function () { try { return localStorage.getItem("wolver_account") || ""; } catch (e) { return ""; } })();
let ACCOUNT = null;   // {username, discord_linked, discord_name, discord_avatar, key} once loaded

// The Discord callback comes back with #linked=... — surface it, then clean the URL.
(function absorbHash() {
  const m = (location.hash || "").match(/[#&]linked=([^&]+)/);
  if (m) {
    const r = decodeURIComponent(m[1]);
    const msg = { "1": "Discord linked", taken: "That Discord is already linked to another account",
                  nologin: "Log in first, then link Discord", denied: "Discord link cancelled",
                  failed: "Discord link failed — try again" };
    setTimeout(() => toast(msg[r] || "Discord link failed", r !== "1"), 300);
    history.replaceState(null, "", location.pathname + location.search);
  }
})();

function saveState() {
  setCookie("wolver_key", PILE_KEY, 365);   // key -> browser cookie (1 year)
  sset("wolver_pile_key", PILE_KEY);         // keep a localStorage mirror too
  sset("wolver_source", SOURCE);
  sset("wolver_personal", PERSONAL);
  sset("wolver_use_id", USE_ID);
  sset("wolver_enabled", ENABLED);
  sset("wolver_seq", SEQ);
}
function maskKey(s) { if (!s) return ""; s = String(s); return s.length <= 13 ? s.slice(0, 6) + "..." : s.slice(0, 6) + "..." + s.slice(-4); }
function maskTok(s) { if (!s) return ""; s = String(s); return s.length <= 18 ? s.slice(0, 10) + "..." : s.slice(0, 10) + "..." + s.slice(-5); }

/* ---------------- net ---------------- */
function toast(msg, isErr) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), isErr ? 7000 : 4000);
}
function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }

/* ---------------- format ---------------- */
function fmtDur(sec) {
  if (sec == null) return "unknown";
  if (sec <= 0) return "expired";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
const STATUS_LABEL = { good: "usable", local: "not tested", untested: "untested", bad: "failed" };
function tagFor(status) { return `<span class="tag ${status}">${STATUS_LABEL[status] || status}</span>`; }

/* ---------------- account + Discord + key minting ---------------- */
function setSession(sess) { SESSION = sess || ""; try { sess ? localStorage.setItem("wolver_account", sess) : localStorage.removeItem("wolver_account"); } catch (e) {} }

async function loadAccount() {
  if (!SESSION) { ACCOUNT = null; return; }
  try {
    const r = await fetch(API + "/refresher/me", { headers: { "X-Session": SESSION } });
    if (r.status === 401) { ACCOUNT = null; setSession(""); return; }   // session no longer valid
    if (!r.ok) return;                                                  // transient: keep what we had
    ACCOUNT = await r.json();
    if (ACCOUNT.key) { PILE_KEY = ACCOUNT.key; saveState(); }           // the minted key drives the mod pull + status
  } catch (e) { /* keep last */ }
}
async function accountAuth(kind, username, password) {   // kind: "login" | "register"
  const r = await fetch(API + "/refresher/account/" + kind, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const j = await r.json().catch(() => ({ error: "HTTP " + r.status }));
  if (!r.ok || !j.session) throw new Error(j.error || ("HTTP " + r.status));
  setSession(j.session);
  ACCOUNT = j.account;
  if (ACCOUNT && ACCOUNT.key) { PILE_KEY = ACCOUNT.key; saveState(); }
}
async function genKey() {
  if (!SESSION) throw new Error("Log in first");
  const r = await fetch(API + "/refresher/key/mine", { method: "POST", headers: { "X-Session": SESSION } });
  const j = await r.json().catch(() => ({ error: "HTTP " + r.status }));
  if (!r.ok || !j.key) throw new Error(j.error || ("HTTP " + r.status));
  PILE_KEY = j.key; if (ACCOUNT) ACCOUNT.key = j.key; saveState();
}

/* ---------------- data layer: build the same status shape the render code expects ---------------- */
// One "Key" field, any key: an account-linked key resolves to that account and
// pulls it; a pile key draws a random account from the pool. KEY_KIND/KEY_NAME
// are remembered so the pull knows which endpoint to hit.
let KEY_KIND = "none", KEY_NAME = "";
async function checkKey() {
  if (!PILE_KEY) return { kind: "none", ok: false, pool: 0, status: "untested", detail: "", name: "" };
  try {
    const r = await fetch(API + "/refresher/public/checkkey", { headers: { "X-Refresher-Key": PILE_KEY } });
    const d = await r.json().catch(() => ({}));
    if (d.ok && d.account && d.account !== "master key") {
      const nm = d.name || d.account;
      return { kind: "account", ok: true, pool: 0, status: "good", detail: "account: " + nm, name: nm };
    }
  } catch (e) {}
  try {
    const r = await fetch(API + "/refresher/public/pile/checkkey", { headers: { "X-Pile-Key": PILE_KEY } });
    const d = await r.json().catch(() => ({}));
    if (d.ok) return { kind: "pile", ok: true, pool: d.pool || 0, status: "good", detail: "pool: " + (d.pool || 0), name: "" };
  } catch (e) {}
  return { kind: "none", ok: false, pool: 0, status: "bad", detail: "invalid key", name: "" };
}
async function personalStatus(p, now) {
  let status = "untested", detail = "", exp = null;
  try {
    const r = await fetch(API + "/refresher/public/status", { headers: { "X-View-Key": p.view_key } });
    if (r.status === 404) { status = "bad"; detail = "removed — re-add it"; }
    else if (r.ok) {
      const d = await r.json();
      status = d.status === "alive" ? "good" : (d.status === "broken" ? "bad" : "untested");
      detail = d.last_error || (p.account ? "acct " + p.account : "");
      exp = d.access_ttl != null ? now + Math.floor(d.access_ttl) : null;
    }
  } catch (e) { status = "untested"; detail = "unreachable"; }
  return { id: p.id, label: p.label || "", status, detail, mask: p.mask || "",
           has_refresh: true, exp, in_use: p.id === USE_ID, view_key: p.view_key || "" };
}
async function buildStatus() {
  const now = Math.floor(Date.now() / 1000);
  const k = await checkKey();
  KEY_KIND = k.kind; KEY_NAME = k.name;
  const personal = [];
  for (const p of PERSONAL) personal.push(await personalStatus(p, now));
  const counts = {
    total: personal.length,
    good: personal.filter((x) => x.status === "good").length,
    bad: personal.filter((x) => x.status === "bad").length,
    pending: personal.filter((x) => x.status !== "good" && x.status !== "bad").length,
  };
  let inUse = null, inUseExp = null;
  if (SOURCE === "personal") {
    const u = personal.find((x) => x.id === USE_ID);
    if (u && u.status === "good") { inUse = "personal"; inUseExp = u.exp; }
  } else if (k.ok) { inUse = (k.kind === "account") ? "account" : "pile"; }
  return {
    now, enabled: !!ENABLED, account: "guest", source: SOURCE,
    refresh_ready: true, endpoint: "admin.wolver002.com",
    pile_usable: k.pool, key_name: k.name,
    in_use: inUse != null, in_use_source: inUse || "", in_use_exp: inUseExp,
    last_refresh: LAST_REFRESH, last_error: LAST_ERROR,
    personal, personal_counts: counts,
    key: { linked: !!PILE_KEY, status: PILE_KEY ? k.status : "untested",
           detail: PILE_KEY ? k.detail : "", mask: maskKey(PILE_KEY) },
  };
}

/* ---------------- render (unchanged from the local app) ---------------- */
function render(s) {
  last = s;
  skew = s.now - Math.floor(Date.now() / 1000);

  $("#dot").classList.toggle("on", s.enabled);
  $("#dot").classList.toggle("err", !!s.last_error && s.enabled);

  const rp = $("#run-pill");
  rp.textContent = s.enabled ? "running" : "stopped";
  rp.classList.toggle("mine", s.enabled);
  rp.classList.toggle("dim", !s.enabled);

  $("#acct-name").textContent = s.account || "-";

  // token-source switch: "<account> token" (from the key) vs "personal token"
  const segKey = $("#src-key"), segPer = $("#src-personal");
  if (segKey && segPer) {
    segKey.textContent = KEY_KIND === "account" ? ((s.key_name || "key") + " token")
      : (KEY_KIND === "pile" ? "random token" : "key token");
    segKey.classList.toggle("on", s.source !== "personal");
    segPer.classList.toggle("on", s.source === "personal");
  }

  const err = $("#s-error");
  if (s.last_error) { err.textContent = s.last_error; err.classList.remove("hidden"); }
  else err.classList.add("hidden");

  renderPersonal(s.personal, s.personal_counts);
  renderKey(s.key);
  renderCountdown();
}

function renderPersonal(list, counts) {
  const pill = $("#pers-pill");
  pill.textContent = `${counts.total} saved`;
  pill.classList.toggle("mine", counts.good > 0);
  pill.classList.toggle("dim", counts.good === 0);

  const box = $("#pers-list");
  if (!list.length) { box.innerHTML = '<div class="pile-empty">none yet — save one below</div>'; return; }
  const now = Math.floor(Date.now() / 1000) + skew;
  box.innerHTML = "";
  for (const t of list) {
    const exp = t.exp ? " · exp " + fmtDur(t.exp - now) : (t.has_refresh ? "" : " · no refresh");
    const row = document.createElement("div");
    row.className = "pile-row" + (t.in_use ? " inuse" : "");
    const useBtn = t.in_use
      ? `<button class="btn small" data-act="stop-personal" data-id="${t.id}">Stop</button>`
      : `<button class="btn small ${t.status === "good" ? "green" : ""}" data-act="use-personal" data-id="${t.id}" ${t.status === "good" ? "" : "disabled"}>Use</button>`;
    row.innerHTML =
      `<div class="pile-main">
         <div class="pile-top">${tagFor(t.status)}${t.in_use ? '<span class="tag inuse-tag">in use</span>' : ""}
           <span class="pile-id mono">#${t.id}${t.label ? " · " + esc(t.label) : ""}</span></div>
         <div class="pile-sub mono">${esc(t.mask || "(no bearer)")}${esc(exp)}</div>
         ${t.detail ? `<div class="pile-detail">${esc(t.detail)}</div>` : ""}
       </div>
       <div class="pile-actions">
         <button class="btn small" data-act="test-personal" data-id="${t.id}">Test</button>
         ${useBtn}
         <button class="btn small" data-vk="${esc(t.view_key || "")}" ${t.view_key ? "" : "disabled"} title="Copy this token's mod key">Key</button>
         <button class="btn small x" data-act="rm-personal" data-id="${t.id}">✕</button>
       </div>`;
    box.appendChild(row);
  }
}

function renderKey(k) {
  const pill = $("#key-pill");
  const form = $("#acct-form"), inBox = $("#acct-in");

  if (!ACCOUNT) {                                   // logged out
    form.classList.remove("hidden"); inBox.classList.add("hidden");
    pill.innerHTML = "logged out";
    pill.classList.remove("mine"); pill.classList.add("dim");
    return;
  }

  form.classList.add("hidden"); inBox.classList.remove("hidden");
  $("#acct-who").textContent = ACCOUNT.username || "you";
  const av = $("#dc-avatar");
  if (ACCOUNT.discord_linked && ACCOUNT.discord_avatar) { av.src = ACCOUNT.discord_avatar; av.classList.remove("hidden"); }
  else av.classList.add("hidden");

  const linked = !!ACCOUNT.discord_linked;
  $("#link-row").classList.toggle("hidden", linked);
  $("#key-row").classList.toggle("hidden", !linked);

  if (!linked) {                                    // logged in, Discord not linked
    pill.innerHTML = "link Discord";
    pill.classList.remove("mine"); pill.classList.add("dim");
    $("#key-state").textContent = "";
    return;
  }

  if (!ACCOUNT.supporter) {                          // linked, but no supp role
    pill.innerHTML = "not a supporter";
    pill.classList.remove("mine"); pill.classList.add("dim");
    $("#in-key").value = "";
    $("#btn-gen-key").classList.add("hidden");
    $("#btn-show-key").classList.add("hidden");
    $("#btn-copy-key").classList.add("hidden");
    $("#key-state").textContent = "you need the supp role in the Discord server";
    return;
  }

  const hasKey = !!ACCOUNT.key;                     // linked + supporter
  $("#in-key").value = hasKey ? (keyShown ? ACCOUNT.key : maskKey(ACCOUNT.key)) : "";
  $("#btn-gen-key").classList.toggle("hidden", hasKey);
  $("#btn-show-key").classList.toggle("hidden", !hasKey);
  $("#btn-show-key").textContent = keyShown ? "Hide" : "Show";
  $("#btn-copy-key").classList.toggle("hidden", !hasKey);
  pill.innerHTML = hasKey ? tagFor(k.status) : "no key yet";
  pill.classList.toggle("mine", hasKey && (k.status === "good" || k.status === "local"));
  pill.classList.toggle("dim", !hasKey);
  $("#key-state").textContent = hasKey ? (k.detail || "ready") : "generate your key";
}

function renderCountdown() {
  if (!last) return;
  const el = $("#s-countdown");
  if (!el) return;   // Status readouts removed from the page
  if (!last.in_use) { el.textContent = "—"; el.className = "stat-v big"; return; }
  if (last.in_use_source === "account") { el.textContent = "ready"; el.className = "stat-v big"; return; }
  if (last.in_use_source === "pile") {   // random draw has no single countdown
    el.textContent = (last.pile_usable || 0) + " in pool"; el.className = "stat-v big"; return;
  }
  const exp = last.in_use_exp;
  if (!exp) { el.textContent = "on"; el.className = "stat-v big"; return; }
  const remaining = exp - (Math.floor(Date.now() / 1000) + skew);
  el.textContent = fmtDur(remaining);
  el.className = "stat-v big" + (remaining <= 0 ? " crit" : remaining <= 60 ? " warn" : "");
}

/* ---------------- actions ---------------- */
async function refreshStatus() { try { render(await buildStatus()); } catch (e) { /* keep last */ } }
async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    const s = await fn();
    render(s);
    if (okMsg) toast(s.last_error ? s.last_error : okMsg, !!s.last_error);
  } catch (e) { LAST_ERROR = ""; toast(e.message, true); refreshStatus(); }
  finally { if (btn) btn.disabled = false; }
}

async function download(path, headers, name) {
  const r = await fetch(API + path, { headers });
  if (!r.ok) { const e = await r.json().catch(() => ({ error: "HTTP " + r.status })); throw new Error(e.error || ("HTTP " + r.status)); }
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function addPersonal(bearer, refresh, label) {
  if (!PILE_KEY) throw new Error("Link your key first");
  const paste = (bearer && refresh) ? JSON.stringify({ token: bearer, refresh_token: refresh }) : (refresh || bearer);
  const r = await fetch(API + "/refresher/public/submit", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Refresher-Key": PILE_KEY },
    body: JSON.stringify({ paste }),
  });
  const j = await r.json().catch(() => ({ error: "HTTP " + r.status }));
  if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status));
  SEQ += 1;
  PERSONAL.push({ id: SEQ, view_key: j.view_key, label: label || "", mask: maskTok(bearer || refresh), account: j.account || "" });
  saveState();
}
async function removePersonal(id) {
  const p = PERSONAL.find((x) => x.id === id);
  if (p) { try { await fetch(API + "/refresher/public/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: p.view_key }) }); } catch (e) {} }
  PERSONAL = PERSONAL.filter((x) => x.id !== id);
  if (USE_ID === id) { USE_ID = null; SOURCE = "pile"; }
  saveState();
}

const ACTIONS = {
  "test-personal": async () => await buildStatus(),
  "use-personal": async (id) => { SOURCE = "personal"; USE_ID = id; saveState(); return await buildStatus(); },
  "stop-personal": async () => { SOURCE = "pile"; USE_ID = null; saveState(); return await buildStatus(); },
  "rm-personal": async (id) => { await removePersonal(id); return await buildStatus(); },
};

function wire() {
  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const fn = ACTIONS[btn.dataset.act];
    if (fn) act(btn, () => fn(Number(btn.dataset.id)));
  });

  // Copy a personal token's mod key (its view key) so it can go in the mod's refresher.key
  document.addEventListener("click", async (ev) => {
    const kb = ev.target.closest("[data-vk]");
    if (!kb) return;
    const vk = kb.getAttribute("data-vk");
    if (!vk) return;
    try { await navigator.clipboard.writeText(vk); const o = kb.textContent; kb.textContent = "Copied"; setTimeout(() => (kb.textContent = o), 1200); }
    catch (e) { window.prompt("Your mod key:", vk); }
  });


  $("#btn-save-personal").addEventListener("click", async (e) => {
    const bearer = $("#in-bearer").value.trim(), refresh = $("#in-refresh").value.trim(), label = $("#in-label").value.trim();
    if (!bearer && !refresh) { toast("Paste a bearer and/or refresh token", true); return; }
    await act(e.target, async () => { await addPersonal(bearer, refresh, label); return await buildStatus(); }, "Saved & kept warm");
    $("#in-bearer").value = ""; $("#in-refresh").value = ""; $("#in-label").value = "";
  });

  // Account: log in / create account
  async function doAuth(kind, e) {
    const u = $("#in-user").value.trim(), p = $("#in-pass").value;
    if (!u || !p) { $("#acct-msg").textContent = "enter a username and password"; return; }
    await act(e.target, async () => { await accountAuth(kind, u, p); return await buildStatus(); },
              kind === "register" ? "Account created" : "Logged in");
    $("#in-pass").value = "";
  }
  $("#btn-login").addEventListener("click", (e) => doAuth("login", e));
  $("#btn-register").addEventListener("click", (e) => doAuth("register", e));
  $("#in-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doAuth("login", $("#btn-login")); } });

  // Link Discord: carry the account session in `s` so the callback attaches it to this account.
  $("#btn-discord").addEventListener("click", () => {
    const ret = location.origin + location.pathname;
    location.href = API + "/refresher/discord/login?return=" + encodeURIComponent(ret) + "&s=" + encodeURIComponent(SESSION);
  });
  $("#btn-gen-key").addEventListener("click", (e) =>
    act(e.target, async () => { keyShown = false; await genKey(); return await buildStatus(); }, "Key generated"));
  $("#btn-show-key").addEventListener("click", () => { keyShown = !keyShown; if (last) renderKey(last.key); });
  $("#btn-copy-key").addEventListener("click", async () => {
    const key = (ACCOUNT && ACCOUNT.key) || PILE_KEY;
    if (!key) return;
    try { await navigator.clipboard.writeText(key); toast("Key copied"); }
    catch (e) { window.prompt("Your key:", key); }
  });
  $("#btn-logout").addEventListener("click", (e) => act(e.target, async () => {
    try { await fetch(API + "/refresher/account/logout", { method: "POST", headers: { "X-Session": SESSION } }); } catch (_) {}
    setSession(""); ACCOUNT = null;
    PILE_KEY = ""; saveState();
    return await buildStatus();
  }, "Logged out"));

  $("#src-key").addEventListener("click", (e) => act(e.target, async () => { SOURCE = "pile"; saveState(); return await buildStatus(); }, "Using key token"));
  $("#src-personal").addEventListener("click", (e) => act(e.target, async () => { SOURCE = "personal"; if (USE_ID == null && PERSONAL.length) USE_ID = PERSONAL[0].id; saveState(); return await buildStatus(); }, "Using personal token"));

  // Pull a token from whichever source the switch is on, and download it.
  $("#btn-get").addEventListener("click", async (e) => {
    const b = e.target, o = b.textContent; b.textContent = "Getting…";
    await act(b, async () => {
      if (SOURCE === "personal") {
        const p = PERSONAL.find((x) => x.id === USE_ID) || PERSONAL[0];
        if (!p) throw new Error("No personal token saved");
        await download("/refresher/public/token.json", { "X-View-Key": p.view_key }, "token.json");
      } else {
        if (!PILE_KEY) throw new Error("Link your key first");
        if (KEY_KIND === "account") await download("/refresher/token.json", { "X-Refresher-Key": PILE_KEY }, "token.json");
        else await download("/refresher/public/pile.token.json", { "X-Pile-Key": PILE_KEY }, "token.json");
      }
      LAST_REFRESH = Math.floor(Date.now() / 1000);
      return await buildStatus();
    }, "Downloaded token.json");
    b.textContent = o;
  });
}

function startPolling() { if (poll) clearInterval(poll); poll = setInterval(refreshStatus, 4000); }

async function boot() {
  await loadAccount();               // resolve account + Discord + key once at start
  if (PILE_KEY) setCookie("wolver_key", PILE_KEY, 365);
  await refreshStatus();
  startPolling();
}
wire();
boot();
setInterval(renderCountdown, 1000);
