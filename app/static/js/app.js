/* Dockle front end - one window, hash routing, no frameworks. */
"use strict";

const CSRF = document.querySelector('meta[name="csrf"]').content;
const content = document.getElementById("content");
const stackListEl = document.getElementById("stackList");
const versionsEl = document.getElementById("versions");

let stacksCache = [];
let liveSockets = [];
let dashboardDnsName = "";
// Set when a dashboard card's update dot is clicked: the update itself
// runs on the stack's own page so its output streams into the panel
// there, exactly like pressing Update, instead of happening silently
// behind a spinner on the card.
let pendingStackAction = null;

/* ---------- helpers ---------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", "X-CSRF": CSRF },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = "/login"; throw new Error("signed out"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function closeLiveSockets() {
  liveSockets.forEach(ws => { try { ws.close(); } catch (e) {} });
  liveSockets = [];
}

function classifyLogLine(line) {
  if (/\b(error|err!|fatal|panic|exception|traceback|failed|failure)\b/i.test(line)) return "log-error";
  if (/\b(warn|warning|deprecated)\b/i.test(line)) return "log-warn";
  return "";
}

function appendLog(view, line) {
  const div = document.createElement("div");
  const cls = classifyLogLine(line);
  if (cls) div.className = cls;
  div.textContent = line;
  const stick = view.scrollTop + view.clientHeight >= view.scrollHeight - 40;
  view.appendChild(div);
  while (view.childElementCount > 2000) view.firstElementChild.remove();
  if (stick) view.scrollTop = view.scrollHeight;
}

/* A specific, actionable explanation for Docker's "address already in
   use" error when the real cause is Tailscale Serve still holding a
   port from a deleted-and-recreated stack - rendered as a distinct
   alert box instead of leaving the user to decode raw stderr. */
function renderPortConflictHint(view, port, companionAvailable) {
  const box = el(`<div class="alert alert-warning port-conflict-hint">
    <p><strong>Port ${port} is stuck.</strong> Tailscale Serve is still holding it open from a
    previous version of this stack, so Docker can't bind it.</p>
    ${companionAvailable
      ? `<p>The dockle-companion should clear this automatically - if you're seeing this anyway,
         check <a href="#/settings">Settings → Host OS & Tailscale</a> that it's still running.</p>`
      : `<p>Fix it now: <code>sudo tailscale serve --https=${port} off</code> on the host, then try
         again. Restore it afterward with
         <code>sudo tailscale serve --bg --https=${port} http://127.0.0.1:${port}</code>.</p>
         <p>Or install the <a href="#/settings">dockle-companion</a> once and Dockle handles this
         automatically from now on.</p>`}
  </div>`);
  view.appendChild(box);
  view.scrollTop = view.scrollHeight;
}

/* A small, dismissible floating panel for narrating a long-running
   background action (e.g. installing the companion) - pinned to the
   viewport, closable at any time via the X, independent of whatever
   else is on screen. Only one at a time; a new one replaces the last. */
function openProgressPanel(title) {
  document.querySelectorAll(".progress-panel").forEach(p => p.remove());
  const panel = el(`<div class="progress-panel">
    <div class="progress-panel-head">
      <span class="status-dot warning" id="progressDot"></span>
      <span class="title">${esc(title)}</span>
      <button class="icon-btn" id="progressClose" aria-label="Dismiss" title="Dismiss">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
      </button>
    </div>
    <div class="progress-panel-body log-view" id="progressBody"></div>
  </div>`);
  document.body.appendChild(panel);
  panel.querySelector("#progressClose").addEventListener("click", () => panel.remove());
  const body = panel.querySelector("#progressBody");
  const dot = panel.querySelector("#progressDot");
  return {
    line(text) { if (panel.isConnected) appendLog(body, text); },
    done(ok) { if (panel.isConnected) dot.className = "status-dot " + (ok ? "running" : ""); },
    closed() { return !panel.isConnected; },
    close() { panel.remove(); },
  };
}

/* Inline-tick destructive confirm: first click arms (red), second click within
   4s fires; the button then flashes a tick. Never a popup. */
function armedAction(btn, run, label) {
  let armed = null;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    if (!armed) {
      btn.classList.add("confirming");
      btn.dataset.tip = `Click again to ${label}`;
      armed = setTimeout(() => { btn.classList.remove("confirming"); armed = null; btn.dataset.tip = btn.dataset.tipOrig; }, 4000);
      return;
    }
    clearTimeout(armed); armed = null;
    btn.classList.remove("confirming");
    btn.disabled = true;
    try {
      await run();
      btn.classList.add("success-flash");
      btn.innerHTML = ICONS.tick;
      setTimeout(() => location.hash = "#/", 700);
    } catch (e) {
      btn.disabled = false;
      popAlert(btn, e.message, "danger");
    }
  });
}

/* The one mechanism for every contextual alert in the app: a bubble
   anchored to whatever element the message is actually about, with an
   arrow pointing at it - never a generic toast lost at the bottom of
   the page. Reuses the [data-tip] tooltip CSS (forced open instead of
   waiting for hover), and restores whatever hover tooltip the element
   already had once the alert fades. */
function popAlert(el, message, kind = "info", ms = 3500) {
  if (!el) return;
  // kind is accepted (danger/success/warning/info) for callers to stay
  // self-documenting, but deliberately doesn't change the bubble's
  // colour - every alert stays the same neutral --tip-fg, never
  // tinted red/green/amber.
  // Capture whatever tooltip the element is resting at right now (its
  // normal hover text, or "" if it has none) - but only on the first
  // call of a sequence, so a caller that legitimately changes the
  // resting tooltip mid-flow (e.g. the update button's own state)
  // isn't clobbered back to a stale value once this fades.
  if (!el._tipTimer) el._tipRestingValue = el.dataset.tip ?? "";
  el.dataset.tip = message;
  el.classList.add("tip-visible");
  clearTimeout(el._tipTimer);
  el._tipTimer = setTimeout(() => {
    el.classList.remove("tip-visible");
    el.dataset.tip = el._tipRestingValue;
    el._tipTimer = null;
  }, ms);
}

/* Code editor: wraps a plain textarea with CodeMirror so every text
   field in the app (compose YAML, .env) shares the same look - dark,
   monospace, line numbers. YAML mode additionally debounces calls to
   the server's own compose validator (the single source of truth for
   "is this valid compose", already used on save) for inline feedback. */
function attachCodeEditor(textareaEl, { mode = null, validate = false, getName = null, getEnv = null } = {}) {
  const frame = document.createElement("div");
  frame.className = "editor-frame";
  textareaEl.parentNode.insertBefore(frame, textareaEl);
  frame.appendChild(textareaEl);

  const cm = CodeMirror.fromTextArea(textareaEl, {
    mode, lineNumbers: true, matchBrackets: true,
    styleActiveLine: true, tabSize: 2, indentUnit: 2,
    viewportMargin: Infinity,
  });

  if (!validate) return cm;

  cm.recheck = () => check();

  const status = document.createElement("div");
  status.className = "editor-status";
  status.setAttribute("role", "status");
  status.innerHTML = '<span class="dot"></span><span class="msg">Checking…</span>';
  frame.appendChild(status);

  let timer, requestSeq = 0;
  const setStatus = (cls, msg) => {
    status.className = "editor-status " + cls;
    status.querySelector(".msg").textContent = msg;
  };
  const check = async () => {
    const seq = ++requestSeq;
    const text = cm.getValue();
    if (!text.trim()) { setStatus("", "Empty"); return; }
    const body = { compose: text };
    if (getName) body.name = getName();
    if (getEnv) body.env = getEnv();
    try {
      const res = await api("/api/validate", { method: "POST", body });
      if (seq !== requestSeq) return; // a newer edit already superseded this check
      if (!res.ok) { setStatus("bad", res.error); return; }
      if (res.portConflicts && res.portConflicts.length) {
        const msg = res.portConflicts
          .map(c => `port ${c.port} is already used by '${c.with}'`).join("; ");
        setStatus("warn", `Looks good, but ${msg}`);
      } else {
        setStatus("ok", "Looks good");
      }
    } catch (e) {
      if (seq === requestSeq) setStatus("", "Couldn't check right now");
    }
  };
  cm.on("change", () => { clearTimeout(timer); timer = setTimeout(check, 600); });
  check();
  return cm;
}

function attachYamlEditor(textareaEl, opts = {}) {
  return attachCodeEditor(textareaEl, { mode: "yaml", validate: true, ...opts });
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  redeploy: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M9.5 12a2.7 2.7 0 0 1 4.5-2M14.5 12a2.7 2.7 0 0 1-4.5 2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>',
  update: '<svg viewBox="0 0 24 24"><path d="M12 4v9m0 0l-3.5-3.5M12 13l3.5-3.5M5 17v1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bin: '<svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0l-.8 12a2 2 0 0 1-2 1.9H9.8a2 2 0 0 1-2-1.9L7 7m3 4v6m4-6v6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M4 9l8 7 8-7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tick: '<svg viewBox="0 0 24 24"><path d="M5 13l4.5 4.5L19 8" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  external: '<svg viewBox="0 0 24 24"><path d="M14 5h5v5M19 5l-8 8M8 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  checkUpdate: '<svg viewBox="0 0 24 24"><path d="M7 18h9.5a3.5 3.5 0 0 0 .5-6.96 5 5 0 0 0-9.71-1.79A4 4 0 0 0 7 18Z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/><path d="M9 12.5l1.8 1.8L15 10" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/* ---------- sidebar / engine ---------- */

async function refreshStacks() {
  try {
    const data = await api("/api/stacks");
    stacksCache = data.stacks;
    dashboardDnsName = data.dnsName || "";
    renderStackList();
  } catch (e) {
    // Callers treat this as best-effort; the sidebar's Docker row is
    // where an unreachable engine is actually reported now.
    renderStackList();
  }
}

/* Versions, bottom of the sidebar: a number each for Dockle and Docker,
   with a tick when there's something real to tick. Dockle's tick means
   up to date with the repo; Docker's means Dockle is talking to it (the
   newest Docker release isn't knowable from inside a container, so a
   tick claiming otherwise would be a lie). No answer yet - the check
   runs in the background - shows the number alone. */
async function renderVersions() {
  if (!versionsEl) return;
  let v;
  try { v = await api("/api/system/versions"); }
  catch (e) {
    versionsEl.innerHTML = `<div class="version-row bad">${esc(e.message)}</div>`;
    return;
  }
  const tick = '<span class="version-tick" aria-hidden="true">✓</span>';
  const rows = [];

  const d = v.dockle || {};
  let dockleMark = "", dockleTip = "Version check hasn't run yet";
  if (d.upToDate === true) { dockleMark = tick; dockleTip = "Up to date"; }
  else if (d.behind > 0) {
    dockleMark = '<span class="version-behind" aria-hidden="true">↑</span>';
    dockleTip = `${d.behind} newer commit${d.behind === 1 ? "" : "s"} available - Settings → Dockle itself`;
  }
  rows.push(`<div class="version-row" data-tip="${esc(dockleTip)}">
    <span class="version-name">Dockle</span>
    <span class="version-num">${esc(d.version || "?")}</span>${dockleMark}</div>`);

  const k = v.docker || {};
  rows.push(`<div class="version-row ${k.ok ? "" : "bad"}" data-tip="${esc(k.ok ? "Connected" : (k.error || "Engine unreachable"))}">
    <span class="version-name">${esc(k.engine || "Docker")}</span>
    <span class="version-num">${esc(k.version || "unreachable")}</span>${k.ok ? tick : ""}</div>`);

  versionsEl.innerHTML = rows.join("");

  // First load after a restart has no cached answer yet: the server has
  // just kicked the check off in the background, so look again shortly
  // rather than leaving the row blank until the next minute ticks over.
  if (d.upToDate === null && !renderVersions.retried) {
    renderVersions.retried = true;
    setTimeout(() => { renderVersions.retried = false; renderVersions(); }, 5000);
  }
}

function renderStackList() {
  const current = location.hash;
  const managed = stacksCache.filter(s => s.managed);
  stackListEl.innerHTML = "";
  if (!managed.length) {
    stackListEl.appendChild(el('<li class="hint hint-tight">No stacks yet</li>'));
  }
  for (const s of managed) {
    const href = `#/stack/${encodeURIComponent(s.name)}`;
    const effectiveStatus = s.updateAvailable ? "update" : s.status;
    const dotTip = STATUS_TIPS[effectiveStatus] || "Container is down";
    const a = el(`<a href="${href}" ${current === href ? 'class="active"' : ""}>
      <span class="status-dot ${STATUS_DOT_CLASS[effectiveStatus] || ""}" data-tip="${esc(dotTip)}"></span><span>${esc(s.name)}</span></a>`);
    const li = document.createElement("li");
    li.appendChild(a);
    stackListEl.appendChild(li);
  }
}

/* ---------- router ---------- */

