"use strict";

const MAX = 2147483647;
const ANIM_LIMIT = 20;    // animate the coin for this many tosses or fewer
const CHIPS_LIMIT = 200;  // show the H/T strip for this many tosses or fewer
const PICK_MAX = 10000;   // pick mode: rounds per session
const STRIP_TAIL = 60;    // pick mode: kept chips shown while picking
const $ = (id) => document.getElementById(id);

// localStorage is a convenience only (remembered mode, unfinished pick session).
function store(k, v) {
  try { v == null ? localStorage.removeItem("coinstorm." + k) : localStorage.setItem("coinstorm." + k, JSON.stringify(v)); } catch { /* unavailable */ }
}
function recall(k) {
  try { return JSON.parse(localStorage.getItem("coinstorm." + k)); } catch { return null; }
}

/* ---------- formatting ---------- */
const intFmt = new Intl.NumberFormat("en-US");
const fmtInt = (n) => intFmt.format(n);
const signed = (s, x) => (x > 0 ? "+" : x < 0 ? "−" : "") + s;
function pctDigits(n) {
  // Enough decimals that one standard deviation of the heads % is visible.
  return Math.min(6, Math.max(1, Math.ceil(Math.log10(Math.sqrt(n) / 50)) + 1));
}
const fmtPct = (x, d = 1) => x.toFixed(d) + "%";
function fmtP(p) {
  if (p == null) return "—";
  if (p >= 0.0001) return p.toFixed(4);
  if (p === 0) return "< 10⁻³⁰⁰";
  const [m, e] = p.toExponential(1).split("e");
  const sup = { "-": "⁻", 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };
  return `${m} × 10${[...String(+e)].map((c) => sup[c]).join("")}`;
}
const fmtZ = (z) => (z == null ? "—" : signed(Math.abs(z).toFixed(2), z));
function fmtDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}
function fmtEta(s) {
  if (s == null || !isFinite(s)) return "estimating…";
  if (s < 1) return "almost done";
  return s < 60 ? `about ${Math.ceil(s)} s left` : `about ${Math.ceil(s / 60)} min left`;
}
const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ---------- storage ---------- */
// Everything runs on this device: CoinStore (store.js) keeps sessions in IndexedDB
// and runs simulations in a Web Worker.
const db = window.CoinStore;
const BIG_RUN = 1000000;  // show the progress card above this many tosses

/* ---------- charts ---------- */
const charts = new Map(); // canvas id -> Chart
function makeChart(canvasId, config) {
  charts.get(canvasId)?.destroy();
  const c = new Chart($(canvasId), config);
  charts.set(canvasId, c);
  return c;
}
function baseOptions() {
  const text2 = css("--text-2"), grid = css("--grid");
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = text2;
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: css("--surface"), titleColor: css("--text"), bodyColor: css("--text"),
                 borderColor: css("--border"), borderWidth: 1, padding: 10, boxPadding: 4 },
    },
    scales: {
      x: { grid: { color: grid }, border: { color: grid }, ticks: { maxRotation: 0, autoSkipPadding: 12 } },
      y: { grid: { color: grid }, border: { display: false } },
    },
  };
}
const tickInt = (v) => {
  if (Math.abs(v) >= 1e9) return +(v / 1e9).toPrecision(3) + "B";
  if (Math.abs(v) >= 1e6) return +(v / 1e6).toPrecision(3) + "M";
  if (Math.abs(v) >= 1e3) return +(v / 1e3).toPrecision(3) + "K";
  return v;
};

function proportionChart(canvasId, s) {
  const pts = s.series; // [[toss, proportion], ...]
  const logX = s.n_tosses >= 1000;
  const band = (k, sign) => Math.min(1, Math.max(0, 0.5 + sign / Math.sqrt(k))); // ±2σ = ±1/√k
  const o = baseOptions();
  o.parsing = false;
  o.scales.x = { ...o.scales.x, type: logX ? "logarithmic" : "linear", min: pts[0][0], max: s.n_tosses,
    title: { display: true, text: logX ? "Toss number (log scale)" : "Toss number" },
    ticks: { ...o.scales.x.ticks, callback: (v) => {
      if (!logX) return tickInt(v);
      const l = Math.log10(v);
      return Math.abs(l - Math.round(l)) < 1e-9 ? tickInt(v) : null;
    } } };
  o.scales.y.ticks = { callback: (v) => (v * 100).toFixed(pctDigits(s.n_tosses) > 2 ? 2 : 0) + "%" };
  o.plugins.tooltip.filter = (item) => item.datasetIndex === 0;
  o.plugins.tooltip.callbacks = {
    title: (items) => `Toss ${fmtInt(items[0].parsed.x)}`,
    label: (item) => ` Heads ${(item.parsed.y * 100).toFixed(pctDigits(item.parsed.x))}%`,
  };
  // Zoom y to the data once the band is narrow, so late-run wobble is visible.
  const ys = pts.map((p) => p[1]);
  const skip = Math.min(Math.floor(pts.length / 10), 50);
  const tail = ys.slice(skip);
  const lo = Math.min(...tail, ...pts.slice(skip).map((p) => band(p[0], -1)));
  const hi = Math.max(...tail, ...pts.slice(skip).map((p) => band(p[0], 1)));
  if (pts.length > 20) { o.scales.y.min = Math.max(0, lo - (hi - lo) * 0.1); o.scales.y.max = Math.min(1, hi + (hi - lo) * 0.1); }
  makeChart(canvasId, {
    type: "line",
    data: { datasets: [
      { label: "Heads proportion", data: pts.map(([x, y]) => ({ x, y })), borderColor: css("--heads"),
        borderWidth: 2, pointRadius: pts.length <= 30 ? 3 : 0, pointHoverRadius: 5, tension: 0, order: 0 },
      { label: "+2σ", data: pts.map(([x]) => ({ x, y: band(x, 1) })), borderColor: "transparent",
        backgroundColor: css("--band"), pointRadius: 0, fill: "+1", order: 2 },
      { label: "−2σ", data: pts.map(([x]) => ({ x, y: band(x, -1) })), borderColor: "transparent", pointRadius: 0, order: 2 },
      { label: "50%", data: [{ x: pts[0][0], y: 0.5 }, { x: s.n_tosses, y: 0.5 }], borderColor: css("--ref"),
        borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, order: 1 },
    ] },
    options: o,
  });
}

