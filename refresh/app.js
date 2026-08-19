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

let PILE_KEY = (function () { try { return localStorage.getItem("wolver_pile_key") || ""; } catch (e) { return ""; } })();
let SOURCE = (function () { try { return localStorage.getItem("wolver_source") || "pile"; } catch (e) { return "pile"; } })();
if (SOURCE !== "personal") SOURCE = "pile";
let PERSONAL = jget("wolver_personal", []);          // [{id, view_key, label, mask, account}]
let USE_ID = jget("wolver_use_id", null);
let ENABLED = jget("wolver_enabled", true);
let SEQ = jget("wolver_seq", 0);
let LAST_REFRESH = 0;
let LAST_ERROR = "";
let poll = null;

function saveState() {
  sset("wolver_pile_key", PILE_KEY);
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

/* ---------------- data layer: build the same status shape the render code expects ---------------- */
async function checkPile() {
  if (!PILE_KEY) return { ok: false, pool: 0, status: "untested", detail: "" };
  try {
    const r = await fetch(API + "/refresher/public/pile/checkkey", { headers: { "X-Pile-Key": PILE_KEY } });
    const d = await r.json().catch(() => ({}));
    return { ok: !!d.ok, pool: d.pool || 0,
             status: d.ok ? "good" : "bad",
             detail: d.ok ? ("pool: " + (d.pool || 0)) : "invalid key" };
  } catch (e) { return { ok: false, pool: 0, status: "bad", detail: "unreachable" }; }
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
           has_refresh: true, exp, in_use: p.id === USE_ID };
}
async function buildStatus() {
  const now = Math.floor(Date.now() / 1000);
  const pile = await checkPile();
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
  } else if (pile.ok && pile.pool > 0) { inUse = "pile"; }
  return {
    now, enabled: !!ENABLED, account: "guest", source: SOURCE,
    refresh_ready: true, endpoint: "admin.wolver002.com",
    pile_usable: pile.pool,
    in_use: inUse != null, in_use_source: inUse || "", in_use_exp: inUseExp,
    last_refresh: LAST_REFRESH, last_error: LAST_ERROR,
    personal, personal_counts: counts,
    key: { linked: !!PILE_KEY, status: PILE_KEY ? pile.status : "untested",
           detail: PILE_KEY ? pile.detail : "", mask: maskKey(PILE_KEY) },
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

  $("#src-now").textContent = s.source === "personal" ? "your token" : "pile · random";
  const bsp = $("#btn-src-pile");
  bsp.classList.toggle("green", s.source !== "pile");
  bsp.disabled = s.source === "pile";

  $("#s-source").textContent = { personal: "your token", pile: "pile · random" }[s.in_use_source] || "none";
  $("#s-last").textContent = s.last_refresh ? new Date(s.last_refresh * 1000).toLocaleTimeString() : "never";
  $("#s-endpoint").textContent = s.refresh_ready ? s.endpoint : (s.endpoint || "not set");
  $("#s-endpoint").style.color = s.refresh_ready ? "" : "var(--dim)";

  const err = $("#s-error");
  if (s.last_error) { err.textContent = s.last_error; err.classList.remove("hidden"); }
  else err.classList.add("hidden");

  $("#btn-start").disabled = s.enabled;
  $("#btn-stop").disabled = !s.enabled;

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
         <button class="btn small x" data-act="rm-personal" data-id="${t.id}">✕</button>
       </div>`;
    box.appendChild(row);
  }
}

function renderKey(k) {
  const pill = $("#key-pill");
  pill.innerHTML = k.linked ? tagFor(k.status) : "not linked";
  pill.classList.toggle("mine", k.status === "good" || (k.linked && k.status === "local"));
  pill.classList.toggle("dim", !k.linked);
  if (!k.linked) { keyShown = false; $("#btn-show-key").textContent = "Show key"; }
  $("#btn-show-key").disabled = !k.linked;
  if (keyShown && k.linked) {
    $("#key-state").textContent = keyValue;   // full key, revealed
  } else {
    $("#key-state").textContent = k.linked ? `${k.mask}${k.detail ? " · " + k.detail : ""}` : "no key linked";
  }
}

function renderCountdown() {
  if (!last) return;
  const el = $("#s-countdown");
  if (!last.in_use) { el.textContent = "—"; el.className = "stat-v big"; return; }
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
  if (!PILE_KEY) throw new Error("Link your pile key first");
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

  $("#btn-start").addEventListener("click", (e) => act(e.target, async () => { ENABLED = true; saveState(); startPolling(); return await buildStatus(); }, "Started"));
  $("#btn-stop").addEventListener("click", (e) => act(e.target, async () => { ENABLED = false; saveState(); return await buildStatus(); }, "Stopped"));
  $("#btn-refresh").addEventListener("click", async (e) => {
    const b = e.target; b.textContent = "Refreshing...";
    await act(b, async () => {
      if (SOURCE === "pile") {
        if (!PILE_KEY) throw new Error("Link your pile key first");
        await download("/refresher/public/pile.token.json", { "X-Pile-Key": PILE_KEY }, "token.json");
        LAST_REFRESH = Math.floor(Date.now() / 1000);
      }
      return await buildStatus();
    }, SOURCE === "pile" ? "Pulled a random token" : "Refreshed");
    b.textContent = "Refresh now";
  });

  $("#btn-save-personal").addEventListener("click", async (e) => {
    const bearer = $("#in-bearer").value.trim(), refresh = $("#in-refresh").value.trim(), label = $("#in-label").value.trim();
    if (!bearer && !refresh) { toast("Paste a bearer and/or refresh token", true); return; }
    await act(e.target, async () => { await addPersonal(bearer, refresh, label); return await buildStatus(); }, "Saved & kept warm");
    $("#in-bearer").value = ""; $("#in-refresh").value = ""; $("#in-label").value = "";
  });

  $("#btn-link-key").addEventListener("click", async (e) => {
    const key = $("#in-key").value.trim();
    if (!key) { toast("Enter a key", true); return; }
    keyShown = false; PILE_KEY = key; saveState();
    await act(e.target, async () => await buildStatus(), "Pile key linked");
    $("#in-key").value = "";
  });
  $("#btn-show-key").addEventListener("click", (e) => {
    if (keyShown) { keyShown = false; keyValue = ""; e.target.textContent = "Show key"; if (last) renderKey(last.key); return; }
    keyValue = PILE_KEY || ""; keyShown = true; e.target.textContent = "Hide"; if (last) renderKey(last.key);
  });
  $("#btn-unlink-key").addEventListener("click", (e) => { keyShown = false; act(e.target, async () => { PILE_KEY = ""; saveState(); return await buildStatus(); }, "Unlinked"); });
  $("#btn-test-key").addEventListener("click", (e) => act(e.target, async () => await buildStatus(), "Key tested"));

  $("#btn-src-pile").addEventListener("click", (e) => act(e.target, async () => { SOURCE = "pile"; USE_ID = null; saveState(); return await buildStatus(); }, "Using the pile (random)"));
}

function startPolling() { if (poll) clearInterval(poll); poll = setInterval(refreshStatus, 4000); }

wire();
refreshStatus();
startPolling();
setInterval(renderCountdown, 1000);