const routes = [
  [/^#?\/?$/, viewDashboard],
  [/^#\/new$/, viewNewStack],
  [/^#\/stack\/([^/]+)$/, (m) => viewStack(decodeURIComponent(m[1]))],
  [/^#\/maintenance$/, viewMaintenance],
  [/^#\/activity$/, viewActivity],
  [/^#\/backups$/, viewBackups],
  [/^#\/settings$/, viewSettings],
  [/^#\/dockle$/, viewDockleStack],
  [/^#\/help$/, viewHelp],
];

async function route() {
  closeLiveSockets();
  document.getElementById("sidebar").classList.remove("open");
  document.querySelectorAll(".topbar-navlink").forEach(a =>
    a.classList.toggle("active", location.hash.startsWith(a.getAttribute("href"))));
  renderStackList();
  const hash = location.hash || "#/";
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) { await fn(m); content.focus({ preventScroll: true }); return; }
  }
  location.hash = "#/";
}

/* ---------- views ---------- */

async function viewDashboard() {
  content.innerHTML = `<div class="panel-head">
    <h1>Stacks</h1><span class="spacer"></span>
    <button class="btn" id="checkUpdatesBtn" data-tip="Check every stack for a newer image right now, instead of waiting for the next automatic pass">Check for updates</button>
  </div>`;
  await refreshStacks();
  document.getElementById("checkUpdatesBtn")?.addEventListener("click", checkUpdatesNow);

  let discovered = { projects: [], standalone: [] };
  try { discovered = await api("/api/discover"); } catch (e) { /* non-fatal */ }

  const managed = stacksCache.filter(s => s.managed);
  const unmanagedCount = discovered.projects.length + discovered.standalone.length;
  if (!managed.length && !unmanagedCount) {
    content.appendChild(el(`<div class="panel"><h3>Nothing here yet</h3>
      <p>Create your first stack with <strong>New stack</strong>.</p></div>`));
    return;
  }

  const updatable = managed.filter(s => s.updateAvailable);
  if (updatable.length) {
    const panel = el(`<div class="panel"><div class="panel-head">
      <h3>${updatable.length} update${updatable.length === 1 ? "" : "s"} available</h3><span class="spacer"></span>
      <button class="btn btn-primary" id="updateAllBtn">Update all</button></div>
      <p class="hint">Pulls the newest image and redeploys each one, one after another: ${esc(updatable.map(s => s.name).join(", "))}.</p></div>`);
    content.appendChild(panel);
    panel.querySelector("#updateAllBtn").addEventListener("click", updateAll);
  }

  let onboarding = { offerBulkAdopt: false };
  try { onboarding = await api("/api/onboarding"); } catch (e) { /* non-fatal */ }

  if (onboarding.offerBulkAdopt && unmanagedCount > 0) {
    content.appendChild(renderAdoptPanel({ firstRun: true, count: unmanagedCount }));
  } else if (unmanagedCount > 1) {
    content.appendChild(renderAdoptPanel({ firstRun: false, count: unmanagedCount }));
  }

  const grid = el('<div class="stack-grid" id="grid"></div>');
  content.appendChild(grid);
  const statusByName = Object.fromEntries(stacksCache.map(s => [s.name, s.status]));
  for (const s of managed) grid.appendChild(managedCard(s));
  // Dockle is a container like any other and belongs in the same grid -
  // its card just leads to a page whose buttons know they're acting on
  // the thing serving them.
  try {
    const self = await api("/api/system/self");
    if (self.available) grid.appendChild(dockleCard(self));
  } catch (e) { /* non-fatal - the rest of the dashboard still stands */ }
  for (const p of discovered.projects) grid.appendChild(unmanagedCard(p, statusByName[p.name] || "running"));
  for (const c of discovered.standalone) grid.appendChild(standaloneCard(c));

  await renderArchivedSection();
}

async function renderArchivedSection() {
  let archived = { stacks: [] };
  try { archived = await api("/api/archived"); } catch (e) { /* non-fatal */ }
  if (!archived.stacks.length) return;

  const panel = el(`<div class="panel">
    <div class="panel-head"><h3>Archived (${archived.stacks.length})</h3><span class="spacer"></span>
      <button class="btn" id="archivedToggle">Show</button></div>
    <div id="archivedBody" class="hidden"></div>
  </div>`);
  content.appendChild(panel);
  const toggle = panel.querySelector("#archivedToggle");
  const body = panel.querySelector("#archivedBody");
  toggle.addEventListener("click", () => {
    const showing = !body.classList.contains("hidden");
    body.classList.toggle("hidden", showing);
    toggle.textContent = showing ? "Show" : "Hide";
  });

  for (const name of archived.stacks) {
    const row = el(`<div class="check-row archived-row">
      <span>${esc(name)}</span><span class="spacer"></span>
      <button class="btn" id="restoreBtn">Restore</button>
      <button class="btn btn-danger" id="purgeBtn">Delete</button>
    </div>`);
    body.appendChild(row);
    row.querySelector("#restoreBtn").addEventListener("click", async (e) => {
      e.target.disabled = true; e.target.textContent = "Restoring…";
      try {
        await api(`/api/archived/${encodeURIComponent(name)}/restore`, { method: "POST", body: {} });
        popAlert(e.target, `'${name}' restored.`, "success");
        await refreshStacks();
        await new Promise(r => setTimeout(r, 900)); // let the confirmation actually be seen before the view changes
        viewDashboard();
      } catch (err) { popAlert(e.target, err.message, "danger"); e.target.disabled = false; e.target.textContent = "Restore"; }
    });
    const purgeBtn = row.querySelector("#purgeBtn");
    purgeBtn.dataset.tipOrig = "Delete";
    armedAction(purgeBtn, async () => {
      const res = await api(`/api/archived/${encodeURIComponent(name)}/purge`, { method: "POST", body: {} });
      popAlert(purgeBtn, res.removedImages.length ? `'${name}' deleted, image(s) removed.` : `'${name}' deleted.`, "success");
      await new Promise(r => setTimeout(r, 900));
      viewDashboard();
    }, "permanently delete this archived stack and its image - nothing kept");
  }
}

async function checkUpdatesNow() {
  const btn = document.getElementById("checkUpdatesBtn");
  btn.disabled = true; btn.textContent = "Checking…";
  try {
    const res = await api("/api/stacks/check-updates", { method: "POST", body: {} });
    if (!res.started) {
      popAlert(btn, res.message || "A check is already running.", "info");
      btn.disabled = false; btn.textContent = "Check for updates";
      return;
    }
    // poll until the background check finishes, then reload with fresh badges
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      const status = await api("/api/stacks/check-updates/status");
      if (!status.checking) break;
    }
    popAlert(btn, "Update check finished.", "success");
    if ((location.hash || "#/") === "#/") viewDashboard();
  } catch (e) {
    popAlert(btn, e.message, "danger");
    btn.disabled = false; btn.textContent = "Check for updates";
  }
}

async function updateAll() {
  const btn = document.getElementById("updateAllBtn");
  btn.disabled = true; btn.textContent = "Updating…";
  try {
    const res = await api("/api/stacks/update-all", { method: "POST", body: {} });
    popAlert(btn, `Updated ${res.updated} of ${res.total}.`, res.updated === res.total ? "success" : "warning");
    await refreshStacks();
    viewDashboard();
  } catch (e) {
    btn.disabled = false; btn.textContent = "Update all";
    popAlert(btn, e.message, "danger");
  }
}

function renderAdoptPanel({ firstRun, count }) {
  const heading = firstRun ? "Welcome to Dockle" : `${count} thing${count === 1 ? "" : "s"} not adopted yet`;
  const blurb = firstRun
    ? `Found ${count} thing${count === 1 ? "" : "s"} already running on this system. Adopting copies each one's
       setup into the stacks folder so Dockle can manage it - nothing running is restarted or changed.`
    : `Copies each one's setup into the stacks folder so Dockle can manage it - nothing running is restarted.`;
  const panel = el(`<div class="panel">
    <div class="panel-head"><h3>${esc(heading)}</h3><span class="spacer"></span>
      <button class="btn btn-primary" id="adoptAllBtn">Adopt all</button>
      ${firstRun ? '<button class="btn" id="skipAdoptBtn">Not now</button>' : ""}</div>
    <p class="hint">${blurb} Skip anything another manager (like Arcane) already looks after - running two
    Docker managers over the same containers can fight over the same files.</p></div>`);
  panel.querySelector("#adoptAllBtn").addEventListener("click", () => adoptAll(firstRun));
  if (firstRun) {
    panel.querySelector("#skipAdoptBtn").addEventListener("click", async () => {
      try { await api("/api/onboarding/dismiss", { method: "POST", body: {} }); } catch (e) { /* ignore */ }
      viewDashboard();
    });
  }
  return panel;
}

async function adoptAll(dismissOnboarding) {
  const btn = document.getElementById("adoptAllBtn");
  btn.disabled = true; btn.textContent = "Adopting…";
  try {
    const res = await api("/api/adopt/all", { method: "POST", body: {} });
    if (dismissOnboarding) {
      try { await api("/api/onboarding/dismiss", { method: "POST", body: {} }); } catch (e) { /* ignore */ }
    }
    popAlert(btn, `Adopted ${res.adopted} of ${res.total}.`, res.adopted === res.total ? "success" : "warning");
    await refreshStacks();
    await new Promise(r => setTimeout(r, 900));
    location.hash = "#/";
    viewDashboard();
  } catch (e) {
    btn.disabled = false; btn.textContent = "Adopt all";
    popAlert(btn, e.message, "danger");
  }
}

const STATUS_TIPS = {
  running: "Container is running",
  update: "Update available - click to update",
  warning: "Warnings - check the log",
  partial: "Some containers are down",
  stopped: "Container is down",
  exited: "Container is down",
  inactive: "No container - ready to archive or delete",
};
// Three colors on a dashboard card: green (good), yellow (update
// ready - click it), red (everything else that isn't simply running,
// including health warnings - a single "something needs attention"
// signal rather than a separate shade for each cause). "inactive" (no
// container at all) is the one exception - not a problem, its own
// neutral gray.
const STATUS_DOT_CLASS = { running: "running", update: "update", inactive: "inactive" };

function cardDot(status) {
  const cls = STATUS_DOT_CLASS[status] || "";
  const tip = STATUS_TIPS[status] || "Container is down";
  return `<span class="status-dot ${cls}" data-tip="${esc(tip)}" tabindex="0" aria-label="${esc(tip)}"></span>`;
}

function managedCard(s) {
  const updateReady = !!s.updateAvailable;
  const effectiveStatus = updateReady ? "update" : s.status;
  const dotTip = STATUS_TIPS[effectiveStatus] || "Container is down";
  const port = s.ports && s.ports.length ? s.ports[0] : null;
  // Only offer to open it when something's actually running to answer -
  // the port is real either way (straight off the compose file), but a
  // link to a dead container is just a broken tab.
  const reachable = s.status === "running" || s.status === "partial";
  const webUrl = port && reachable
    ? (s.served && s.served.includes(port) && dashboardDnsName
        ? `https://${dashboardDnsName}:${port}`
        : `http://${location.hostname}:${port}`)
    : null;
  const inactive = s.status === "inactive";
  const label = `Open stack ${s.name} - ${dotTip}`;
  const card = el(`<div class="panel stack-card" role="link" tabindex="0" aria-label="${esc(label)}">
    <h3><span class="status-dot ${STATUS_DOT_CLASS[effectiveStatus] || ""}" data-tip="${esc(dotTip)}"
      ${updateReady ? 'role="button"' : ""} tabindex="0" aria-label="${esc(dotTip)}"></span><span>${esc(s.name)}</span></h3>
    <span class="hint">${s.containers.length} container${s.containers.length === 1 ? "" : "s"}${port ? ` · port ${port}` : ""}</span>
    ${webUrl || inactive ? `<div class="btn-row card-actions">
      ${webUrl ? `<a class="icon-btn" href="${esc(webUrl)}" target="_blank" rel="noopener" data-tip="Open web UI" aria-label="Open web UI">${ICONS.external}</a>` : ""}
      ${inactive ? `<button class="btn" id="archiveBtn">Archive</button>
      <button class="btn btn-danger" id="purgeBtn">Delete</button>` : ""}
    </div>` : ""}
  </div>`);
  const open = () => location.hash = `#/stack/${encodeURIComponent(s.name)}`;
  card.addEventListener("click", open);
  card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });

  const webLink = card.querySelector("a.icon-btn");
  if (webLink) {
    webLink.addEventListener("click", e => e.stopPropagation());
    webLink.addEventListener("keydown", e => e.stopPropagation());
  }

  if (updateReady) {
    const dot = card.querySelector(".status-dot");
    const runUpdate = (e) => {
      e.stopPropagation();
      dot.classList.add("busy");
      dot.dataset.tip = "Updating…";
      // The card has nowhere to show a pull's output, and an update is
      // exactly the thing you want to watch - hand off to the stack's
      // page, which starts the same streaming update on arrival.
      pendingStackAction = { name: s.name, action: "update" };
      location.hash = `#/stack/${encodeURIComponent(s.name)}`;
    };
    dot.addEventListener("click", runUpdate);
    dot.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); runUpdate(e); }
    });
  }

  if (inactive) {
    const archiveBtn = card.querySelector("#archiveBtn");
    const purgeBtn = card.querySelector("#purgeBtn");
    // Both buttons sit inside the card's own "open on click/Enter/Space"
    // region - stop these events reaching that handler, or using them
    // navigates to the stack page instead of (or as well as) archiving/
    // deleting it.
    [archiveBtn, purgeBtn].forEach(b => b.addEventListener("keydown", e => e.stopPropagation()));
    archiveBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      archiveBtn.disabled = true; archiveBtn.textContent = "Archiving…";
      try {
        await api(`/api/stacks/${encodeURIComponent(s.name)}/archive`, { method: "POST", body: {} });
        popAlert(archiveBtn, `'${s.name}' archived.`, "success");
        await refreshStacks();
        await new Promise(res => setTimeout(res, 900));
        if ((location.hash || "#/") === "#/") viewDashboard();
      } catch (err) {
        archiveBtn.disabled = false; archiveBtn.textContent = "Archive";
        popAlert(archiveBtn, err.message, "danger");
      }
    });
    purgeBtn.dataset.tipOrig = "Delete";
    purgeBtn.addEventListener("click", e => e.stopPropagation());
    armedAction(purgeBtn, async () => {
      const res = await api(`/api/stacks/${encodeURIComponent(s.name)}/purge`, { method: "POST", body: {} });
      popAlert(purgeBtn, res.removedImages.length ? `'${s.name}' deleted, image(s) removed.` : `'${s.name}' deleted.`, "success");
      await refreshStacks();
      await new Promise(res => setTimeout(res, 900));
      if ((location.hash || "#/") === "#/") viewDashboard();
    }, "permanently delete this stack and its image - nothing kept");
  }
  return card;
}