function streakChart(canvasId, s) {
  const L = Math.max(s.hist_heads.length, s.hist_tails.length) - 1;
  const labels = Array.from({ length: L }, (_, i) => i + 1);
  const h = labels.map((k) => s.hist_heads[k] || 0), t = labels.map((k) => s.hist_tails[k] || 0);
  const maxCount = Math.max(...h, ...t);
  const logY = maxCount > 1000;
  const o = baseOptions();
  o.scales.x.title = { display: true, text: "Streak length" };
  o.scales.x.grid = { display: false };
  o.scales.y = { ...o.scales.y, type: logY ? "logarithmic" : "linear", beginAtZero: !logY,
    title: { display: true, text: logY ? "Streaks (log scale)" : "Streaks" },
    ticks: { callback: (v) => {
      if (!logY) return Number.isInteger(v) ? tickInt(v) : null;
      const l = Math.log10(v);
      return Math.abs(l - Math.round(l)) < 1e-9 ? tickInt(v) : null;
    } } };
  o.plugins.tooltip.callbacks = {
    title: (items) => `Streak of ${items[0].label}`,
    label: (item) => ` ${item.dataset.label}: ${fmtInt(item.parsed.y)}`,
  };
  const surface = css("--surface");
  const ds = (label, data, color) => ({ label, data: data.map((v) => (logY && v === 0 ? null : v)),
    backgroundColor: color, borderColor: surface, borderWidth: { top: 0, left: 1, right: 1, bottom: 0 },
    borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", categoryPercentage: 0.8, barPercentage: 0.95 });
  makeChart(canvasId, { type: "bar", data: { labels, datasets: [ds("Heads", h, css("--heads")), ds("Tails", t, css("--tails"))] }, options: o });
}

/* ---------- session view ---------- */
function verdictHtml(text, p) {
  const ok = p == null || p >= 0.05;
  return `<div class="verdict ${ok ? "ok" : "warn"}"><span class="ico" aria-hidden="true">${ok ? "✓" : "!"}</span><span>${esc(text)}</span></div>`;
}

function chipsHtml(seq, s, animate = false) {
  const mark = new Set();
  const add = (start, len) => { if (start) for (let i = start - 1; i < start - 1 + len; i++) mark.add(i); };
  if (s) { add(s.longest_heads_start, s.longest_heads); add(s.longest_tails_start, s.longest_tails); }
  return [...seq].map((c, i) =>
    `<span class="chip ${c === "H" ? "h" : "t"}${mark.has(i) ? " streak" : ""}${animate ? " pop" : ""}" aria-label="${c === "H" ? "Heads" : "Tails"}">${c}</span>`).join("");
}

function renderSession(container, s, prefix) {
  const n = s.n_tosses, d = pctDigits(n);
  const hp = (100 * s.heads) / n, tp = (100 * s.tails) / n;
  const devPP = s.deviation * 100;
  const pos = (start) => (start ? `from toss ${fmtInt(start)}` : "");
  const showChips = s.sequence && n <= CHIPS_LIMIT;
  const isPick = s.mode === "pick";
  const unit = isPick ? (n === 1 ? "round" : "rounds") : (n === 1 ? "toss" : "tosses");
  container.innerHTML = `
    <div class="card">
      <div class="meta">${isPick ? '<span class="badge">Pick</span>' : ""}${esc(s.label ? s.label + " · " : "")}${fmtDate(s.created_at)} · ${fmtInt(n)} ${unit} in ${fmtDuration(s.duration_ms)}</div>
      <div class="headline">
        <div class="side"><div class="label"><span class="dot" style="background:var(--heads)"></span>Heads</div>
          <div class="big num">${fmtInt(s.heads)}</div><div class="pct num">${fmtPct(hp, d)}</div></div>
        <div class="side"><div class="label"><span class="dot" style="background:var(--tails)"></span>Tails</div>
          <div class="big num">${fmtInt(s.tails)}</div><div class="pct num">${fmtPct(tp, d)}</div></div>
      </div>
      ${showChips ? `<div class="chips" aria-label="Toss sequence">${chipsHtml(s.sequence, s)}</div>
        <div class="chart-note">${isPick ? "The coins you kept. " : ""}Ringed chips mark the longest heads and tails streaks.</div>` : ""}
    </div>
    ${isPick && s.pick ? choicesHtml(s) : ""}
    <div class="card">
      <h2>${isPick ? "Kept coins vs. 50%" : "Fair coin?"}</h2>
      ${isPick ? `<div class="chart-note" style="margin:-4px 0 10px">You chose these coins, so this tests your picks, not the coin.</div>` : ""}
      ${verdictHtml(s.verdict, s.p_value)}
      <dl class="kv">
        <dt>Deviation from 50%</dt><dd>${signed(Math.abs(devPP).toFixed(Math.max(d, 2)), devPP)} pts
          <span class="sub">${signed(fmtInt(Math.abs(s.deviation_heads)), s.deviation_heads)} heads vs. expected</span></dd>
        <dt>In standard deviations</dt><dd>${fmtZ(s.z_score)} σ<span class="sub">1σ = ${fmtInt(Math.round(s.sigma * 10) / 10)} heads</span></dd>
        <dt>z-score</dt><dd>${fmtZ(s.z_score)}</dd>
        <dt>p-value (two-sided)</dt><dd>${fmtP(s.p_value)}</dd>
      </dl>
    </div>
    <div class="card">
      <h2>Streaks &amp; runs</h2>
      <dl class="kv">
        <dt>Longest heads streak</dt><dd>${fmtInt(s.longest_heads)}<span class="sub">${pos(s.longest_heads_start)}</span></dd>
        <dt>Longest tails streak</dt><dd>${fmtInt(s.longest_tails)}<span class="sub">${pos(s.longest_tails_start)}</span></dd>
        <dt>Typical longest streak</dt><dd>≈ ${Math.max(1, s.expected_longest).toFixed(1)}</dd>
        <dt>Runs</dt><dd>${fmtInt(s.runs)}<span class="sub">expected ${fmtInt(Math.round(s.expected_runs * 10) / 10)}</span></dd>
        <dt>Runs test z</dt><dd>${fmtZ(s.runs_z)}<span class="sub">p = ${fmtP(s.runs_p)}</span></dd>
      </dl>
      <div style="margin-top:10px">${verdictHtml("Runs: " + s.runs_verdict, s.runs_p)}</div>
    </div>
    ${n >= 2 ? `<div class="card">
      <h2>Running heads proportion</h2>
      <div class="legend"><span class="line" style="--c:var(--heads)">Heads %</span><span class="line" style="--c:var(--ref)">50%</span><span class="band">±2σ for a fair coin</span></div>
      <div class="chart-box"><canvas id="${prefix}-prop" role="img" aria-label="Running proportion of heads"></canvas></div>
      <div class="chart-note">${s.series.length < n ? `${fmtInt(s.series.length)} evenly spaced points recorded during the run.` : "Every toss shown."}</div>
    </div>` : ""}
    <div class="card">
      <h2>Streak lengths</h2>
      <div class="legend"><span style="--c:var(--heads)">Heads</span><span style="--c:var(--tails)">Tails</span></div>
      <div class="chart-box"><canvas id="${prefix}-streaks" role="img" aria-label="Histogram of streak lengths"></canvas></div>
    </div>`;
  if (n >= 2) proportionChart(`${prefix}-prop`, s);
  streakChart(`${prefix}-streaks`, s);
}

function choicesHtml(s) {
  const p = s.pick, n = s.n_tosses;
  const chip = (c, off) => `<span class="chip ${c === "H" ? "h" : "t"}${off ? " off" : ""}">${c}</span>`;
  const rounds = n <= CHIPS_LIMIT ? `<div class="rounds" aria-label="Rounds">${[...p.picks].map((k, i) => {
      const keepB = k === "B";
      return `<span class="round" title="Round ${i + 1}">${chip(p.pairs[2 * i], keepB)}${chip(p.pairs[2 * i + 1], !keepB)}</span>`;
    }).join("")}</div>
    <div class="chart-note">One pair per round (coin A, coin B). The faded coin is the one you passed over.</div>` : "";
  return `
    <div class="card">
      <h2>Your choices</h2>
      ${verdictHtml(p.choice_verdict, p.choice_p)}
      <dl class="kv">
        <dt>Real choices</dt><dd>${fmtInt(p.choices)} of ${fmtInt(n)}<span class="sub">rounds where the coins differed</span></dd>
        <dt>You kept heads</dt><dd>${p.choices ? `${fmtInt(p.chose_heads)} (${fmtPct(p.chose_heads_pct)})` : "—"}<span class="sub">when you had a choice</span></dd>
        <dt>Heads preference test</dt><dd>z ${fmtZ(p.choice_z)}<span class="sub">p = ${fmtP(p.choice_p)}</span></dd>
        <dt>Coin A / coin B</dt><dd>${fmtInt(n - p.chose_b)} / ${fmtInt(p.chose_b)}<span class="sub">${fmtPct(100 - p.chose_b_pct)} / ${fmtPct(p.chose_b_pct)}</span></dd>
      </dl>
      ${rounds}
    </div>
    <div class="card">
      <h2>The coins themselves</h2>
      ${verdictHtml(p.raw_verdict, p.raw_p)}
      <dl class="kv">
        <dt>Heads among all coins shown</dt><dd>${fmtInt(p.raw_heads)} of ${fmtInt(p.raw_total)}<span class="sub">${fmtPct(p.raw_heads_pct, pctDigits(p.raw_total))}</span></dd>
        <dt>z-score</dt><dd>${fmtZ(p.raw_z)}<span class="sub">p = ${fmtP(p.raw_p)}</span></dd>
      </dl>
    </div>`;
}

/* ---------- toss view ---------- */
const nInput = $("n-input"), tossBtn = $("toss-btn");
let lastResult = null;

function parseN() {
  const digits = nInput.value.replace(/\D/g, "");
  return digits ? Number(digits) : NaN;
}
function syncQuick() {
  const n = parseN();
  document.querySelectorAll(".quick button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.n === n)));
}
nInput.addEventListener("input", () => {
  const digits = nInput.value.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, 10);
  nInput.value = digits ? fmtInt(Number(digits)) : "";
  showError("");
  syncQuick();
});
document.querySelectorAll(".quick button").forEach((b) => b.addEventListener("click", () => {
  nInput.value = fmtInt(+b.dataset.n);
  showError("");
  syncQuick();
}));

let mode = "simulate";
const MODE_HELP = {
  simulate: "Toss coins and get exact statistics.",
  pick: "Each round flips two coins and you choose which one to keep.",
};
function setMode(m) {
  mode = m === "pick" ? "pick" : "simulate";
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
  $("mode-help").textContent = MODE_HELP[mode];
  $("n-label").textContent = mode === "pick" ? "Number of rounds" : "Number of tosses";
  $("n-help").textContent = mode === "pick" ? `1 to ${fmtInt(PICK_MAX)} · you can finish early` : `1 to ${fmtInt(MAX)}`;
  document.querySelectorAll(".quick button").forEach((b) => { b.hidden = mode === "pick" && +b.dataset.n > PICK_MAX; });
  if (mode === "pick" && parseN() > PICK_MAX) { nInput.value = ""; syncQuick(); }
  setBusy(false);
  showError("");
  store("mode", mode);
}
document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

function showError(msg) { $("toss-error").textContent = msg; $("toss-error").hidden = !msg; }
function setBusy(busy) {
  tossBtn.disabled = busy;
  tossBtn.textContent = busy ? (mode === "pick" ? "Flipping…" : "Tossing…") : (mode === "pick" ? "Start picking" : "Toss");
}

$("toss-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const n = parseN(), max = mode === "pick" ? PICK_MAX : MAX;
  if (!Number.isInteger(n) || n < 1 || n > max) { showError(`Enter a whole number from 1 to ${fmtInt(max)}.`); return; }
  const label = $("label-input").value.trim() || undefined;
  nInput.blur(); $("label-input").blur();
  showError("");
  if (mode === "pick") { await startPickSession(n, label); return; }
  setBusy(true);
  $("toss-result").innerHTML = "";
  const job = n > BIG_RUN ? startJobCard() : null;
  try {
    const data = await db.runSession(n, label, job?.update);
    job?.stop();
    if (n <= ANIM_LIMIT) await animate(data);
    showResult(data);
  } catch (err) {
    job?.stop();
    $("job").hidden = true;
    showError(err.message);
    setBusy(false);
  }
});

function showResult(s) {
  lastResult = s;
  $("anim").hidden = true;
  $("job").hidden = true;
  setBusy(false);
  renderSession($("toss-result"), s, "toss");
  $("label-input").value = "";
  reveal($("toss-result"), "start");
}

// The form fills most of a phone screen, so bring what's happening below it into view.
function reveal(el, block = "center") {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function animate(s) {
  const seq = s.sequence, coin = $("coin"), strip = $("anim-strip");
  // Reduce Motion: no spin. Each toss dims the coin and fades in the face it landed on.
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  $("anim").hidden = false;
  strip.innerHTML = "";
  coin.style.transition = "none";
  coin.style.transform = "rotateY(0deg)";
  coin.classList.toggle("flat", reduce);
  coin.classList.remove("tails", "dim");
  reveal($("anim"));
  await sleep(350);  // let the scroll settle before the first toss
  if (reduce) {
    const per = Math.max(300, Math.min(650, 4000 / seq.length));
    for (const c of seq) {
      coin.classList.add("dim");
      await sleep(per * 0.35);
      coin.classList.toggle("tails", c === "T");
      coin.classList.remove("dim");
      await sleep(per * 0.3);
      strip.insertAdjacentHTML("beforeend", chipsHtml(c));
      await sleep(per * 0.35);
    }
    await sleep(400);
    return;
  }
  const per = Math.max(260, Math.min(700, 4000 / seq.length));
  let angle = 0;
  for (const c of seq) {
    // Spin a few half-turns and land on the right face (even half-turns = H).
    const target = angle + 720 + ((c === "T") !== (Math.round(angle / 180) % 2 === 1) ? 180 : 0);
    coin.style.transition = `transform ${per * 0.8}ms cubic-bezier(.3,.7,.4,1)`;
    coin.style.transform = `rotateY(${target}deg)`;
    angle = target;
    await sleep(per * 0.85);
    strip.insertAdjacentHTML("beforeend", chipsHtml(c, null, true));
    await sleep(per * 0.15);
  }
  await sleep(400);
}

// Progress card for big runs. The worker reports flips done; the ETA comes from the rate so far.
function startJobCard() {
  $("job").hidden = false;
  $("anim").hidden = true;
  reveal($("job"));
  const t0 = performance.now();
  let wake = null;
  // Ask iOS/Android to keep the screen on: a backgrounded page pauses the run.
  navigator.wakeLock?.request("screen").then((l) => { wake = l; }).catch(() => {});
  const update = (done, n) => {
    const pct = (100 * done) / n, elapsed = (performance.now() - t0) / 1000;
    $("job-bar").style.width = pct + "%";
    $("job-bar").parentElement.setAttribute("aria-valuenow", pct.toFixed(0));
    $("job-pct").textContent = pct.toFixed(pct < 10 ? 1 : 0) + "%";
    $("job-count").textContent = `${fmtInt(done)} / ${fmtInt(n)} flips`;
    $("job-eta").textContent = done < n ? fmtEta(done && elapsed > 0.5 ? (elapsed / done) * (n - done) : null) : "";
  };
  update(0, 1);
  $("job-count").textContent = "";
  return { update, stop: () => { wake?.release().catch(() => {}); } };
}

/* ---------- pick mode ---------- */
let pk = null;          // { draft, picks, heads, busy, finishing }
let resumable = null;   // unfinished draft found on load

async function startPickSession(n, label) {
  setBusy(true);
  try {
    const data = db.startPick(n, label);
    $("label-input").value = "";
    beginPicking(data, []);
  } catch (err) {
    showError(err.message);
  }
  setBusy(false);
}

function beginPicking(draft, picks) {
  const heads = picks.reduce((h, k, i) => h + (draft.pairs[2 * i + k] === "H"), 0);
  pk = { draft, picks, heads, busy: false, finishing: false };
  store("pick", { id: draft.draft_id, picks });
  $("pick-resume").hidden = true;
  $("toss-form").hidden = true;
  $("toss-result").innerHTML = "";
  $("pick").hidden = false;
  pickMessage("Tap the coin you want to keep.");
  $("pick-strip").innerHTML = chipsHtml(picks.slice(-STRIP_TAIL).map((k, j) => {
    const i = picks.length - Math.min(picks.length, STRIP_TAIL) + j;
    return draft.pairs[2 * i + k];
  }).join(""));
  nextRound();
  reveal($("pick"), "start");
}

function pickMessage(text, isError = false) {
  const el = document.querySelector(".pick-hint");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function nextRound() {
  const i = pk.picks.length, n = pk.draft.n;
  $("pick-round").textContent = `Round ${fmtInt(Math.min(i + 1, n))} of ${fmtInt(n)}`;
  $("pick-tally").textContent = `Kept H ${fmtInt(pk.heads)} · T ${fmtInt(i - pk.heads)}`;
  $("pick-bar").style.width = (100 * i) / n + "%";
  $("pick-finish").disabled = i === 0;
  if (i >= n) { finishPicking(); return; }
  document.querySelectorAll(".pick-coin").forEach((b, k) => {
    const c = pk.draft.pairs[2 * i + k];
    b.classList.remove("chosen", "passed", "deal", "h", "t");
    void b.offsetWidth; // restart the deal animation
    b.classList.add("deal", c === "H" ? "h" : "t");
    b.querySelector(".pc-face").textContent = c;
    b.setAttribute("aria-label", `Keep coin ${"AB"[k]}: ${c === "H" ? "heads" : "tails"}`);
    b.disabled = false;
  });
}

async function choose(k) {
  if (!pk || pk.busy || pk.finishing) return;
  pk.busy = true;
  const i = pk.picks.length, c = pk.draft.pairs[2 * i + k];
  document.querySelectorAll(".pick-coin").forEach((b, j) => { b.classList.add(j === k ? "chosen" : "passed"); b.disabled = true; });
  pk.picks.push(k);
  if (c === "H") pk.heads++;
  store("pick", { id: pk.draft.draft_id, picks: pk.picks });
  const strip = $("pick-strip");
  strip.insertAdjacentHTML("beforeend", chipsHtml(c, null, true));
  while (strip.children.length > STRIP_TAIL) strip.firstElementChild.remove();
  await sleep(220);
  pk.busy = false;
  nextRound();
}
document.querySelectorAll(".pick-coin").forEach((b) => b.addEventListener("click", () => choose(+b.dataset.pick)));

async function finishPicking() {
  if (!pk || !pk.picks.length || pk.finishing) return;
  pk.finishing = true;
  $("pick-finish").disabled = true;
  pickMessage("Saving…");
  try {
    const data = await db.finishPick(pk.draft.draft_id, pk.picks);
    endPicking();
    showResult(data);
  } catch (err) {
    if (err.status === 404) { endPicking(); showError(err.message); return; }
    pk.finishing = false;
    $("pick-finish").disabled = false;
    pickMessage(`Couldn’t save: ${err.message}. Your picks are kept; try again.`, true);
  }
}
$("pick-finish").addEventListener("click", finishPicking);

function endPicking() {
  pk = null;
  store("pick", null);
  $("pick").hidden = true;
  $("toss-form").hidden = false;
}

async function discardDraft(id, count) {
  const msg = count ? `Discard this pick session? Your ${fmtInt(count)} pick${count === 1 ? "" : "s"} won’t be saved.` : "Discard this pick session?";
  if (!(await confirmDialog(msg, "Discard"))) return false;
  db.discardDraft(id);
  store("pick", null);
  return true;
}
$("pick-discard").addEventListener("click", async () => {
  if (pk && (await discardDraft(pk.draft.draft_id, pk.picks.length))) endPicking();
});

async function checkPickResume() {
  const saved = recall("pick");
  if (!saved?.id || pk) return;
  try {
    const data = db.getDraft(saved.id);
    const picks = (Array.isArray(saved.picks) ? saved.picks : []).filter((k) => k === 0 || k === 1).slice(0, data.n);
    resumable = { draft: data, picks };
    $("pick-resume-text").textContent = `${data.label ? `“${data.label}” · ` : ""}${fmtInt(picks.length)} of ${fmtInt(data.n)} rounds picked.`;
    $("pick-resume").hidden = false;
  } catch (err) {
    if (err.status === 404) store("pick", null);
  }
}
$("pick-resume-go").addEventListener("click", () => {
  if (resumable) { setMode("pick"); beginPicking(resumable.draft, resumable.picks); resumable = null; }
});
$("pick-resume-discard").addEventListener("click", async () => {
  if (resumable && (await discardDraft(resumable.draft.draft_id, resumable.picks.length))) {
    resumable = null;
    $("pick-resume").hidden = true;
  }
});

/* ---------- log view ---------- */
const PAGE = 30;
let logItems = [], logTotal = 0;

async function loadLog(reset = true) {
  if (reset) logItems = [];
  const [lo, hi] = ($("log-size").value || "-").split("-");
  try {
    const data = await db.listSessions({ limit: PAGE, offset: logItems.length, sort: $("log-sort").value,
      min_n: lo ? +lo : null, max_n: hi ? +hi : null, mode: $("log-mode").value || null });
    logItems = logItems.concat(data.items);
    logTotal = data.total;
    renderLog();
  } catch (err) {
    $("log-count").textContent = err.message;
  }
}
function renderLog() {
  $("log-list").innerHTML = logItems.map((r) => `
    <li data-id="${r.id}">
      <a href="#session/${r.id}">
        <div class="row1"><span class="lbl">${r.mode === "pick" ? '<span class="badge">Pick</span>' : ""}${esc(r.label || fmtDate(r.created_at))}</span><span class="num">${fmtInt(r.n_tosses)}</span></div>
        <div class="row2"><span>${r.label ? fmtDate(r.created_at) : "&nbsp;"}</span>
          <span class="num">${fmtPct(r.heads_pct, pctDigits(r.n_tosses))} H · streak ${fmtInt(r.longest_streak)}</span></div>
      </a>
      <button class="del" aria-label="Delete session" data-del="${r.id}">✕</button>
    </li>`).join("");
  $("log-count").textContent = logTotal ? `${fmtInt(logTotal)} session${logTotal === 1 ? "" : "s"}` : "";
  $("log-more").hidden = logItems.length >= logTotal;
  const filtered = $("log-size").value || $("log-mode").value;
  $("log-empty").hidden = logTotal > 0 || !!filtered;
  if (!logTotal && filtered) $("log-count").textContent = "No sessions match these filters.";
}
$("log-sort").addEventListener("change", () => loadLog());
$("log-size").addEventListener("change", () => loadLog());
$("log-mode").addEventListener("change", () => loadLog());
$("log-more").addEventListener("click", () => loadLog(false));
$("log-list").addEventListener("click", async (e) => {
  const id = e.target.closest("[data-del]")?.dataset.del;
  if (!id) return;
  const r = logItems.find((x) => String(x.id) === id);
  if (await deleteSession(+id, r)) { logItems = logItems.filter((x) => x !== r); logTotal--; renderLog(); }
});

function confirmDialog(text, okLabel = "Delete") {
  const dlg = $("confirm");
  $("confirm-text").textContent = text;
  dlg.querySelector('button[value="ok"]').textContent = okLabel;
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true });
    dlg.returnValue = "";
    dlg.showModal();
  });
}
async function deleteSession(id, r) {
  const unit = r?.mode === "pick" ? "rounds" : "tosses";
  const what = r ? `${r.label ? `“${r.label}” ` : ""}(${fmtInt(r.n_tosses)} ${unit}, ${fmtDate(r.created_at)})` : "this session";
  if (!(await confirmDialog(`Delete ${what}? This can’t be undone.`))) return false;
  try { await db.deleteSession(id); }
  catch (err) { alert(err.message); return false; }
  if (lastResult?.id === id) { lastResult = null; $("toss-result").innerHTML = ""; }
  return true;
}

