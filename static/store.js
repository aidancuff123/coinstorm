/* Local backend: replaces the old FastAPI server.
 *
 * Sessions live in IndexedDB on this device:
 *   "sessions": one small summary row per session (what the log and lifetime stats read)
 *   "details":  the heavy parts (series, histograms, sequence, pick data), keyed by the same id
 * Simulations run in a Web Worker (worker.js). The unfinished pick session lives in localStorage.
 */
(function () {
  "use strict";
  const E = window.CoinEngine;
  const DRAFT_TTL_MS = 7 * 24 * 3600 * 1000;
  const EXPORT_FORMAT = "coinstorm-export";

  class AppError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  /* ---------- IndexedDB ---------- */
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open("coinstorm", 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          d.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
          d.createObjectStore("details", { keyPath: "id" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new AppError("Couldn’t open storage on this device: " + (req.error?.message || "unknown error")));
      });
    }
    return dbp;
  }
  const done = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error || new AppError("Storage error"));
  });
  const result = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function allSummaries() {
    const tx = (await db()).transaction("sessions");
    return result(tx.objectStore("sessions").getAll());
  }

  let persistAsked = false;
  function askPersist() {
    // Ask the browser not to evict our data under storage pressure (a no-op where unsupported).
    if (persistAsked) return;
    persistAsked = true;
    navigator.storage?.persist?.().catch(() => {});
  }

  /** Store one session; returns its new id. summary has no id; detail has no id. */
  async function insert(summary, detail) {
    const d = await db();
    const tx = d.transaction(["sessions", "details"], "readwrite");
    const id = await result(tx.objectStore("sessions").add(summary));
    tx.objectStore("details").put({ id, ...detail });
    await done(tx);
    askPersist();
    return id;
  }

  function buildRecord(r, { label, mode = "simulate", duration_ms, created_at = new Date().toISOString(), pick = null }) {
    const f = E.fairness(r.n, r.heads);
    const summary = {
      created_at, label: label || null, n_tosses: r.n, heads: r.heads, tails: r.tails,
      longest_heads: r.longest_heads, longest_heads_start: r.longest_heads_start,
      longest_tails: r.longest_tails, longest_tails_start: r.longest_tails_start,
      runs: r.runs, z_score: f.z_score, p_value: f.p_value, duration_ms, mode,
    };
    if (pick) summary.pick = { choices: pick.choices, chose_heads: pick.chose_heads, chose_b: pick.chose_b, raw_heads: pick.raw_heads };
    const detail = { series: r.series, hist_heads: r.hist_heads, hist_tails: r.hist_tails, sequence: r.sequence, pick };
    return { summary, detail };
  }

  async function getSession(id) {
    const tx = (await db()).transaction(["sessions", "details"]);
    const [s, d] = await Promise.all([result(tx.objectStore("sessions").get(id)), result(tx.objectStore("details").get(id))]);
    if (!s || !d) throw new AppError("Session not found", 404);
    return E.sessionPayload(s, d);
  }

  async function deleteSession(id) {
    const tx = (await db()).transaction(["sessions", "details"], "readwrite");
    tx.objectStore("sessions").delete(id);
    tx.objectStore("details").delete(id);
    await done(tx);
  }

  /* ---------- simulation ---------- */
  let running = null;  // only one run at a time

  /** Toss n coins in the worker. onProgress(done, n) during the run. Resolves to the stored session. */
  function runSession(n, label, onProgress) {
    E.validateN(n);
    if (running) return Promise.reject(new AppError("Another run is in progress. Wait for it to finish.", 409));
    running = new Promise((resolve, reject) => {
      const w = new Worker("worker.js");
      const stop = (fn, v) => { w.terminate(); running = null; fn(v); };
      w.onmessage = async (e) => {
        const m = e.data;
        if (m.type === "progress") onProgress?.(m.done, m.n);
        else if (m.type === "error") stop(reject, new AppError(m.message));
        else if (m.type === "done") {
          try {
            const { summary, detail } = buildRecord(m.result, { label, duration_ms: m.duration_ms });
            const id = await insert(summary, detail);
            stop(resolve, await getSession(id));
          } catch (err) { stop(reject, err); }
        }
      };
      w.onerror = (e) => { e.preventDefault?.(); stop(reject, new AppError(e.message || "The simulation stopped unexpectedly.")); };
      w.postMessage({ n });
    });
    return running;
  }

  /* ---------- pick mode ---------- */
  function readDraft() {
    try {
      const d = JSON.parse(localStorage.getItem("coinstorm.draft"));
      if (d && Date.now() - Date.parse(d.created_at) < DRAFT_TTL_MS) return d;
    } catch { /* unavailable or corrupt */ }
    return null;
  }
  function writeDraft(d) {
    try { d ? localStorage.setItem("coinstorm.draft", JSON.stringify(d)) : localStorage.removeItem("coinstorm.draft"); }
    catch { /* unavailable: the session still works until the app is closed */ }
  }

  function startPick(n, label) {
    const pairs = E.makePairs(n, (buf) => crypto.getRandomValues(buf));
    const draft = { draft_id: crypto.randomUUID?.() || String(Date.now()), created_at: new Date().toISOString(), n, label: label || null, pairs };
    writeDraft(draft);
    return draft;
  }
  function getDraft(id) {
    const d = readDraft();
    if (!d || d.draft_id !== id) throw new AppError("Pick session not found (finished, discarded, or expired)", 404);
    return d;
  }
  function discardDraft(id) {
    if (readDraft()?.draft_id === id) writeDraft(null);
  }
  async function finishPick(id, picks) {
    const d = getDraft(id);
    const { kept, summary } = E.resolvePicks(d.pairs, d.n, picks);
    const m = kept.length;
    const acc = new E.Accumulator(m);
    acc.feedBits(kept);
    const r = acc.finish();
    const pick = { ...summary, pairs: d.pairs.slice(0, 2 * m), picks: picks.map((p) => (p ? "B" : "A")).join("") };
    delete pick.rounds;
    const { summary: s, detail } = buildRecord(r, {
      label: d.label, mode: "pick", pick, duration_ms: Date.now() - Date.parse(d.created_at),  // time spent picking
    });
    const sid = await insert(s, detail);
    writeDraft(null);
    return getSession(sid);
  }

  /* ---------- log and lifetime ---------- */
  const SORTS = {
    date_desc: (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id,
    date_asc: (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id,
    size_desc: (a, b) => b.n_tosses - a.n_tosses || b.id - a.id,
    size_asc: (a, b) => a.n_tosses - b.n_tosses || a.id - b.id,
  };
  async function listSessions({ limit = 50, offset = 0, sort = "date_desc", min_n = null, max_n = null, mode = null } = {}) {
    let rows = await allSummaries();
    if (mode) rows = rows.filter((r) => (r.mode || "simulate") === mode);
    if (min_n != null) rows = rows.filter((r) => r.n_tosses >= min_n);
    if (max_n != null) rows = rows.filter((r) => r.n_tosses <= max_n);
    rows.sort(SORTS[sort] || SORTS.date_desc);
    const items = rows.slice(offset, offset + limit).map((r) => ({
      ...r, heads_pct: (100 * r.heads) / r.n_tosses, longest_streak: Math.max(r.longest_heads, r.longest_tails),
    }));
    return { total: rows.length, items };
  }

  async function lifetimeStats() {
    const rows = (await allSummaries()).sort(SORTS.date_asc);
    const sim = rows.filter((r) => (r.mode || "simulate") === "simulate");
    const picks = rows.filter((r) => r.mode === "pick" && r.pick);
    return { ...E.lifetime(sim), pick: E.pickLifetime(picks) };
  }

  /* ---------- backup ---------- */
  async function exportAll() {
    const tx = (await db()).transaction(["sessions", "details"]);
    const [rows, details] = await Promise.all([result(tx.objectStore("sessions").getAll()), result(tx.objectStore("details").getAll())]);
    const byId = new Map(details.map((d) => [d.id, d]));
    return {
      format: EXPORT_FORMAT, version: 1, exported_at: new Date().toISOString(),
      sessions: rows.map(({ id, pick: _p, ...s }) => {
        const { id: _, ...d } = byId.get(id) || {};
        return { ...s, ...d };
      }),
    };
  }

  const keyOf = (s) => `${s.created_at}|${s.n_tosses}|${s.heads}|${s.mode || "simulate"}`;

  /** Merge an export file; sessions already on this device are skipped. */
  async function importAll(data) {
    if (data?.format !== EXPORT_FORMAT || !Array.isArray(data.sessions)) throw new AppError("That file isn’t a Coinstorm export.");
    const existing = new Set((await allSummaries()).map(keyOf));
    let added = 0, skipped = 0;
    for (const s of data.sessions) {
      const n = s.n_tosses;
      const valid = Number.isInteger(n) && n >= 1 && n <= E.MAX_TOSSES && Number.isInteger(s.heads) && s.heads >= 0 && s.heads <= n
        && typeof s.created_at === "string" && !isNaN(Date.parse(s.created_at)) && Number.isInteger(s.runs)
        && Array.isArray(s.series) && Array.isArray(s.hist_heads) && Array.isArray(s.hist_tails);
      if (!valid || existing.has(keyOf(s))) { skipped++; continue; }
      const r = { ...s, n, tails: n - s.heads };
      const pick = s.mode === "pick" && s.pick ? s.pick : null;
      const { summary, detail } = buildRecord(r, { label: s.label, mode: pick ? "pick" : "simulate", duration_ms: s.duration_ms ?? 0, created_at: s.created_at, pick });
      await insert(summary, detail);
      existing.add(keyOf(s));
      added++;
    }
    return { added, skipped };
  }

  window.CoinStore = {
    AppError, runSession, isRunning: () => !!running,
    startPick, getDraft, discardDraft, finishPick,
    listSessions, getSession, deleteSession, lifetimeStats,
    exportAll, importAll,
  };
})();