function dockleCard(self) {
  const dotTip = STATUS_TIPS[self.status] || "Container is down";
  const port = self.ports && self.ports.length ? self.ports[0] : null;
  const card = el(`<div class="panel stack-card" role="link" tabindex="0" aria-label="Open Dockle - ${esc(dotTip)}">
    <h3><span class="status-dot ${STATUS_DOT_CLASS[self.status] || ""}" data-tip="${esc(dotTip)}"
      tabindex="0" aria-label="${esc(dotTip)}"></span><span>${esc(self.name)}</span>
      <span class="pill">this is Dockle</span></h3>
    <span class="hint">${self.containers.length} container${self.containers.length === 1 ? "" : "s"}${port ? ` · port ${port}` : ""}</span>
  </div>`);
  const open = () => location.hash = "#/dockle";
  card.addEventListener("click", open);
  card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  return card;
}

function unmanagedCard(p, status) {
  const n = p.containers.length;
  const card = el(`<div class="panel stack-card">
    <h3>${cardDot(status)}<span>${esc(p.name)}</span></h3>
    <span class="hint">${n} container${n === 1 ? "" : "s"}, not adopted</span>
    <button class="btn btn-block adopt-btn">Adopt</button>
  </div>`);
  card.querySelector(".adopt-btn").addEventListener("click", () => adopt({ kind: "project", ...p }, card));
  return card;
}

function standaloneCard(c) {
  const card = el(`<div class="panel stack-card">
    <h3>${cardDot(c.state)}<span>${esc(c.name)}</span></h3>
    <span class="hint">${esc(c.image)}, not adopted</span>
    <button class="btn btn-block adopt-btn">Adopt</button>
  </div>`);
  card.querySelector(".adopt-btn").addEventListener("click", () => adopt({ kind: "container", name: c.name }, card));
  return card;
}

async function adopt(payload, card) {
  const btn = card.querySelector(".adopt-btn");
  btn.disabled = true; btn.textContent = "Adopting…";
  try {
    const res = await api("/api/adopt", { method: "POST", body: payload });
    popAlert(btn, `Adopted '${res.name}'. ${res.note}.`, "success");
    await refreshStacks();
    await new Promise(r => setTimeout(r, 900));
    location.hash = `#/stack/${encodeURIComponent(res.name)}`;
  } catch (e) {
    btn.disabled = false; btn.textContent = "Adopt";
    popAlert(btn, e.message, "danger");
  }
}

/* ---- new stack ---- */

const COMPOSE_TEMPLATE = `services:
  app:
    image: nginx:alpine
    container_name: my-app
    restart: unless-stopped
    ports:
      - "8001:80"
`;

function viewNewStack() {
  content.innerHTML = `<div class="panel"><h1>New stack</h1>
    <div class="form-grid">
      <div class="field"><label for="stackName">Stack name</label>
        <input id="stackName" placeholder="e.g. jellyfin" autocomplete="off"
          pattern="[a-z0-9][a-z0-9_-]*">
        <span class="hint">Lowercase letters, numbers, dashes and underscores. This becomes the folder name in the stacks directory.</span></div>
      <div class="field"><label for="composeText">Compose file</label>
        <textarea id="composeText" class="code-editor" spellcheck="false">${esc(COMPOSE_TEMPLATE)}</textarea></div>
      <div class="field"><label for="envText">.env file <span class="hint">(optional)</span></label>
        <textarea id="envText" spellcheck="false" placeholder="KEY=value"></textarea></div>
      <button class="btn btn-primary" id="createBtn">Create stack</button>
    </div></div>
    <div class="panel"><h3>Convert a docker run command</h3>
    <p>Paste a <code>docker run …</code> command and it becomes compose YAML in the editor above.</p>
    <div class="form-grid">
      <div class="field"><label for="runCmd">docker run command</label>
        <textarea id="runCmd" spellcheck="false" placeholder="docker run -d -p 8080:80 --name web nginx:alpine"></textarea></div>
      <button class="btn" id="convertBtn">Convert to compose</button>
    </div></div>`;

  let envCm; // assigned below; referenced by cm's live port-conflict check
  const nameInput = document.getElementById("stackName");
  const cm = attachYamlEditor(document.getElementById("composeText"), {
    getName: () => nameInput.value.trim(),
    getEnv: () => envCm ? envCm.getValue() : "",
  });
  envCm = attachCodeEditor(document.getElementById("envText"));
  let envTimer;
  envCm.on("change", () => { clearTimeout(envTimer); envTimer = setTimeout(() => cm.recheck(), 600); });

  // Block disallowed characters at the source instead of complaining
  // later: anything typed or pasted that isn't lowercase/digit/-/_ just
  // never appears in the box (uppercase letters are folded to lowercase
  // rather than dropped, so pasting "Jellyfin" still gives "jellyfin").
  nameInput.addEventListener("input", () => {
    const cleaned = nameInput.value.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (nameInput.value !== cleaned) {
      const pos = nameInput.selectionStart - (nameInput.value.length - cleaned.length);
      nameInput.value = cleaned;
      nameInput.setSelectionRange(Math.max(0, pos), Math.max(0, pos));
    }
    cm.recheck();
  });

  const convertBtn = document.getElementById("convertBtn");
  convertBtn.addEventListener("click", async () => {
    try {
      const res = await api("/api/convert", { method: "POST", body: { command: document.getElementById("runCmd").value } });
      cm.setValue(res.compose);
      popAlert(convertBtn, "Converted - check the compose file, then create the stack.", "success");
    } catch (e) { popAlert(convertBtn, e.message, "danger"); }
  });
  const createBtn = document.getElementById("createBtn");
  createBtn.addEventListener("click", async () => {
    const name = document.getElementById("stackName").value.trim();
    try {
      await api("/api/stacks", { method: "POST", body: {
        name, compose: cm.getValue(),
        env: envCm.getValue() } });
      popAlert(createBtn, `Stack '${name}' created.`, "success");
      await refreshStacks();
      await new Promise(r => setTimeout(r, 900));
      location.hash = `#/stack/${encodeURIComponent(name)}`;
    } catch (e) { popAlert(createBtn, e.message, "danger"); }
  });
}

/* ---- stack detail ---- */

/* Prefers the real Tailscale Serve URL (a stack's port served there
   over HTTPS, using the tailnet's actual name) and falls back to
   whatever host the browser is already using to reach Dockle itself -
   its LAN IP or hostname, whichever got the user here - over plain
   HTTP on the stack's own published port. No port at all means
   nothing to open, so the button stays hidden. */
async function resolveWebUiLink(name, linkEl) {
  let status;
  try { status = await api(`/api/hostcompanion/stacks/${encodeURIComponent(name)}/serve`); }
  catch (e) { return; }
  if (!status.ports || !status.ports.length) return;
  const port = status.ports[0];
  let url = `http://${location.hostname}:${port}`;
  if (status.available && status.served.includes(port)) {
    try {
      const host = await api("/api/hostcompanion/status");
      if (host.tailscale?.dnsName) url = `https://${host.tailscale.dnsName}:${port}`;
    } catch (e) { /* fall back to the plain-IP URL already set */ }
  }
  linkEl.href = url;
  linkEl.classList.remove("hidden");
}