/* ---------- session detail ---------- */
let current = null;
async function loadSession(id) {
  $("session-body").innerHTML = `<div class="empty">Loading…</div>`;
  $("session-delete").hidden = true;
  try {
    const data = await db.getSession(id);
    current = data;
    $("title").textContent = data.label || "Session";
    renderSession($("session-body"), data, "detail");
    $("session-delete").hidden = false;
  } catch (err) {
    $("session-body").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}
$("session-delete").addEventListener("click", async () => {
  if (current && (await deleteSession(current.id, current))) location.hash = "#log";
});
$("back").addEventListener("click", () => { location.hash = "#log"; });

/* ---------- lifetime stats ---------- */
let lifetimeData = null;
const normPdf = (z) => Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);

async function loadStats() {
  try {
    const data = await db.lifetimeStats();
    lifetimeData = data;
    renderStats(data);
  } catch (err) {
    $("stats-body").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

function recordLink(r, key, value) {
  if (!r) return "";
  return `<li><a href="#session/${r.session_id}"><div class="rk">${key}</div>
    <div class="rv">${value}</div><div class="rk">${esc(r.label ? r.label + " · " : "")}${fmtDate(r.created_at)}</div></a></li>`;
}

function pickStatsHtml(P) {
  return `<div class="card">
    <h2><span class="badge">Pick</span>Pick mode</h2>
    ${verdictHtml(P.choice_verdict, P.choice_p)}
    <dl class="kv">
      <dt>Sessions</dt><dd>${fmtInt(P.sessions)}</dd>
      <dt>Rounds played</dt><dd>${fmtInt(P.rounds)}</dd>
      <dt>Real choices</dt><dd>${fmtInt(P.choices)}<span class="sub">coins differed</span></dd>
      <dt>You kept heads</dt><dd>${P.choices ? fmtPct(P.chose_heads_pct) : "—"}<span class="sub">when you had a choice · z ${fmtZ(P.choice_z)}, p = ${fmtP(P.choice_p)}</span></dd>
      <dt>Kept heads overall</dt><dd>${fmtPct(P.kept_heads_pct)}</dd>
      <dt>Coin A / coin B</dt><dd>${fmtPct(100 - P.chose_b_pct)} / ${fmtPct(P.chose_b_pct)}</dd>
      <dt>All coins shown</dt><dd>${fmtPct(P.raw_heads_pct, pctDigits(P.raw_total))} heads<span class="sub">${fmtInt(P.raw_total)} coins · p = ${fmtP(P.raw_p)}</span></dd>
    </dl>
  </div>`;
}

const DATA_CARD = `<div class="card">
    <h2>Your data</h2>
    <div class="hint">Sessions are saved in this browser on this device only. Export a backup now and then, or to move your history to another device.</div>
    <div class="pick-actions" style="margin-top:12px">
      <button type="button" id="data-export" class="secondary">Export backup</button>
      <button type="button" id="data-import" class="secondary">Import…</button>
    </div>
    <input type="file" id="data-file" accept="application/json,.json" hidden>
    <div id="data-msg" class="hint" role="status" style="margin-top:10px"></div>
  </div>`;

function renderStats(L) {
  const body = $("stats-body");
  const pickCard = L.pick ? pickStatsHtml(L.pick) : "";
  if (!L.sessions) {
    body.innerHTML = (L.pick
      ? `<div class="empty">No simulated sessions yet.</div>${pickCard}`
      : `<div class="empty">No sessions yet. Lifetime stats appear after your first toss.</div>`) + DATA_CARD;
    return;
  }
  const d = pctDigits(L.tosses), R = L.records, ls = L.longest_streak;
  body.innerHTML = `
    ${L.pick ? `<div class="hint" style="margin-top:12px">Totals, charts and records cover simulated sessions. Pick sessions are summarised at the bottom, because your choices bias them.</div>` : ""}
    <div class="tiles" style="margin-top:12px">
      <div class="tile"><div class="k">Sessions</div><div class="v">${fmtInt(L.sessions)}</div></div>
      <div class="tile"><div class="k">Tosses</div><div class="v">${fmtInt(L.tosses)}</div></div>
      <div class="tile"><div class="k">Heads</div><div class="v">${fmtInt(L.heads)}</div></div>
      <div class="tile"><div class="k">Tails</div><div class="v">${fmtInt(L.tails)}</div></div>
    </div>
    <div class="card">
      <h2>Overall heads: <span class="num">${fmtPct(L.heads_pct, d)}</span></h2>
      ${verdictHtml(`z = ${fmtZ(L.z_score)}, p = ${fmtP(L.p_value)}. ` + (L.p_value >= 0.05 ? "All tosses together look fair." : "All tosses together are unusually lopsided."), L.p_value)}
    </div>
    ${ls ? `<div class="card"><h2>Longest streak ever</h2>
      <ul class="records">${recordLink(ls, ls.side === "H" ? "Heads" : "Tails",
        `${fmtInt(ls.length)} in a row${ls.start ? `, from toss ${fmtInt(ls.start)}` : ""}`)}</ul></div>` : ""}
    <div class="card">
      <h2>Cumulative heads % over time</h2>
      <div class="legend"><span class="line" style="--c:var(--heads)">Heads %</span><span class="line" style="--c:var(--ref)">50%</span><span class="band">±2σ</span></div>
      <div class="chart-box"><canvas id="life-cum" role="img" aria-label="Cumulative heads percentage over sessions"></canvas></div>
      <div class="chart-note">One point per session, oldest to newest.</div>
    </div>
    <div class="card">
      <h2>Session z-scores vs. normal curve</h2>
      <div class="legend"><span style="--c:var(--heads)">Sessions</span><span class="line" style="--c:var(--ref)">Expected for a fair coin</span></div>
      <div class="chart-box"><canvas id="life-z" role="img" aria-label="Histogram of per-session z-scores"></canvas></div>
      <div class="chart-note">If the coin is fair, bars follow the curve as sessions accumulate.</div>
    </div>
    <div class="card"><h2>Records</h2><ul class="records">
      ${recordLink(R.biggest, "Biggest session", `${fmtInt(R.biggest.n_tosses)} tosses`)}
      ${recordLink(R.most_lopsided, "Most lopsided (largest |z|)", `z = ${fmtZ(R.most_lopsided.z_score)}, p = ${fmtP(R.most_lopsided.p_value)} · ${fmtPct(R.most_lopsided.heads_pct, pctDigits(R.most_lopsided.n_tosses))} heads`)}
      ${R.most_extreme_pct ? recordLink(R.most_extreme_pct, "Most extreme heads % (100+ tosses)", `${fmtPct(R.most_extreme_pct.heads_pct, 2)} heads in ${fmtInt(R.most_extreme_pct.n_tosses)}`) : ""}
      ${recordLink(R.longest_heads, "Longest heads streak", `${fmtInt(R.longest_heads.length)}`)}
      ${recordLink(R.longest_tails, "Longest tails streak", `${fmtInt(R.longest_tails.length)}`)}
    </ul></div>
    ${pickCard}
    ${DATA_CARD}`;
  cumulativeChart(L);
  zChart(L);
}

function cumulativeChart(L) {
  const c = L.cumulative;
  const o = baseOptions();
  o.scales.x.ticks = { ...o.scales.x.ticks, autoSkip: true, maxTicksLimit: 6 };
  o.scales.y.ticks = { callback: (v) => v.toFixed(Math.min(4, pctDigits(c[c.length - 1].tosses))) + "%" };
  o.plugins.tooltip.filter = (item) => item.datasetIndex === 0;
  o.plugins.tooltip.callbacks = {
    title: (items) => `Session ${items[0].dataIndex + 1} · ${fmtDate(c[items[0].dataIndex].created_at)}`,
    label: (item) => ` Heads ${item.parsed.y.toFixed(pctDigits(c[item.dataIndex].tosses))}% of ${fmtInt(c[item.dataIndex].tosses)}`,
  };
  const band = (k, sign) => Math.min(100, Math.max(0, 50 + (sign * 100) / Math.sqrt(k)));
  const ys = c.map((p) => p.heads_pct);
  const lo = Math.min(...ys, ...c.map((p) => band(p.tosses, -1))), hi = Math.max(...ys, ...c.map((p) => band(p.tosses, 1)));
  const pad = Math.max((hi - lo) * 0.1, 0.0001);
  o.scales.y.min = Math.max(0, lo - pad); o.scales.y.max = Math.min(100, hi + pad);
  makeChart("life-cum", {
    type: "line",
    data: { labels: c.map((p) => fmtDay(p.created_at)), datasets: [
      { label: "Heads %", data: ys, borderColor: css("--heads"), borderWidth: 2, pointRadius: c.length <= 40 ? 3 : 0, pointHoverRadius: 5, order: 0 },
      { label: "+2σ", data: c.map((p) => band(p.tosses, 1)), borderColor: "transparent", backgroundColor: css("--band"), pointRadius: 0, fill: "+1", order: 2 },
      { label: "−2σ", data: c.map((p) => band(p.tosses, -1)), borderColor: "transparent", pointRadius: 0, order: 2 },
      { label: "50%", data: c.map(() => 50), borderColor: css("--ref"), borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, order: 1 },
    ] },
    options: o,
  });
}

function zChart(L) {
  const W = 0.5, LIM = 4; // bins of 0.5σ from −4 to +4; outliers go in the end bins
  const nb = (2 * LIM) / W;
  const counts = new Array(nb).fill(0);
  for (const z of L.z_scores) counts[Math.min(nb - 1, Math.max(0, Math.floor((z + LIM) / W)))]++;
  const centers = counts.map((_, i) => -LIM + W * (i + 0.5));
  const expected = centers.map((x) => L.sessions * W * normPdf(x));
  const o = baseOptions();
  o.scales.x = { ...o.scales.x, grid: { display: false }, title: { display: true, text: "z-score (σ)" } };
  o.scales.y = { ...o.scales.y, beginAtZero: true, title: { display: true, text: "Sessions" },
    ticks: { callback: (v) => (Number.isInteger(v) ? v : null) } };
  o.plugins.tooltip.callbacks = {
    title: (items) => { const x = centers[items[0].dataIndex]; return `z from ${(x - W / 2).toFixed(1)} to ${(x + W / 2).toFixed(1)}`; },
    label: (item) => item.datasetIndex === 0 ? ` Sessions: ${item.parsed.y}` : ` Expected: ${item.parsed.y.toFixed(1)}`,
  };
  makeChart("life-z", {
    data: { labels: centers.map((x) => x.toFixed(2)),
      datasets: [
        { type: "bar", label: "Sessions", data: counts, backgroundColor: css("--heads"), borderColor: css("--surface"),
          borderWidth: { left: 1, right: 1 }, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom",
          categoryPercentage: 1, barPercentage: 0.94, order: 1 },
        { type: "line", label: "Expected", data: expected, borderColor: css("--ref"), borderWidth: 2, pointRadius: 0, tension: 0.35, order: 0 },
      ] },
    options: { ...o, scales: { ...o.scales, x: { ...o.scales.x, ticks: { ...o.scales.x.ticks, autoSkip: false,
      callback: (v, i) => { const lo = centers[i] - W / 2; return Number.isInteger(lo) ? String(lo) : null; } } } } },
  });
}

$("stats-body").addEventListener("click", async (e) => {
  const msg = $("data-msg");
  if (e.target.id === "data-import") { $("data-file").click(); return; }
  if (e.target.id !== "data-export") return;
  try {
    const data = await db.exportAll();
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const name = `coinstorm-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([blob], name, { type: "application/json" });
    // iPhone: the share sheet lets you save to Files or AirDrop it. Elsewhere: a normal download.
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "Coinstorm backup" }).catch((err) => { if (err.name !== "AbortError") throw err; });
    } else {
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    msg.textContent = `Exported ${fmtInt(data.sessions.length)} session${data.sessions.length === 1 ? "" : "s"}.`;
  } catch (err) { msg.textContent = `Export failed: ${err.message}`; }
});
$("stats-body").addEventListener("change", async (e) => {
  if (e.target.id !== "data-file" || !e.target.files[0]) return;
  const msg = $("data-msg");
  msg.textContent = "Importing…";
  try {
    const { added, skipped } = await db.importAll(JSON.parse(await e.target.files[0].text()));
    await loadStats();
    $("data-msg").textContent = `Imported ${fmtInt(added)} session${added === 1 ? "" : "s"}` + (skipped ? `, skipped ${fmtInt(skipped)} already here or unreadable.` : ".");
  } catch (err) {
    msg.textContent = `Import failed: ${err instanceof SyntaxError ? "that file isn’t valid JSON." : err.message}`;
  }
});

/* ---------- routing ---------- */
function route() {
  const h = location.hash.replace(/^#/, "") || "toss";
  const [view, arg] = h.split("/");
  const name = ["toss", "log", "stats", "session"].includes(view) ? view : "toss";
  for (const v of ["toss", "log", "stats", "session"]) $(`view-${v}`).hidden = v !== name;
  const tab = name === "session" ? "log" : name;
  document.querySelectorAll(".tabbar a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  $("back").hidden = name !== "session";
  $("title").textContent = { toss: "Toss", log: "Log", stats: "Stats", session: "Session" }[name];
  if (name === "log") loadLog();
  if (name === "stats") loadStats();
  if (name === "session") loadSession(+arg);
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

// Redraw charts with the new palette when the system theme flips.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (lastResult && !$("toss-result").hidden) renderSession($("toss-result"), lastResult, "toss");
  if (!$("view-session").hidden && current) renderSession($("session-body"), current, "detail");
  if (!$("view-stats").hidden && lifetimeData) renderStats(lifetimeData);
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
setMode(recall("mode") || "simulate");
route();
checkPickResume();