async function viewStack(name) {
  let s;
  try { s = await api(`/api/stacks/${encodeURIComponent(name)}`); }
  catch (e) { content.innerHTML = `<p class="alert alert-danger">! ${esc(e.message)}</p>`; return; }
  // The sidebar renders from stacksCache, which this fresh per-stack
  // fetch doesn't touch - without this, the sidebar/dashboard dot can
  // sit stale (e.g. still green) while this page's own dot already
  // shows yellow, right after a background check flips the flag.
  refreshStacks();

  content.innerHTML = "";
  const effectiveStatus = s.updateAvailable ? "update" : s.status;
  const dotTip = STATUS_TIPS[effectiveStatus] || "Container is down";
  const head = el(`<div class="panel"><div class="panel-head">
      <span class="status-dot ${STATUS_DOT_CLASS[effectiveStatus] || ""}" id="stackStatusDot"
        role="button" data-tip="${esc(dotTip)}" tabindex="0" aria-label="${esc(dotTip)}"></span>
      <h1 class="stack-title">${esc(name)}</h1>
      <a class="icon-btn hidden" id="openWebBtn" data-tip="Open web UI" aria-label="Open web UI"
        target="_blank" rel="noopener" href="#">${ICONS.external}</a>
      <span class="spacer"></span>
      <button class="icon-btn" id="actStart" data-tip="Start" aria-label="Start stack">${ICONS.play}</button>
      <button class="icon-btn" id="actStop" data-tip="Stop" aria-label="Stop stack">${ICONS.stop}</button>
      <button class="icon-btn" id="actRestart" data-tip="Restart" aria-label="Restart stack">${ICONS.restart}</button>
      <button class="icon-btn" id="actRedeploy" data-tip="Redeploy (recreate containers - fixes a stuck one without pulling a new image)" aria-label="Redeploy stack">${ICONS.redeploy}</button>
      <button class="icon-btn" id="actUpdate" data-tip="Update (pull newest images)" aria-label="Update stack">${ICONS.update}</button>
      <button class="icon-btn" id="actDown" data-tip="Down (stop and remove containers)" aria-label="Take stack down">${ICONS.down}</button>
      <button class="icon-btn" id="actDelete" data-tip="Delete stack" aria-label="Delete stack">${ICONS.bin}</button>
    </div>
    <div class="log-view action-output" id="actionOut" aria-live="polite"></div>
  </div>`);
  content.appendChild(head);
  resolveWebUiLink(name, head.querySelector("#openWebBtn"));

  const statusDot = head.querySelector("#stackStatusDot");
  const checkTipDefault = "Check this stack for an update right now - click again once ready to update";
  const updateTipReady = "Update available - click to update";
  statusDot.dataset.tip = s.updateAvailable ? updateTipReady : checkTipDefault;
  statusDot.setAttribute("aria-label", statusDot.dataset.tip);

  // The dot IS the update control - no separate button, same as the
  // dashboard card. Not ready yet: click checks right now. Ready:
  // click runs the same streaming update the Update button does, so
  // its output shows line by line instead of a one-word verdict.
  function setStackStatus(effectiveStatus) {
    const ready = effectiveStatus === "update";
    const tip = ready ? updateTipReady : (STATUS_TIPS[effectiveStatus] || checkTipDefault);
    statusDot.className = `status-dot ${STATUS_DOT_CLASS[effectiveStatus] || ""}`;
    statusDot.dataset.tip = tip;
    statusDot.setAttribute("aria-label", tip);
  }

  async function doCheck() {
    if (statusDot.classList.contains("busy")) return;
    statusDot.classList.add("busy");
    try {
      const res = await api(`/api/stacks/${encodeURIComponent(name)}/check-update`, { method: "POST", body: {} });
      s.updateAvailable = res.available;
      if (res.available) {
        setStackStatus("update");
        popAlert(statusDot, updateTipReady, "warning");
      } else {
        setStackStatus(s.status);
        popAlert(statusDot, "You're on the latest version", "success");
      }
      refreshStacks();
    } catch (e) {
      popAlert(statusDot, e.message, "danger", 4000);
    } finally {
      statusDot.classList.remove("busy");
    }
  }

  const onDotActivate = () => {
    if (statusDot.classList.contains("busy")) return;
    if (s.updateAvailable) runAction("update"); else doCheck();
  };
  statusDot.addEventListener("click", onDotActivate);
  statusDot.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onDotActivate(); }
  });

  const tabs = el(`<div class="panel">
    <div class="tabs" role="tablist">
      <button data-tab="overview" class="active">Overview</button>
      <button data-tab="compose">Compose</button>
      <button data-tab="logs">Logs</button>
      <button data-tab="terminal">Terminal</button>
      <button data-tab="backup">Backup</button>
      <button data-tab="serve">Tailscale</button>
    </div>
    <div id="tabBody"></div></div>`);
  content.appendChild(tabs);
  const tabBody = tabs.querySelector("#tabBody");

  const out = head.querySelector("#actionOut");
  const runAction = (action) => streamAction(name, action, out);
  head.querySelector("#actStart").addEventListener("click", () => runAction(s.status === "inactive" ? "up" : "start"));
  head.querySelector("#actStop").addEventListener("click", () => runAction("stop"));
  head.querySelector("#actRestart").addEventListener("click", () => runAction("restart"));
  head.querySelector("#actRedeploy").addEventListener("click", () => runAction("redeploy"));
  head.querySelector("#actUpdate").addEventListener("click", () => runAction("update"));
  head.querySelector("#actDown").addEventListener("click", () => runAction("down"));
  const delBtn = head.querySelector("#actDelete");
  delBtn.dataset.tip = "Delete stack";
  const dataPaths = s.dataPaths || [];
  const deletePanel = el(`<div class="panel hidden" id="deletePanel">
    <p class="alert alert-danger">! Permanently delete '${esc(name)}'? This removes its containers, compose
      file, and Docker image(s). This cannot be undone.</p>
    ${dataPaths.length ? `<div class="check-row"><input type="checkbox" id="deleteDataCheck">
      <label for="deleteDataCheck">Also permanently delete this stack's data</label></div>
      <ul class="hint hint-tight">${dataPaths.map(m => `<li>${m.type === "bind" ? "folder" : "volume"} <code>${esc(m.source)}</code></li>`).join("")}</ul>` : ""}
    <div class="btn-row">
      <button class="btn btn-danger" id="deleteConfirmBtn">Delete</button>
      <button class="btn" id="deleteCancelBtn">Cancel</button>
    </div>
  </div>`);
  head.insertAdjacentElement("afterend", deletePanel);
  delBtn.addEventListener("click", () => deletePanel.classList.remove("hidden"));
  deletePanel.querySelector("#deleteCancelBtn").addEventListener("click", () => deletePanel.classList.add("hidden"));
  deletePanel.querySelector("#deleteConfirmBtn").addEventListener("click", () => {
    deletePanel.classList.add("hidden");
    const deleteData = dataPaths.length && deletePanel.querySelector("#deleteDataCheck").checked;
    streamAction(name, "delete", out, true, deleteData);
  });

  const renderTab = {
    overview() {
      const rows = (s.containers || []).map(c => `<tr>
        <td>${esc(c.name)}</td><td>${esc(c.service || "-")}</td><td>${esc(c.image)}</td>
        <td>${cardDot(c.state)}</td>
        <td class="hint">${esc(c.status)}</td></tr>`).join("");
      tabBody.innerHTML = `<div class="table-wrap"><table>
        <caption>Containers in this stack</caption>
        <thead><tr><th>Container</th><th>Service</th><th>Image</th><th>State</th><th>Detail</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="hint">No containers - the stack isn’t deployed yet. Press play to bring it up.</td></tr>'}</tbody></table></div>`;
    },
    compose() {
      tabBody.innerHTML = "";
      const form = el(`<div class="form-grid">
        <div class="field"><label for="editCompose">${esc(s.composeFile)}</label>
          <textarea id="editCompose" class="code-editor" spellcheck="false"></textarea></div>
        <div class="field"><label for="editEnv">.env <span class="hint">(optional)</span></label>
          <textarea id="editEnv" spellcheck="false"></textarea></div>
        <div class="btn-row">
          <button class="btn btn-primary" id="saveBtn">Save</button>
          <button class="btn" id="saveUpBtn">Save &amp; redeploy</button>
        </div></div>`);
      tabBody.appendChild(form);
      form.querySelector("#editCompose").value = s.compose;
      form.querySelector("#editEnv").value = s.env;
      let envCm; // assigned below; referenced by cm's live port-conflict check
      const cm = attachYamlEditor(form.querySelector("#editCompose"), {
        getName: () => name,
        getEnv: () => envCm ? envCm.getValue() : "",
      });
      envCm = attachCodeEditor(form.querySelector("#editEnv"));
      let envTimer;
      envCm.on("change", () => { clearTimeout(envTimer); envTimer = setTimeout(() => cm.recheck(), 600); });
      const saveBtn = form.querySelector("#saveBtn");
      const saveUpBtn = form.querySelector("#saveUpBtn");
      const save = async (anchorBtn) => {
        await api(`/api/stacks/${encodeURIComponent(name)}`, { method: "PUT", body: {
          compose: cm.getValue(),
          env: envCm.getValue() } });
        popAlert(anchorBtn, "Saved.", "success");
      };
      saveBtn.addEventListener("click", () => save(saveBtn).catch(e => popAlert(saveBtn, e.message, "danger")));
      saveUpBtn.addEventListener("click", async () => {
        try { await save(saveUpBtn); runAction("up"); } catch (e) { popAlert(saveUpBtn, e.message, "danger"); }
      });
    },
    logs() {
      tabBody.innerHTML = `<div class="log-view" id="liveLogs" aria-live="off"></div>
        <p class="hint hint-mt">Streaming live. Error lines show in red, warnings in amber.</p>`;
      const view = tabBody.querySelector("#liveLogs");
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/logs/${encodeURIComponent(name)}`);
      ws.onmessage = (ev) => appendLog(view, ev.data);
      ws.onclose = () => appendLog(view, "-- log stream closed --");
      liveSockets.push(ws);
    },
    terminal() {
      const running = (s.containers || []).filter(c => c.state === "running");
      if (!running.length) {
        tabBody.innerHTML = '<p class="alert alert-warning">! The stack has no running containers to open a terminal into.</p>';
        return;
      }
      tabBody.innerHTML = "";
      const picker = el(`<div class="form-grid tight-below">
        <div class="field"><label for="termTarget">Container</label>
        <select id="termTarget">${running.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("")}</select></div></div>`);
      const host = el('<div class="term-host"><div class="terminal" id="term"></div></div>');
      tabBody.appendChild(picker);
      tabBody.appendChild(host);
      let term, ws;
      const open = (target) => {
        if (ws) try { ws.close(); } catch (e) {}
        host.querySelector("#term").innerHTML = "";
        term = new Terminal({ fontSize: 13, convertEol: true, cursorBlink: true,
          theme: { background: "#101116" } });
        term.open(host.querySelector("#term"));
        ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/terminal/${encodeURIComponent(target)}`);
        ws.onopen = () => ws.send(`\x00resize:${term.cols}x${term.rows}`);
        ws.onmessage = (ev) => term.write(ev.data);
        ws.onclose = () => term.write("\r\n-- session ended --\r\n");
        term.onData(d => { if (ws.readyState === 1) ws.send(d); });
        term.onResize(({ cols, rows }) => { if (ws.readyState === 1) ws.send(`\x00resize:${cols}x${rows}`); });
        liveSockets.push(ws);
      };
      open(running[0].name);
      picker.querySelector("#termTarget").addEventListener("change", e => open(e.target.value));
    },
    async backup() {
      tabBody.innerHTML = `<div class="panel-head">
          <h3>Backups</h3><span class="spacer"></span>
          <label class="btn" for="bkUploadInput">Upload a backup</label>
          <input type="file" id="bkUploadInput" accept=".gz,.tar.gz" class="visually-hidden">
          <button class="btn btn-primary" id="backupNowBtn">Back up now</button></div>
        <p>Archives this stack's compose file, its .env, and its actual data - bind-mounted folders
        and named volumes read straight from where they already live, nothing moved. Restoring
        puts everything back to exactly the same place. Download a backup to keep a copy on your
        own drive, or upload one back in (from this machine or another) to restore from it.</p>
        <div class="table-wrap" id="stackBkWrap"><p class="hint">Loading…</p></div>`;
      const loadList = async () => {
        const wrap = tabBody.querySelector("#stackBkWrap");
        const d = await api(`/api/stacks/${encodeURIComponent(name)}/backups`);
        if (!d.backups.length) { wrap.innerHTML = '<p class="hint">No backups of this stack yet.</p>'; return; }
        wrap.innerHTML = `<table><caption>Backups of '${esc(name)}', newest first</caption>
          <thead><tr><th>Made</th><th>File</th><th>Size</th><th></th></tr></thead><tbody>
          ${d.backups.map(b => `<tr><td>${esc(b.made)}</td><td>${esc(b.name)}</td>
            <td>${(b.size / 1048576).toFixed(1)} MB</td>
            <td class="nowrap">
              <a class="btn" href="/api/stacks/${encodeURIComponent(name)}/backups/${encodeURIComponent(b.name)}/download">Download</a>
              <button class="btn" data-restore="${esc(b.name)}">Restore</button>
            </td></tr>`).join("")}</tbody></table>`;
        wrap.querySelectorAll("[data-restore]").forEach(btn => {
          let armed = false;
          btn.addEventListener("click", async () => {
            if (!armed) {
              armed = true; btn.textContent = "Really restore?"; btn.classList.add("btn-danger");
              setTimeout(() => { armed = false; btn.textContent = "Restore"; btn.classList.remove("btn-danger"); }, 5000);
              return;
            }
            btn.disabled = true;
            try {
              const res = await api(`/api/stacks/${encodeURIComponent(name)}/backups/${encodeURIComponent(btn.dataset.restore)}/restore`, { method: "POST", body: {} });
              popAlert(btn, res.message, "success");
            } catch (e) { popAlert(btn, e.message, "danger"); }
            btn.disabled = false; armed = false; btn.textContent = "Restore"; btn.classList.remove("btn-danger");
          });
        });
      };
      tabBody.querySelector("#backupNowBtn").addEventListener("click", async (e) => {
        e.target.disabled = true; e.target.textContent = "Backing up…";
        try {
          const r = await api(`/api/stacks/${encodeURIComponent(name)}/backups`, { method: "POST", body: {} });
          popAlert(e.target, `Backup made: ${r.name}`, "success");
          await loadList();
        } catch (err) { popAlert(e.target, err.message, "danger"); }
        e.target.disabled = false; e.target.textContent = "Back up now";
      });
      const uploadLabel = tabBody.querySelector('label[for="bkUploadInput"]');
      tabBody.querySelector("#bkUploadInput").addEventListener("change", async (e) => {
        const file = e.target.files[0];
        e.target.value = "";
        if (!file) return;
        const form = new FormData();
        form.append("file", file);
        try {
          const res = await fetch(`/api/stacks/${encodeURIComponent(name)}/backups/upload`, {
            method: "POST", headers: { "X-CSRF": CSRF }, body: form,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "Upload failed");
          popAlert(uploadLabel, `Uploaded ${data.name} - it's in the list below, ready to restore.`, "success");
          await loadList();
        } catch (err) { popAlert(uploadLabel, err.message, "danger"); }
      });
      await loadList();
    },
    async serve() {
      tabBody.innerHTML = '<p class="hint">Checking…</p>';
      let status;
      try { status = await api(`/api/hostcompanion/stacks/${encodeURIComponent(name)}/serve`); }
      catch (e) { status = { available: false }; }
      if (!status.available) {
        tabBody.innerHTML = `<p>Not set up. Exposing this stack's ports over Tailscale Serve needs the
          optional dockle-companion - see Settings → Host OS & Tailscale to install it with one click.</p>`;
        return;
      }
      if (!status.ports.length) {
        tabBody.innerHTML = '<p class="hint">This stack doesn\'t publish any ports, so there\'s nothing for Tailscale Serve to front.</p>';
        return;
      }
      let dnsName = "";
      try { dnsName = (await api("/api/hostcompanion/status")).tailscale?.dnsName || ""; } catch (e) {}

      tabBody.innerHTML = '<div id="servePorts"></div>';
      const host = tabBody.querySelector("#servePorts");
      // Each published port toggles independently, but reads as a plain
      // fact (what's live right now, and at what real address) rather
      // than a "pick one" prompt - most stacks publish exactly one port
      // worth reaching, so there's rarely an actual choice to make.
      for (const port of status.ports) {
        const on = status.served.includes(port);
        const url = dnsName ? `https://${esc(dnsName)}:${port}` : `port ${port}`;
        const row = el(`<div class="check-row"><input type="checkbox" id="serve-${port}" ${on ? "checked" : ""}>
          <label for="serve-${port}">${on ? "Exposed at" : "Not exposed - would be"} <code>${url}</code></label></div>`);
        host.appendChild(row);
        row.querySelector("input").addEventListener("change", async (e) => {
          e.target.disabled = true;
          try {
            await api(`/api/hostcompanion/stacks/${encodeURIComponent(name)}/serve`, {
              method: "POST", body: { port, on: e.target.checked } });
            popAlert(e.target, `Serve ${e.target.checked ? "enabled" : "disabled"} for port ${port}.`, "success");
            await new Promise(r => setTimeout(r, 900));
            renderTab.serve();
          } catch (err) { popAlert(e.target, err.message, "danger"); e.target.checked = !e.target.checked; e.target.disabled = false; }
        });
      }
    },
  };

  tabs.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
    closeLiveSockets();
    tabs.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("active", x === b));
    renderTab[b.dataset.tab]();
  }));
  renderTab.overview();

  if (pendingStackAction && pendingStackAction.name === name) {
    const { action } = pendingStackAction;
    pendingStackAction = null;
    runAction(action);
  }
}

/* Dockle's own stack page. Same shape as any other stack's - status,
   containers, actions, output - and every button is offered, Delete
   included. What differs is only the plumbing: each action runs in a
   helper container on the host, because a command that stops or replaces
   Dockle's container kills the process running it partway through. */
async function viewDockleStack() {
  let self;
  try { self = await api("/api/system/self"); }
  catch (e) { content.innerHTML = `<p class="alert alert-danger">! ${esc(e.message)}</p>`; return; }
  if (!self.available) {
    content.innerHTML = `<p class="alert alert-warning">! ${esc(self.error || "Dockle isn't running as a compose project here.")}</p>`;
    return;
  }

  content.innerHTML = "";
  const dotTip = STATUS_TIPS[self.status] || "Container is down";
  const head = el(`<div class="panel"><div class="panel-head">
      <span class="status-dot ${STATUS_DOT_CLASS[self.status] || ""}" data-tip="${esc(dotTip)}"
        tabindex="0" aria-label="${esc(dotTip)}"></span>
      <h1 class="stack-title">${esc(self.name)}</h1>
      <span class="pill">this is Dockle</span>
      <span class="spacer"></span>
      <button class="icon-btn" id="selfStart" data-tip="Start" aria-label="Start Dockle">${ICONS.play}</button>
      <button class="icon-btn" id="selfStop" data-tip="Stop (you'll lose this page until you start it from a shell)" aria-label="Stop Dockle">${ICONS.stop}</button>
      <button class="icon-btn" id="selfRestart" data-tip="Restart" aria-label="Restart Dockle">${ICONS.restart}</button>
      <button class="icon-btn" id="selfRedeploy" data-tip="Redeploy (recreate the container from compose.yaml)" aria-label="Redeploy Dockle">${ICONS.redeploy}</button>
      <button class="icon-btn" id="selfUpdate" data-tip="Update (pull the newest Dockle, rebuild, restart)" aria-label="Update Dockle">${ICONS.update}</button>
      <button class="icon-btn" id="selfDown" data-tip="Down (stop and remove the container)" aria-label="Take Dockle down">${ICONS.down}</button>
      <button class="icon-btn" id="selfDelete" data-tip="Delete Dockle" aria-label="Delete Dockle">${ICONS.bin}</button>
    </div>
    <p class="hint">Runs from <code>${esc(self.dir || "unknown")}</code> on the host. Your stacks keep running
      through anything you do here - only this page goes away.</p>
    <div class="log-view action-output" id="selfOut" aria-live="polite"></div>
  </div>`);
  content.appendChild(head);
  const out = head.querySelector("#selfOut");

  if (!self.canAct) {
    head.querySelectorAll(".panel-head .icon-btn").forEach(b => b.disabled = true);
    head.appendChild(el(`<p class="alert alert-warning">! DOCKLE_DATA_HOST_PATH isn't set, so Dockle
      can't tell where its own folder lives on the host - see the runbook. Everything here is
      read-only until it is.</p>`));
  }

  const run = (action, deleteData = false) => streamSelfAction(action, out, deleteData);
  head.querySelector("#selfStart").addEventListener("click", () => run(self.status === "inactive" ? "up" : "start"));
  head.querySelector("#selfStop").addEventListener("click", () => run("stop"));
  head.querySelector("#selfRestart").addEventListener("click", () => run("restart"));
  head.querySelector("#selfRedeploy").addEventListener("click", () => run("redeploy"));
  head.querySelector("#selfUpdate").addEventListener("click", () => run("update"));
  head.querySelector("#selfDown").addEventListener("click", () => run("down"));

  // Delete is offered like it is for any other stack - it's your server.
  // What it can't be is quiet about what you lose: this is the tool
  // you'd use to put it back.
  const deletePanel = el(`<div class="panel hidden" id="selfDeletePanel">
    <p class="alert alert-danger">! Delete Dockle itself? This stops and removes its container and
      image. The web UI goes away for good - bringing it back means a shell on the server
      (<code>cd ${esc(self.dir || "/opt/dockle")} && docker compose up -d --build</code>).
      Your stacks and their data are not touched.</p>
    <div class="check-row"><input type="checkbox" id="selfDeleteData">
      <label for="selfDeleteData">Also delete Dockle's own folder - compose file, settings, activity
        log and login, everything in <code>${esc(self.dir || "/opt/dockle")}</code></label></div>
    <p class="hint hint-tight">With that ticked there is nothing left to bring back: reinstalling
      means cloning the repo again and starting over.</p>
    <div class="btn-row">
      <button class="btn btn-danger" id="selfDeleteConfirm">Delete Dockle</button>
      <button class="btn" id="selfDeleteCancel">Cancel</button>
    </div></div>`);
  head.insertAdjacentElement("afterend", deletePanel);
  head.querySelector("#selfDelete").addEventListener("click", () => deletePanel.classList.remove("hidden"));
  deletePanel.querySelector("#selfDeleteCancel").addEventListener("click", () => deletePanel.classList.add("hidden"));
  deletePanel.querySelector("#selfDeleteConfirm").addEventListener("click", () => {
    deletePanel.classList.add("hidden");
    run("delete", deletePanel.querySelector("#selfDeleteData").checked);
  });

  const tabs = el(`<div class="panel">
    <div class="tabs" role="tablist">
      <button data-tab="overview" class="active">Overview</button>
      <button data-tab="logs">Logs</button>
      <button data-tab="terminal">Terminal</button>
    </div>
    <div id="tabBody"></div></div>`);
  content.appendChild(tabs);
  const tabBody = tabs.querySelector("#tabBody");

  const renderTab = {
    overview() {
      const rows = self.containers.map(c => `<tr>
        <td>${esc(c.name)}</td><td>${esc(c.service || "-")}</td><td>${esc(c.image)}</td>
        <td>${cardDot(c.state)}</td><td class="hint">${esc(c.status)}</td></tr>`).join("");
      tabBody.innerHTML = `<div class="table-wrap"><table>
        <caption>Dockle's own container(s)</caption>
        <thead><tr><th>Container</th><th>Service</th><th>Image</th><th>State</th><th>Detail</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="hint">Nothing running.</td></tr>'}</tbody></table></div>`;
    },
    logs() {
      const running = self.containers.filter(c => c.state === "running");
      if (!running.length) {
        tabBody.innerHTML = '<p class="alert alert-warning">! Nothing running to stream logs from.</p>';
        return;
      }
      tabBody.innerHTML = `<div class="log-view" id="liveLogs" aria-live="off"></div>
        <p class="hint hint-mt">Streaming live. Error lines show in red, warnings in amber.</p>`;
      const view = tabBody.querySelector("#liveLogs");
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/logs-container/${encodeURIComponent(running[0].name)}`);
      ws.onmessage = (ev) => appendLog(view, ev.data);
      ws.onclose = () => appendLog(view, "-- log stream closed --");
      liveSockets.push(ws);
    },
    terminal() {
      const running = self.containers.filter(c => c.state === "running");
      if (!running.length) {
        tabBody.innerHTML = '<p class="alert alert-warning">! Nothing running to open a terminal into.</p>';
        return;
      }
      tabBody.innerHTML = "";
      const host = el('<div class="term-host"><div class="terminal" id="term"></div></div>');
      tabBody.appendChild(host);
      const term = new Terminal({ fontSize: 13, convertEol: true, cursorBlink: true,
        theme: { background: "#101116" } });
      term.open(host.querySelector("#term"));
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/terminal/${encodeURIComponent(running[0].name)}`);
      ws.onopen = () => ws.send(`\x00resize:${term.cols}x${term.rows}`);
      ws.onmessage = (ev) => term.write(ev.data);
      ws.onclose = () => term.write("\r\n-- session ended --\r\n");
      term.onData(d => { if (ws.readyState === 1) ws.send(d); });
      term.onResize(({ cols, rows }) => { if (ws.readyState === 1) ws.send(`\x00resize:${cols}x${rows}`); });
      liveSockets.push(ws);
    },
  };
  tabs.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
    closeLiveSockets();
    tabs.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("active", x === b));
    renderTab[b.dataset.tab]();
  }));
  renderTab.overview();
}

/* Streams one of Dockle's own actions. Anything that stops or replaces
   Dockle cuts this stream off mid-line - "[dockle-restarting]" is the
   server's warning that it's about to happen, after which we wait for
   /health rather than calling the dropped connection a failure. An
   action that deliberately leaves Dockle down (stop, down, delete) says
   so plainly instead of waiting forever for a page that isn't coming
   back. */
async function streamSelfAction(action, out, deleteData = false) {
  const staysDown = action === "stop" || action === "down" || action === "delete";
  out.innerHTML = "";
  appendLog(out, `$ ${action} dockle`);
  document.querySelectorAll(".panel-head .icon-btn").forEach(b => b.disabled = true);
  let restarting = false;
  let ok = true;
  try {
    const qs = deleteData ? "?deleteData=1" : "";
    const res = await fetch(`/api/system/self/action/${action}${qs}`, {
      method: "POST", headers: { "X-CSRF": CSRF },
    });
    const r = await readDockleStream(res, {
      onLine: line => appendLog(out, line),
      onRestarting: () => { restarting = true; },
    });
    ok = r.ok;
  } catch (e) {
    if (!restarting) {
      appendLog(out, "ERROR: " + e.message);
      popAlert(out, e.message, "danger");
      document.querySelectorAll(".panel-head .icon-btn").forEach(b => b.disabled = false);
      return;
    }
  }
  if (staysDown) {
    appendLog(out, action === "delete"
      ? "Dockle has been deleted. This page is all that's left of it - bring it back with docker compose up -d --build on the server."
      : "Dockle is down. Start it again from a shell: docker compose up -d in its folder.");
    return; // deliberately leave the buttons disabled: there's nothing behind them now
  }
  const progress = openProgressPanel(`Dockle: ${action}`);
  progress.line(restarting ? "Dockle is restarting itself…" : `${action} finished.`);
  if (restarting) {
    await waitForDockleBack(progress);
  } else {
    progress.done(ok);
  }
  if (location.hash === "#/dockle") await viewDockleStack();
}

/* Every one of Dockle's streaming actions speaks the same wire format:
   newline-delimited output plus a few control tokens. This reads one
   such response, calling onLine for each content line and onRestarting
   when the container serving the request is about to be replaced (after
   which the stream simply stops). Returns {ok, restarting}. */
async function readDockleStream(res, { onLine, onRestarting } = {}) {
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", ok = true, restarting = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (line === "[dockle-done:ok]") { ok = true; continue; }
      if (line === "[dockle-done:error]") { ok = false; continue; }
      if (line === "[dockle-restarting]") { restarting = true; if (onRestarting) onRestarting(); continue; }
      if (line) { if (onLine) onLine(line); }
    }
  }
  return { ok, restarting };
}

async function streamAction(name, action, out, isDelete = false, deleteData = false) {
  out.innerHTML = "";
  appendLog(out, `$ ${action} ${name}`);
  document.querySelectorAll(".panel-head .icon-btn").forEach(b => b.disabled = true);
  try {
    const qs = deleteData ? "?deleteData=1" : "";
    const res = await fetch(`/api/stacks/${encodeURIComponent(name)}/action/${action}${qs}`, {
      method: "POST", headers: { "X-CSRF": CSRF },
    });
    const { ok } = await readDockleStream(res, { onLine: line => {
      const hint = line.match(/^\[dockle-hint:tailscale-port-conflict:(\d+):([01])\]$/);
      if (hint) { renderPortConflictHint(out, hint[1], hint[2] === "1"); return; }
      appendLog(out, line);
    }});
    if (ok) {
      popAlert(out, `${action} finished.`, "success");
    } else {
      appendLog(out, `ERROR: ${action} did not complete cleanly - see above.`);
      popAlert(out, `${action} failed - the output panel has the details.`, "danger");
    }
    if (isDelete && ok) {
      await refreshStacks();
      await new Promise(r => setTimeout(r, 900));
      location.hash = "#/";
      return;
    }
    await refreshStacks();
    if (!isDelete && location.hash === `#/stack/${encodeURIComponent(name)}`) {
      await new Promise(r => setTimeout(r, 900)); // let the finished/failed bubble be seen before the panel rebuilds
      const output = out.innerHTML;
      await viewStack(name);
      const fresh = document.getElementById("actionOut");
      if (fresh) { fresh.innerHTML = output; fresh.scrollTop = fresh.scrollHeight; }
    }
  } catch (e) {
    appendLog(out, "ERROR: " + e.message);
    popAlert(out, e.message, "danger");
  } finally {
    document.querySelectorAll(".panel-head .icon-btn").forEach(b => b.disabled = false);
  }
}

/* ---- maintenance ---- */

const PRUNE_INFO = [
  ["images", "Unused images", "Removes images no container uses. They re-download if ever needed again."],
  ["containers", "Stopped containers", "Removes containers that have exited. Their images and volumes stay."],
  ["networks", "Unused networks", "Removes networks no container is attached to."],
  ["buildcache", "Build cache", "Clears layers cached from image builds."],
  ["volumes", "Unused volumes", "The only one that can lose data. \u201cUnused\u201d means no container is using it " +
    "<em>right now</em> \u2014 which also describes every volume belonging to a stack you have merely stopped. " +
    "Everything else on this page only removes things Docker can rebuild; this removes real data, permanently. " +
    "Dockle lists each volume and whose it is before anything is deleted."],
];

function helpTile(iconSvg, title, desc) {
  return `<div class="help-tile"><div class="help-tile-icon">${iconSvg}</div>
    <div><h4>${esc(title)}</h4><p>${esc(desc)}</p></div></div>`;
}

async function viewHelp() {
  const NAV_ICO = {
    allStacks: '<svg viewBox="0 0 24 24"><path d="M12 3 3 8l9 5 9-5-9-5Z M3 12l9 5 9-5 M3 16l9 5 9-5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    newStack: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>',
    maintenance: '<svg viewBox="0 0 24 24"><path d="M4 17l6-6M14 4l-2.5 2.5a4 4 0 0 0 5.5 5.5L19.5 9.5A4 4 0 0 1 14 4zM4 17l3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    activity: '<svg viewBox="0 0 24 24"><path d="M4 12h4l2-7 4 14 2-7h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    backups: '<svg viewBox="0 0 24 24"><path d="M12 3v10m0 0l-4-4m4 4l4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-1-2 3.5 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.5 2.3-1a7 7 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7 7 0 0 0 2-1.2l2.3 1 2-3.5-2-1.5c.06-.4.1-.8.1-1.2z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/></svg>',
    menu: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>',
    signOut: '<svg viewBox="0 0 24 24"><path d="M9 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3M14 8l4 4-4 4M18 12H9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    power: '<svg viewBox="0 0 24 24"><path d="M12 3v8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M7 5.5a8 8 0 1 0 10 0" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  };

  content.innerHTML = `
    <h1>How Dockle works</h1>

    <div class="panel">
      <h2>Getting around</h2>
      <p>The sidebar and the bar along the top, and what each part does.</p>
      <div class="help-grid">
        ${helpTile(NAV_ICO.menu, "Menu", "Shows or hides the sidebar - only needed on a narrow screen.")}
        ${helpTile(NAV_ICO.allStacks, "All stacks", "Back to the dashboard - every stack, one glance.")}
        ${helpTile(NAV_ICO.newStack, "New stack", "Write or paste a compose file, or convert a docker run command.")}
        ${helpTile(NAV_ICO.maintenance, "Maintenance", "Disk usage, and pruning unused images/containers/networks/cache/volumes.")}
        ${helpTile(NAV_ICO.activity, "Activity", "A running log of everything Dockle has done and any errors along the way.")}
        ${helpTile(NAV_ICO.backups, "Backups", "Daily automatic backups of Dockle's own data, with one-click restore.")}
        ${helpTile(NAV_ICO.settings, "Settings", "Account, email alerts, the host companion, and updating Dockle itself.")}
        ${helpTile(NAV_ICO.power, "Restart Docker / Reboot server", "Only shown once the host companion is installed - real host-level actions, not container ones.")}
        ${helpTile(NAV_ICO.signOut, "Sign out", "Ends your session immediately.")}
      </div>
    </div>

    <div class="panel">
      <h2>On a stack</h2>
      <p>The status dot next to the name is itself the update control - not ready, click it to check this stack
        for an update right now; ready, click it to pull and redeploy, streamed live. The icon row alongside it:</p>
      <div class="help-grid">
        ${helpTile(ICONS.external, "Open web UI", "Opens the stack's own address in a new tab - its Tailscale Serve address if set up, otherwise the host address you're already using.")}
        ${helpTile(ICONS.play, "Start", "Brings the stack up - creates containers the first time, starts them after.")}
        ${helpTile(ICONS.stop, "Stop", "Stops the containers. Nothing is removed; Start brings them straight back.")}
        ${helpTile(ICONS.restart, "Restart", "Restarts the same containers in place.")}
        ${helpTile(ICONS.redeploy, "Redeploy", "Recreates the containers from the compose file - fixes a stuck one without pulling a new image.")}
        ${helpTile(ICONS.update, "Update", "Pulls the newest images for every service, then redeploys.")}
        ${helpTile(ICONS.down, "Down", "Stops the containers and removes them. The compose file and any data stay exactly where they are.")}
        ${helpTile(ICONS.bin, "Delete", "Removes the stack for good: containers, compose file and image. Data can be deleted too, with an explicit opt-in.")}
      </div>
    </div>

    <div class="panel">
      <h2>Status dots</h2>
      <p>Deliberately just three colours, the same on every card and page - one glance is enough to know whether a
        stack needs you.</p>
      <ul class="help-dots">
        <li><span class="status-dot running"></span><span><strong>Green</strong> - running normally.</span></li>
        <li><span class="status-dot update"></span><span><strong>Amber</strong> - an update is waiting; click the
          dot to pull and redeploy.</span></li>
        <li><span class="status-dot"></span><span><strong>Red</strong> - anything else that isn't simply running:
          stopped, exited, restarting, or a health warning. One "needs attention" signal rather than a different
          shade for every cause - open the stack to see which.</span></li>
        <li><span class="status-dot inactive"></span><span><strong>Grey</strong> - no container at all, the one
          exception: not a problem, just ready to archive or delete.</span></li>
      </ul>
    </div>

    <div class="panel">
      <h2>Keeping stacks up to date</h2>
      <p>Dockle checks every managed, running stack for a newer image every 30 minutes, on its own - it only ever
        <strong>flags</strong> an update, never pulls one without you asking. <strong>Check for updates</strong> on
        the dashboard runs that same check right now instead of waiting. From there you can update one stack at a
        time (its cloud icon, or its own Update button) or everything that's flagged at once
        (<strong>Update all</strong>). Every update streams its real output, so a slow pull or a failure both show
        you exactly what happened rather than a single word.</p>
    </div>

    <div class="panel">
      <h2>Dockle itself</h2>
      <p>Dockle is an ordinary container started by an ordinary compose file, so it shows up on the dashboard as an
        ordinary card too - same status dot, same buttons. The only thing that's different is how those buttons
        work: a command that stopped or replaced Dockle's own container would kill the very process running that
        command, so every action on Dockle's own card runs from a short-lived helper container instead, never from
        inside itself.</p>
      <div class="help-cols">
        <div class="help-col"><h4>Update</h4><p>Pulls the newest source, rebuilds and restarts. The page goes away
          for a few seconds while that happens, then reconnects itself. Your other stacks are untouched throughout -
          this only ever replaces Dockle's own container.</p></div>
        <div class="help-col"><h4>Stop / Down / Delete</h4><p>These really do what they say, so they're offered
          like any other stack's - but they're one-way from the browser: the page that ran them is the last one
          you'll see until Dockle is brought back from a shell on the server.</p></div>
      </div>
    </div>

    <div class="panel">
      <h2>Backups</h2>
      <div class="help-cols">
        <div class="help-col"><h4>Backups page</h4><p>Automatic, daily, and covers Dockle's own data - the
          database, settings, activity log. One-click restore, plus a download-everything zip for keeping a copy
          yourself.</p></div>
        <div class="help-col"><h4>A stack's own Backup tab</h4><p>Archives that one stack's compose file, its
          .env, and its <strong>real data</strong> - bind-mounted folders and named volumes, read straight from
          where they already live. Download a backup to move a stack to another machine, or upload one back in to
          restore it.</p></div>
      </div>
    </div>

    <div class="panel">
      <h2>The host companion (optional)</h2>
      <p>Dockle's container access lets it manage every stack, but the server underneath - the operating system
        itself - is outside that box on purpose. The companion is a small helper that runs directly on the host so
        Dockle can reach the handful of things that need real root: host OS updates, and Tailscale Serve.</p>
      <ol class="help-steps">
        <li>Open <strong>Settings → Host OS & Tailscale</strong>.</li>
        <li>Click <strong>Install companion</strong>. It installs a systemd service on the host.</li>
        <li>Dockle reconnects to it automatically, restarting itself briefly as the last step.</li>
      </ol>
      <p class="hint">What it can do: exactly four things - check and apply host OS updates, install Tailscale, and
        turn Tailscale Serve on or off for a port. Every request is one of that fixed list; there is no "run this
        command" option, so nothing reaching that socket can ever ask it for anything else. Entirely optional -
        Dockle works without it, you just won't see the Host OS panel or per-stack Tailscale toggle.</p>
    </div>

    <div class="panel">
      <h2>Security, in short</h2>
      <p>Real server-side login with rate limiting and optional two-factor (TOTP) - no default password, no
        skipping the login screen. Every state-changing request is CSRF-checked, session cookies are HttpOnly and
        SameSite, and secrets like an SMTP password are encrypted at rest and never sent back to the browser.
        Nothing calls home: no CDNs, no analytics, no tracking - everything Dockle needs is served by Dockle.</p>
    </div>`;
}

async function viewMaintenance() {
  content.innerHTML = `<h1>Maintenance</h1>
    <div class="panel"><div class="panel-head"><h2>Disk usage</h2></div>
      <div class="table-wrap" id="dfWrap"><p class="hint">Loading…</p></div></div>
    <div class="panel"><div class="panel-head"><h2>Prune</h2>
      <span class="spacer"></span><button class="btn btn-primary" id="pruneAll">Prune everything</button></div>
      <p>Each cleans one kind of leftover. <strong>Prune everything</strong> runs the safe four together \u2014
      images, containers, networks and build cache are all rebuildable, so pruning them costs you nothing but
      a slower next build. Volumes hold real data and are never included; they stay a separate, deliberate step.</p>
      <div class="prune-grid" id="pruneGrid"></div></div>`;

  api("/api/system/df").then(d => {
    document.getElementById("dfWrap").innerHTML = `<table>
      <caption>What the engine is using on disk</caption>
      <thead><tr><th>Type</th><th>Total</th><th>Active</th><th>Size</th><th>Reclaimable</th></tr></thead>
      <tbody>${d.usage.map(u => `<tr><td>${esc(u.type)}</td><td>${esc(u.total)}</td>
        <td>${esc(u.active)}</td><td>${esc(u.size)}</td><td>${esc(u.reclaimable)}</td></tr>`).join("")}</tbody></table>`;
  }).catch(e => document.getElementById("dfWrap").innerHTML =
    `<p class="alert alert-danger">! ${esc(e.message)}</p>`);

  const grid = document.getElementById("pruneGrid");
  for (const [key, title, blurb] of PRUNE_INFO) {
    const card = el(`<div class="panel prune-card"><h3>${title}</h3>
      <p class="hint">${blurb}</p>
      <button class="btn ${key === "volumes" ? "btn-danger" : ""}" data-target="${key}">Prune ${key === "buildcache" ? "cache" : key}</button>
      <div class="prune-result" role="status"></div></div>`);
    const btn = card.querySelector("button");
    const result = card.querySelector(".prune-result");
    btn.addEventListener("click", async () => {
      if (key === "volumes") {
        try {
          const prev = await api("/api/system/prune/volumes/preview");
          if (!prev.volumes.length) { result.textContent = "No unused volumes."; result.className = "prune-result ok"; return; }
          if (!card.dataset.armed) {
            card.dataset.armed = "1";
            result.className = "prune-result bad";
            const order = { "in-use": 0, superseded: 1, orphaned: 2 };
            const rows = [...prev.volumes].sort((a, b) => order[a.verdict] - order[b.verdict])
              .map(v => `<li class="vol-${esc(v.verdict)}"><strong>${esc(v.name)}</strong>${v.size ? ` \u00b7 ${esc(v.size)}` : ""}
                <span class="hint">${esc(v.note || "")}</span></li>`).join("");
            const risky = prev.volumes.filter(v => v.verdict === "in-use").length;
            result.innerHTML = `<p>Will <strong>permanently delete</strong> these ${prev.volumes.length} volumes
              and the data in them:</p><ul class="vol-list">${rows}</ul>
              <p>${risky
                ? `<strong>${risky} of them belong to a stack that is only stopped.</strong> Start that stack again
                   and its data will be gone. Delete those only if you are finished with the stack.`
                : "None of them belong to a stack Dockle can see, so this should only reclaim genuine leftovers."}
              Click again to confirm.</p>`;
            setTimeout(() => {
              if (!card.dataset.armed) return;  // already confirmed - leave the outcome on screen
              delete card.dataset.armed;
              result.innerHTML = "";
            }, 15000);
            return;
          }
          delete card.dataset.armed;
        } catch (e) { result.textContent = e.message; result.className = "prune-result bad"; return; }
      }
      btn.disabled = true; result.textContent = "Working…"; result.className = "prune-result";
      try {
        const res = await api("/api/system/prune", { method: "POST", body: { targets: [key] } });
        const r = res.results[key];
        result.textContent = (r.ok ? "✓ " : "! ") + r.message;
        result.className = "prune-result " + (r.ok ? "ok" : "bad");
      } catch (e) { result.textContent = "! " + e.message; result.className = "prune-result bad"; }
      btn.disabled = false;
    });
    grid.appendChild(card);
  }

  document.getElementById("pruneAll").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true; btn.textContent = "Pruning…";
    try {
      const res = await api("/api/system/prune", { method: "POST",
        body: { targets: ["containers", "images", "networks", "buildcache"] } });
      const lines = Object.entries(res.results).map(([k, r]) => `${k}: ${r.message}`);
      popAlert(btn, lines.join(" · "), res.ok ? "success" : "danger");
      await new Promise(r => setTimeout(r, 900));
      viewMaintenance();
    } catch (err) {
      popAlert(btn, err.message, "danger");
      btn.disabled = false; btn.textContent = "Prune everything";
    }
  });
}

/* ---- activity ---- */

async function viewActivity() {
  content.innerHTML = `<h1>Activity</h1>
    <div class="panel"><div class="panel-head">
      <h2>What Dockle has done</h2><span class="spacer"></span>
      <label class="check-row tight">
        <input type="checkbox" id="errOnly"> Errors only</label></div>
      <div id="activityRows"><p class="hint">Loading…</p></div></div>`;
  const load = async () => {
    const errorsOnly = document.getElementById("errOnly").checked;
    const d = await api("/api/activity" + (errorsOnly ? "?errors=1" : ""));
    const host = document.getElementById("activityRows");
    if (!d.entries.length) { host.innerHTML = '<p class="hint">Nothing recorded yet.</p>'; return; }
    host.innerHTML = d.entries.map(a => `
      <div class="activity-row is-${esc(a.level)}">
        <span class="a-ts">${esc(a.ts)}</span>
        <span class="a-cat">${a.level === "error" ? "! " : ""}${esc(a.category)}</span>
        <span class="a-msg">${esc(a.message)}</span>
        ${a.detail ? `<span class="a-detail">${esc(a.detail)}</span>` : ""}
      </div>`).join("");
  };
  document.getElementById("errOnly").addEventListener("change", load);
  await load();
}

/* ---- backups ---- */

async function viewBackups() {
  content.innerHTML = `<h1>Backups</h1>
    <div class="panel"><div class="panel-head"><h2>Backups</h2><span class="spacer"></span>
      <button class="btn btn-primary" id="backupNow">Back up now</button>
      <a class="btn" href="/api/backup/export">Download everything (zip)</a></div>
      <p>A backup is taken automatically every day and kept for the number of days set in Settings.
      Restoring puts the stack files back exactly as they were - and keeps the current files to one
      side first, so even a restore can be undone.</p>
      <div class="table-wrap" id="bkWrap"><p class="hint">Loading…</p></div></div>`;
  const load = async () => {
    const d = await api("/api/backup/list");
    const wrap = document.getElementById("bkWrap");
    if (!d.backups.length) { wrap.innerHTML = '<p class="hint">No backups yet - the first runs tonight, or press "Back up now".</p>'; return; }
    wrap.innerHTML = `<table><caption>Saved backups, newest first</caption>
      <thead><tr><th>Made</th><th>File</th><th>Size</th><th></th></tr></thead><tbody>
      ${d.backups.map(b => `<tr><td>${esc(b.made)}</td><td>${esc(b.name)}</td>
        <td>${(b.size / 1048576).toFixed(1)} MB</td>
        <td class="nowrap">
          <a class="btn" href="/api/backup/download/${encodeURIComponent(b.name)}">Download</a>
          <button class="btn" data-restore="${esc(b.name)}">Restore</button>
        </td></tr>`).join("")}</tbody></table>`;
    wrap.querySelectorAll("[data-restore]").forEach(btn => {
      let armed = false;
      btn.addEventListener("click", async () => {
        if (!armed) { armed = true; btn.textContent = "Really restore?"; btn.classList.add("btn-danger");
          setTimeout(() => { armed = false; btn.textContent = "Restore"; btn.classList.remove("btn-danger"); }, 5000); return; }
        btn.disabled = true;
        try {
          const res = await api("/api/backup/restore", { method: "POST", body: { name: btn.dataset.restore } });
          popAlert(btn, res.message, "success");
          await refreshStacks();
        } catch (e) { popAlert(btn, e.message, "danger"); }
        btn.disabled = false; armed = false; btn.textContent = "Restore"; btn.classList.remove("btn-danger");
      });
    });
  };
  document.getElementById("backupNow").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try { const r = await api("/api/backup/run", { method: "POST", body: {} }); popAlert(e.target, `Backup made: ${r.name}`, "success"); await load(); }
    catch (err) { popAlert(e.target, err.message, "danger"); }
    e.target.disabled = false;
  });
  await load();
}

/* ---- settings ---- */

const ACCENTS = ["", "red", "pink", "purple", "deep_purple", "indigo", "blue", "light_blue",
  "cyan", "teal", "green", "light_green", "lime", "yellow", "amber", "orange",
  "deep_orange", "brown", "grey", "blue_grey"];

async function viewSettings() {
  let s;
  try { s = await api("/api/settings"); } catch (e) { content.innerHTML = `<p class="alert alert-danger">! ${esc(e.message)}</p>`; return; }
  content.innerHTML = `<h1>Settings</h1>
    ${s._smtp_ready ? "" : `<p class="alert alert-warning">! Email isn't fully set up, so error alerts are recorded in Activity but not emailed. Fill in the email section below and press "Send test email".</p>`}
    <div class="panel"><div class="panel-head"><h2>Engine</h2></div>
      <div class="form-grid">
        <div class="field"><label for="setEngine">Engine</label>
          <select id="setEngine">
            <option value="docker">Docker</option>
            <option value="podman">Podman</option>
          </select>
          <span class="hint">Both are managed the same way - this just labels things correctly and points at the right socket.</span></div>
        <div class="field"><label for="setSocket">Engine socket path</label>
          <input id="setSocket" spellcheck="false">
          <span class="hint">Docker default: /var/run/docker.sock &middot; Podman: /run/podman/podman.sock (mounted into the Dockle container).</span></div>
        <div class="btn-row">
          <button class="btn" id="testRuntime">Test connection</button></div>
      </div></div>
    <div class="panel"><div class="panel-head"><h2>Email alerts</h2></div>
      <div class="form-grid">
        <div class="two-col">
          <div class="field"><label for="smtpHost">SMTP server</label><input id="smtpHost" spellcheck="false"></div>
          <div class="field"><label for="smtpPort">Port</label><input id="smtpPort" inputmode="numeric"></div>
        </div>
        <div class="field"><label for="smtpSec">Connection security</label>
          <select id="smtpSec"><option value="starttls">STARTTLS (usual, port 587)</option>
          <option value="tls">TLS (port 465)</option><option value="none">None (LAN relay only)</option></select></div>
        <div class="two-col">
          <div class="field"><label for="smtpUser">SMTP username</label><input id="smtpUser" autocomplete="off" spellcheck="false"></div>
          <div class="field"><label for="smtpPass">SMTP password</label><input id="smtpPass" type="password" autocomplete="new-password" placeholder="unchanged">
            <span class="hint">Stored encrypted. Leave blank to keep the saved one.</span></div>
        </div>
        <div class="two-col">
          <div class="field"><label for="smtpFrom">Send from</label><input id="smtpFrom" spellcheck="false" placeholder="dockle@yourdomain"></div>
          <div class="field"><label for="alertTo">Send alerts to</label><input id="alertTo" spellcheck="false"></div>
        </div>
        <div class="field"><label class="check-row">
          <input type="checkbox" id="alertOn"> Email me when an error happens</label></div>
        <div class="btn-row">
          <button class="btn" id="testSmtp">Send test email</button></div>
      </div></div>
    <div class="panel"><div class="panel-head"><h2>Backups</h2></div>
      <div class="two-col">
        <div class="field"><label for="bkHour">Daily backup hour (0-23)</label><input id="bkHour" inputmode="numeric"></div>
        <div class="field"><label for="bkKeep">Keep backups for (days)</label><input id="bkKeep" inputmode="numeric"></div>
      </div></div>
    <div class="panel"><div class="panel-head"><h2>Appearance</h2></div>
      <div class="form-grid">
        <div class="field"><label for="setAccent">Accent colour</label>
          <select id="setAccent">${ACCENTS.map(a => `<option value="${a}">${a === "" ? "Brand yellow (default)" : a.replace("_", " ")}</option>`).join("")}</select></div>
        <div class="field"><label for="setTheme">Theme</label>
          <select id="setTheme"><option value="">Follow this device</option>
          <option value="light">Light</option><option value="dark">Dark</option></select></div>
      </div></div>
    <div class="panel"><div class="panel-head"><h2>Account</h2></div>
      <div class="form-grid">
        <div class="field"><label for="pwCurrent">Current password</label><input id="pwCurrent" type="password" autocomplete="current-password"></div>
        <div class="field"><label for="pwNew">New password <span class="hint">(at least 12 characters)</span></label><input id="pwNew" type="password" autocomplete="new-password"></div>
        <div><button class="btn" id="pwBtn">Change password</button></div>
        <div class="field"><span class="field-label">Two-factor authentication</span><div id="tfaHost"></div></div>
      </div></div>
    <div class="panel">
      <div class="form-grid"><button class="btn btn-primary" id="saveSettings">Save settings</button></div>
    </div>
    <p class="hint mt-lg">Dockle is inspired by <a href="https://github.com/louislam/dockge" rel="noopener">Dockge</a>. Built for home labs.</p>`;

  const f = (id) => document.getElementById(id);
  f("setEngine").value = s["runtime.engine"];
  f("setSocket").value = s["runtime.socket"];
  f("smtpHost").value = s["smtp.host"];
  f("smtpPort").value = s["smtp.port"];
  f("smtpSec").value = s["smtp.security"];
  f("smtpUser").value = s["smtp.username"];
  f("smtpPass").value = "";
  f("smtpPass").placeholder = s["smtp.password"] ? "saved - leave blank to keep" : "not set";
  f("smtpFrom").value = s["smtp.from"];
  f("alertTo").value = s["alerts.email_to"];
  f("alertOn").checked = s["alerts.on_error"] === "1";
  f("bkHour").value = s["backup.hour"];
  f("bkKeep").value = s["backup.retention_days"];
  f("setAccent").value = s["ui.accent"];
  f("setTheme").value = localStorage.getItem("dockle-theme") || "";

  f("saveSettings").addEventListener("click", async () => {
    try {
      await api("/api/settings", { method: "POST", body: {
        "runtime.engine": f("setEngine").value,
        "runtime.socket": f("setSocket").value,
        "smtp.host": f("smtpHost").value,
        "smtp.port": f("smtpPort").value,
        "smtp.security": f("smtpSec").value,
        "smtp.username": f("smtpUser").value,
        "smtp.password": f("smtpPass").value,
        "smtp.from": f("smtpFrom").value,
        "alerts.email_to": f("alertTo").value,
        "alerts.on_error": f("alertOn").checked ? "1" : "0",
        "backup.hour": f("bkHour").value,
        "backup.retention_days": f("bkKeep").value,
        "ui.accent": f("setAccent").value,
      } });
      applyAccent(f("setAccent").value);
      const theme = f("setTheme").value;
      theme ? localStorage.setItem("dockle-theme", theme) : localStorage.removeItem("dockle-theme");
      applyTheme();
      popAlert(f("saveSettings"), "Settings saved.", "success");
    } catch (e) { popAlert(f("saveSettings"), e.message, "danger"); }
  });

  f("testRuntime").addEventListener("click", async () => {
    try {
      const r = await api("/api/settings/test-runtime", { method: "POST", body: {
        engine: f("setEngine").value, socket: f("setSocket").value } });
      popAlert(f("testRuntime"), r.message, "success");
    } catch (e) { popAlert(f("testRuntime"), e.message, "danger"); }
  });
  f("testSmtp").addEventListener("click", async () => {
    popAlert(f("testSmtp"), "Sending test email…", "info");
    try { const r = await api("/api/settings/test-smtp", { method: "POST", body: {} }); popAlert(f("testSmtp"), r.message, "success"); }
    catch (e) { popAlert(f("testSmtp"), e.message, "danger"); }
  });
  f("pwBtn").addEventListener("click", async () => {
    try {
      await api("/api/account/password", { method: "POST", body: {
        current: f("pwCurrent").value, new: f("pwNew").value } });
      f("pwCurrent").value = f("pwNew").value = "";
      popAlert(f("pwBtn"), "Password changed.", "success");
    } catch (e) { popAlert(f("pwBtn"), e.message, "danger"); }
  });

  renderTfa(document.getElementById("tfaHost"));
  await renderDockleUpdatePanel();
  await renderHostCompanionPanel();
}

/* Streams the install: stage + host install + (on success) edit
   compose.yaml and restart Dockle itself to reconnect. That last step
   tears down the very container serving this request, so the fetch
   stream ends abruptly right after "[dockle-restarting]" - expected,
   not a failure. Poll /health (no auth needed) until Dockle answers
   again, then refresh the panel in place. */
async function installCompanion(btn) {
  btn.disabled = true; btn.textContent = "Installing…";
  const panel = openProgressPanel("Installing dockle-companion");
  let restarting = false;
  try {
    const res = await fetch("/api/hostcompanion/install", { method: "POST", headers: { "X-CSRF": CSRF } });
    ({ restarting } = await readDockleStream(res, {
      onLine: line => panel.line(line),
      onRestarting: () => panel.line("Reconnecting Dockle…"),
    }));
  } catch (e) {
    if (!restarting) {
      panel.line("ERROR: " + e.message);
      panel.done(false);
      btn.disabled = false; btn.textContent = "Install companion";
      return;
    }
    // else: expected - the connection dropped because Dockle restarted itself
  }
  if (restarting) {
    await waitForDockleBack(panel);
  } else {
    panel.done(true);
  }
  if (location.hash === "#/settings") await renderHostCompanionPanel();
}

async function waitForDockleBack(panel) {
  panel.line("Waiting for Dockle to come back…");
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    if (panel.closed()) return; // dismissed - stop narrating, the restart itself still completes
    try {
      const res = await fetch("/health", { cache: "no-store" });
      if (res.ok) { panel.line("Reconnected."); panel.done(true); return; }
    } catch (e) { /* still down - keep waiting */ }
  }
  panel.line("Still not back after a minute - check the container directly (docker ps / docker logs dockle).");
  panel.done(false);
}

/* Updating Dockle itself, without a terminal. The button can't just
   run a redeploy like any other stack would: `compose up` stops
   Dockle's container, which kills the process running the command, so
   the restart half never happens and Dockle stays down. The server side
   hands the job to a throwaway container instead (see
   runtime.self_update_stream); from here it looks like a stream that
   stops mid-flight, after which we wait for /health to answer again. */
async function renderDockleUpdatePanel() {
  document.querySelectorAll(".dockle-update-panel").forEach(p => p.remove());
  const panel = el(`<div class="panel dockle-update-panel">
    <div class="panel-head"><h2>Dockle itself</h2></div>
    <p>Pulls the newest Dockle, rebuilds it and restarts - your stacks keep running
      throughout; only this page goes away for a few seconds.</p>
    <div class="btn-row align-center">
      <button class="btn btn-steady-wide" id="dockleCheckBtn">Check for a new version</button>
      <button class="btn btn-primary btn-steady" id="dockleUpdateBtn">Update Dockle</button>
      <span class="hint" id="dockleUpdateResult"></span>
    </div></div>`);
  content.appendChild(panel);
  const result = panel.querySelector("#dockleUpdateResult");

  panel.querySelector("#dockleCheckBtn").addEventListener("click", async (e) => {
    e.target.disabled = true; e.target.textContent = "Checking…";
    try {
      const r = await api("/api/system/self-update/check");
      if (!r.git) {
        result.textContent = `Can't tell (${r.reason}) - Update still rebuilds and restarts.`;
      } else if (r.behind === null) {
        // r.reason is git's own words - show them rather than a summary
        // of them, since the reason is usually the actionable part.
        result.textContent = `Couldn't check: ${r.reason || "the remote didn't answer"}`;
      } else if (r.behind === 0) {
        result.textContent = "Already on the newest version.";
      } else {
        result.textContent = `${r.behind} new commit${r.behind === 1 ? "" : "s"} available.`;
      }
    } catch (err) { popAlert(e.target, err.message, "danger", 5000); }
    e.target.disabled = false; e.target.textContent = "Check for a new version";
  });

  // Deliberately not armedAction: this isn't destructive (nothing is
  // deleted and the stacks stay up), and armedAction jumps to the
  // dashboard when its action resolves - which would yank the page away
  // from the update output the moment Dockle came back.
  const updateBtn = panel.querySelector("#dockleUpdateBtn");
  updateBtn.addEventListener("click", async () => {
    updateBtn.disabled = true;
    updateBtn.textContent = "Updating…";
    await updateDockle();
    updateBtn.disabled = false;
    updateBtn.textContent = "Update Dockle";
  });
}

async function updateDockle() {
  const progress = openProgressPanel("Updating Dockle");
  let restarting = false;
  try {
    const res = await fetch("/api/system/self-update", { method: "POST", headers: { "X-CSRF": CSRF } });
    ({ restarting } = await readDockleStream(res, {
      onLine: line => progress.line(line),
      onRestarting: () => progress.line("Dockle is restarting itself…"),
    }));
  } catch (e) {
    if (!restarting) {
      progress.line("ERROR: " + e.message);
      progress.done(false);
      return;
    }
    // else: expected - the connection died because Dockle replaced itself
  }
  if (restarting) {
    await waitForDockleBack(progress);
    if (location.hash === "#/settings") await viewSettings();
  } else {
    progress.done(true);
  }
}

async function renderHostCompanionPanel() {
  document.querySelectorAll(".host-companion-panel").forEach(p => p.remove());
  const panel = el(`<div class="panel host-companion-panel"><div class="panel-head"><h2>Host OS &amp; Tailscale</h2></div>
    <div id="hostCompanionBody"><p class="hint">Checking…</p></div></div>`);
  content.appendChild(panel);
  const body = panel.querySelector("#hostCompanionBody");
  let status;
  try { status = await api("/api/hostcompanion/status"); } catch (e) { status = { available: false }; }

  if (!status.available) {
    body.innerHTML = `<p>Not set up. This is entirely optional and separate from everything else Dockle
      does - it's a small helper that runs directly on your server (not in a container, called the
      dockle-companion) so Dockle can check host OS updates and manage Tailscale Serve, neither of
      which the Docker connection alone can reach.</p>
      <div class="btn-row align-center">
        <button class="btn btn-primary" id="companionInstallBtn">Install companion</button>
        <span class="hint">Installs a systemd service on this host, then reconnects Dockle to it automatically - Dockle briefly restarts itself as the last step.</span>
      </div>`;
    body.querySelector("#companionInstallBtn").addEventListener("click", (e) => installCompanion(e.target));
    return;
  }

  const os = status.os || {};
  const ts = status.tailscale || {};
  body.innerHTML = `<div class="form-grid">
    <div>
      <h3>Host OS updates</h3>
      <p class="hint">${esc(os.name || "Unknown OS")}${os.supported ? "" : " - not Debian/Ubuntu, updates aren't available here"}</p>
      ${os.supported ? `<div class="btn-row align-center">
        <button class="btn btn-steady" id="osCheckBtn">Check for updates</button>
        <button class="btn btn-primary btn-steady" id="osApplyBtn" disabled>Apply updates</button>
        <span class="hint" id="osResult"></span></div>` : ""}
    </div>
    <div>
      <h3>Tailscale</h3>
      ${!ts.installed
        ? '<p class="hint">Not installed on this host.</p><button class="btn" id="tsInstallBtn">Install Tailscale</button>'
        : `<p class="hint">${ts.running ? "✓ Running" : "Installed, not running"}${ts.dnsName ? ` - <code>${esc(ts.dnsName)}</code>` : ""}</p>`}
    </div>
  </div>
  <p class="hint mt-lg">Restart Docker and Reboot server are up in the top bar, next to Sign out.</p>`;

  if (os.supported) {
    let checkedCount = 0;
    body.querySelector("#osCheckBtn").addEventListener("click", async (e) => {
      e.target.disabled = true; e.target.textContent = "Checking…";
      try {
        const r = await api("/api/hostcompanion/os-update-check", { method: "POST", body: {} });
        checkedCount = r.upgradable;
        body.querySelector("#osResult").textContent = r.upgradable
          ? `${r.upgradable} package(s) can be updated.` : "Everything is up to date.";
        body.querySelector("#osApplyBtn").disabled = r.upgradable === 0;
      } catch (err) { popAlert(e.target, err.message, "danger"); }
      e.target.disabled = false; e.target.textContent = "Check for updates";
    });
    body.querySelector("#osApplyBtn").addEventListener("click", async (e) => {
      e.target.disabled = true; e.target.textContent = "Applying…";
      try {
        await api("/api/hostcompanion/os-update-apply", { method: "POST", body: {} });
        popAlert(e.target, "Host packages updated.", "success");
        body.querySelector("#osResult").textContent = "Up to date.";
      } catch (err) { popAlert(e.target, err.message, "danger"); }
      e.target.disabled = true; e.target.textContent = "Apply updates";
    });
  }
  if (!ts.installed) {
    body.querySelector("#tsInstallBtn").addEventListener("click", async (e) => {
      e.target.disabled = true; e.target.textContent = "Installing…";
      try {
        const r = await api("/api/hostcompanion/tailscale/install", { method: "POST", body: {} });
        popAlert(e.target, r.message, "success");
        await new Promise(res => setTimeout(res, 900));
        panel.remove();
        await renderHostCompanionPanel();
      } catch (err) { popAlert(e.target, err.message, "danger"); e.target.disabled = false; e.target.textContent = "Install Tailscale"; }
    });
  }
}

/* Top bar's Restart Docker / Reboot server buttons - checked once at
   boot (not per-route, the top bar is static markup) and shown only
   if the companion is actually installed, since both need real host
   access the Docker socket alone can't reach. */
async function initHostPowerButtons() {
  let status;
  try { status = await api("/api/hostcompanion/status"); } catch (e) { return; }
  if (!status.available) return;

  const dockerRestartBtn = document.getElementById("topbarDockerRestartBtn");
  dockerRestartBtn.classList.remove("hidden");
  dockerRestartBtn.dataset.tipOrig = "Restart Docker";
  armedAction(dockerRestartBtn, async () => {
    const r = await api("/api/hostcompanion/docker-restart", { method: "POST", body: {} });
    popAlert(dockerRestartBtn, r.message, "success");
  }, "restart Docker on the host");

  const rebootBtn = document.getElementById("topbarRebootBtn");
  rebootBtn.classList.remove("hidden");
  rebootBtn.dataset.tipOrig = "Reboot server";
  armedAction(rebootBtn, async () => {
    const r = await api("/api/hostcompanion/reboot", { method: "POST", body: {} });
    popAlert(rebootBtn, r.message, "success");
  }, "reboot the whole server");
}

async function renderTfa(host) {
  // The settings payload doesn't say whether 2FA is on; ask the begin/disable
  // endpoints to drive the flow and show state from what succeeds.
  host.innerHTML = `
    <div class="btn-row align-center">
      <button class="btn" id="tfaStart">Set up 2FA</button>
      <button class="btn" id="tfaOff">Turn 2FA off</button>
      <span class="hint">Optional. Adds a six-digit code from an authenticator app at sign-in.</span>
    </div>
    <div id="tfaFlow" class="mt-lg"></div>`;
  host.querySelector("#tfaStart").addEventListener("click", async () => {
    try {
      const r = await api("/api/2fa/begin", { method: "POST", body: {} });
      const flow = host.querySelector("#tfaFlow");
      flow.innerHTML = `<div class="form-grid">
        <p>Scan this with your authenticator app, then type the six-digit code it shows.</p>
        <div class="qr-box">${r.qr_svg}</div><!-- real SVG markup, not text - segno-generated server-side from a freshly random secret, never user input, so left un-esc()'d -->
        <p class="hint">Or enter the key by hand: <code>${esc(r.secret)}</code></p>
        <div class="field"><label for="tfaCode">Six-digit code</label><input id="tfaCode" inputmode="numeric" autocomplete="one-time-code"></div>
        <button class="btn btn-primary" id="tfaConfirm">Switch 2FA on</button></div>`;
      const confirmBtn = flow.querySelector("#tfaConfirm");
      confirmBtn.addEventListener("click", async () => {
        try {
          await api("/api/2fa/enable", { method: "POST", body: { code: flow.querySelector("#tfaCode").value } });
          flow.innerHTML = '<p class="alert alert-success">✓ Two-factor is on. You’ll need your app next sign-in.</p>';
        } catch (e) { popAlert(confirmBtn, e.message, "danger"); }
      });
    } catch (e) { popAlert(host.querySelector("#tfaStart"), e.message, "danger"); }
  });
  host.querySelector("#tfaOff").addEventListener("click", async () => {
    const flow = host.querySelector("#tfaFlow");
    flow.innerHTML = `<div class="form-grid">
      <div class="field"><label for="tfaOffCode">Enter a current six-digit code to turn 2FA off</label>
      <input id="tfaOffCode" inputmode="numeric"></div>
      <button class="btn btn-danger" id="tfaOffConfirm">Turn off</button></div>`;
    const offConfirmBtn = flow.querySelector("#tfaOffConfirm");
    offConfirmBtn.addEventListener("click", async () => {
      try {
        await api("/api/2fa/disable", { method: "POST", body: { code: flow.querySelector("#tfaOffCode").value } });
        flow.innerHTML = '<p class="alert alert-success">✓ Two-factor is off.</p>';
      } catch (e) { popAlert(offConfirmBtn, e.message, "danger"); }
    });
  });
}

/* ---------- theme & accent ---------- */

function applyTheme() {
  const choice = localStorage.getItem("dockle-theme");
  if (choice) document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
}

function applyAccent(name) {
  if (name) document.documentElement.dataset.accent = name;
  else delete document.documentElement.dataset.accent;
  localStorage.setItem("dockle-accent", name || "");
}

/* ---------- boot ---------- */

document.getElementById("sidebarToggle").addEventListener("click", () =>
  document.getElementById("sidebar").classList.toggle("open"));

window.addEventListener("hashchange", route);
applyTheme();
applyAccent(localStorage.getItem("dockle-accent") || "");
refreshStacks().then(route);
renderVersions();
setInterval(() => { if ((location.hash || "#/") === "#/") refreshStacks(); }, 15000);
setInterval(renderVersions, 60000);
initHostPowerButtons();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/static/sw.js");
