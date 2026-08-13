/* Dockle front end - one window, hash routing, no frameworks. */
"use strict";

const CSRF = document.querySelector('meta[name="csrf"]').content;
const content = document.getElementById("content");
const stackListEl = document.getElementById("stackList");
const engineBadge = document.getElementById("engineBadge");

let stacksCache = [];
let liveSockets = [];
let dashboardDnsName = "";

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
         check <a href="#/settings">Settings → Host</a> that it's still running.</p>`
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
      toast(e.message, "danger");
    }
  });
}

let toastTimer;
function toast(message, kind = "info") {
  let t = document.getElementById("toast");
  if (!t) {
    t = el('<div id="toast" role="status" class="toast-host"></div>');
    document.body.appendChild(t);
  }
  t.innerHTML = `<p class="alert alert-${kind}">${kind === "danger" ? "! " : ""}${esc(message)}</p>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.innerHTML = "", 5000);
}

/* Code editor: wraps a plain textarea with CodeMirror so every text
   field in the app (compose YAML, .env) shares the same look - dark,
   monospace, line numbers. YAML mode additionally debounces calls to
   the server's own compose validator (the single source of truth for
   "is this valid compose", already used on save) for inline feedback. */
function attachCodeEditor(textareaEl, { mode = null, validate = false } = {}) {
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
    try {
      const res = await api("/api/validate", { method: "POST", body: { compose: text } });
      if (seq !== requestSeq) return; // a newer edit already superseded this check
      res.ok ? setStatus("ok", "Looks good") : setStatus("bad", res.error);
    } catch (e) {
      if (seq === requestSeq) setStatus("", "Couldn't check right now");
    }
  };
  cm.on("change", () => { clearTimeout(timer); timer = setTimeout(check, 600); });
  check();
  return cm;
}

function attachYamlEditor(textareaEl) {
  return attachCodeEditor(textareaEl, { mode: "yaml", validate: true });
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
};

/* ---------- sidebar / engine ---------- */

async function refreshStacks() {
  try {
    const data = await api("/api/stacks");
    stacksCache = data.stacks;
    dashboardDnsName = data.dnsName || "";
    const e = data.engine || {};
    engineBadge.textContent = e.ok ? `✓ ${e.engine} ${e.version}` : "! engine unreachable";
    engineBadge.className = "engine-badge " + (e.ok ? "ok" : "bad");
    if (data.engineError) engineBadge.title = data.engineError;
    renderStackList();
  } catch (e) {
    engineBadge.textContent = "! " + e.message;
    engineBadge.className = "engine-badge bad";
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
    const a = el(`<a href="${href}" ${current === href ? 'class="active"' : ""}>
      <span class="status-dot ${s.status}"></span><span>${esc(s.name)}</span></a>`);
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
];

async function route() {
  closeLiveSockets();
  document.getElementById("sidebar").classList.remove("open");
  document.querySelectorAll(".side-nav a").forEach(a =>
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
        toast(`'${name}' restored.`, "success");
        await refreshStacks();
        viewDashboard();
      } catch (err) { toast(err.message, "danger"); e.target.disabled = false; e.target.textContent = "Restore"; }
    });
    const purgeBtn = row.querySelector("#purgeBtn");
    purgeBtn.dataset.tipOrig = "Delete";
    armedAction(purgeBtn, async () => {
      const res = await api(`/api/archived/${encodeURIComponent(name)}/purge`, { method: "POST", body: {} });
      toast(res.removedImages.length ? `'${name}' deleted, image(s) removed.` : `'${name}' deleted.`, "success");
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
      toast(res.message || "A check is already running.", "info");
      btn.disabled = false; btn.textContent = "Check for updates";
      return;
    }
    // poll until the background check finishes, then reload with fresh badges
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      const status = await api("/api/stacks/check-updates/status");
      if (!status.checking) break;
    }
    toast("Update check finished.", "success");
    if ((location.hash || "#/") === "#/") viewDashboard();
  } catch (e) {
    toast(e.message, "danger");
    btn.disabled = false; btn.textContent = "Check for updates";
  }
}

async function updateAll() {
  const btn = document.getElementById("updateAllBtn");
  btn.disabled = true; btn.textContent = "Updating…";
  try {
    const res = await api("/api/stacks/update-all", { method: "POST", body: {} });
    toast(`Updated ${res.updated} of ${res.total}.`, res.updated === res.total ? "success" : "warning");
    await refreshStacks();
    viewDashboard();
  } catch (e) {
    btn.disabled = false; btn.textContent = "Update all";
    toast(e.message, "danger");
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
    toast(`Adopted ${res.adopted} of ${res.total}.`, res.adopted === res.total ? "success" : "warning");
    await refreshStacks();
    location.hash = "#/";
    viewDashboard();
  } catch (e) {
    btn.disabled = false; btn.textContent = "Adopt all";
    toast(e.message, "danger");
  }
}

const STATUS_TIPS = {
  running: "Container is running",
  update: "Update available - click to update",
  warning: "Warnings - check the log",
  partial: "Container is down",
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
    const runUpdate = async (e) => {
      e.stopPropagation();
      dot.classList.add("busy");
      dot.dataset.tip = "Updating…";
      try {
        const r = await api(`/api/stacks/${encodeURIComponent(s.name)}/quick-update`, { method: "POST", body: {} });
        toast(r.message || `'${s.name}' updated.`, "success");
        await refreshStacks();
        if ((location.hash || "#/") === "#/") viewDashboard();
      } catch (err) {
        toast(err.message, "danger");
        dot.classList.remove("busy");
        dot.dataset.tip = "Update available - click to update";
      }
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
        toast(`'${s.name}' archived.`, "success");
        await refreshStacks();
        if ((location.hash || "#/") === "#/") viewDashboard();
      } catch (err) {
        toast(err.message, "danger");
        archiveBtn.disabled = false; archiveBtn.textContent = "Archive";
      }
    });
    purgeBtn.dataset.tipOrig = "Delete";
    purgeBtn.addEventListener("click", e => e.stopPropagation());
    armedAction(purgeBtn, async () => {
      const res = await api(`/api/stacks/${encodeURIComponent(s.name)}/purge`, { method: "POST", body: {} });
      toast(res.removedImages.length ? `'${s.name}' deleted, image(s) removed.` : `'${s.name}' deleted.`, "success");
      await refreshStacks();
      if ((location.hash || "#/") === "#/") viewDashboard();
    }, "permanently delete this stack and its image - nothing kept");
  }
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
    toast(`Adopted '${res.name}'. ${res.note}.`, "success");
    await refreshStacks();
    location.hash = `#/stack/${encodeURIComponent(res.name)}`;
  } catch (e) {
    btn.disabled = false; btn.textContent = "Adopt";
    toast(e.message, "danger");
  }
}

/* ---- new stack ---- */

const COMPOSE_TEMPLATE = `services:
  app:
    image: nginx:alpine
    container_name: my-app
    restart: unless-stopped
    ports:
      - "8080:80"
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

  const cm = attachYamlEditor(document.getElementById("composeText"));
  const envCm = attachCodeEditor(document.getElementById("envText"));

  // Block disallowed characters at the source instead of complaining
  // later: anything typed or pasted that isn't lowercase/digit/-/_ just
  // never appears in the box (uppercase letters are folded to lowercase
  // rather than dropped, so pasting "Jellyfin" still gives "jellyfin").
  const nameInput = document.getElementById("stackName");
  nameInput.addEventListener("input", () => {
    const cleaned = nameInput.value.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (nameInput.value !== cleaned) {
      const pos = nameInput.selectionStart - (nameInput.value.length - cleaned.length);
      nameInput.value = cleaned;
      nameInput.setSelectionRange(Math.max(0, pos), Math.max(0, pos));
    }
  });

  document.getElementById("convertBtn").addEventListener("click", async () => {
    try {
      const res = await api("/api/convert", { method: "POST", body: { command: document.getElementById("runCmd").value } });
      cm.setValue(res.compose);
      toast("Converted - check the compose file, then create the stack.", "success");
    } catch (e) { toast(e.message, "danger"); }
  });
  document.getElementById("createBtn").addEventListener("click", async () => {
    const name = document.getElementById("stackName").value.trim();
    try {
      await api("/api/stacks", { method: "POST", body: {
        name, compose: cm.getValue(),
        env: envCm.getValue() } });
      toast(`Stack '${name}' created.`, "success");
      await refreshStacks();
      location.hash = `#/stack/${encodeURIComponent(name)}`;
    } catch (e) { toast(e.message, "danger"); }
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

  content.innerHTML = "";
  const head = el(`<div class="panel"><div class="panel-head">
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

  const tabs = el(`<div class="panel">
    <div class="tabs" role="tablist">
      <button data-tab="overview" class="active">Overview</button>
      <button data-tab="compose">Compose</button>
      <button data-tab="logs">Logs</button>
      <button data-tab="terminal">Terminal</button>
      <button data-tab="backup">Backup</button>
      <button data-tab="serve">Serve</button>
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
  delBtn.dataset.tipOrig = "Delete stack";
  armedAction(delBtn, () => streamAction(name, "delete", out, true), "delete this stack and its folder");

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
      const cm = attachYamlEditor(form.querySelector("#editCompose"));
      form.querySelector("#editEnv").value = s.env;
      const envCm = attachCodeEditor(form.querySelector("#editEnv"));
      const save = async () => {
        await api(`/api/stacks/${encodeURIComponent(name)}`, { method: "PUT", body: {
          compose: cm.getValue(),
          env: envCm.getValue() } });
        toast("Saved.", "success");
      };
      form.querySelector("#saveBtn").addEventListener("click", () => save().catch(e => toast(e.message, "danger")));
      form.querySelector("#saveUpBtn").addEventListener("click", async () => {
        try { await save(); runAction("up"); } catch (e) { toast(e.message, "danger"); }
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
              toast(res.message, "success");
            } catch (e) { toast(e.message, "danger"); }
            btn.disabled = false; armed = false; btn.textContent = "Restore"; btn.classList.remove("btn-danger");
          });
        });
      };
      tabBody.querySelector("#backupNowBtn").addEventListener("click", async (e) => {
        e.target.disabled = true; e.target.textContent = "Backing up…";
        try {
          const r = await api(`/api/stacks/${encodeURIComponent(name)}/backups`, { method: "POST", body: {} });
          toast(`Backup made: ${r.name}`, "success");
          await loadList();
        } catch (err) { toast(err.message, "danger"); }
        e.target.disabled = false; e.target.textContent = "Back up now";
      });
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
          toast(`Uploaded ${data.name} - it's in the list below, ready to restore.`, "success");
          await loadList();
        } catch (err) { toast(err.message, "danger"); }
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
          optional dockle-companion - see Settings → Host to install it with one click.</p>`;
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
            toast(`Serve ${e.target.checked ? "enabled" : "disabled"} for port ${port}.`, "success");
            renderTab.serve();
          } catch (err) { toast(err.message, "danger"); e.target.checked = !e.target.checked; e.target.disabled = false; }
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
}

async function streamAction(name, action, out, isDelete = false) {
  out.innerHTML = "";
  appendLog(out, `$ ${action} ${name}`);
  document.querySelectorAll(".panel-head .icon-btn").forEach(b => b.disabled = true);
  try {
    const res = await fetch(`/api/stacks/${encodeURIComponent(name)}/action/${action}`, {
      method: "POST", headers: { "X-CSRF": CSRF },
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let ok = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (line === "[dockle-done:ok]") { ok = true; continue; }
        if (line === "[dockle-done:error]") { ok = false; continue; }
        const hint = line.match(/^\[dockle-hint:tailscale-port-conflict:(\d+):([01])\]$/);
        if (hint) { renderPortConflictHint(out, hint[1], hint[2] === "1"); continue; }
        if (line) appendLog(out, line);
      }
    }
    if (ok) {
      toast(`${action} finished.`, "success");
    } else {
      appendLog(out, `ERROR: ${action} did not complete cleanly - see above.`);
      toast(`${action} failed - the output panel has the details.`, "danger");
    }
    if (isDelete && ok) { await refreshStacks(); return; }
    await refreshStacks();
    if (!isDelete && location.hash === `#/stack/${encodeURIComponent(name)}`) {
      const output = out.innerHTML;
      await viewStack(name);
      const fresh = document.getElementById("actionOut");
      if (fresh) { fresh.innerHTML = output; fresh.scrollTop = fresh.scrollHeight; }
    }
  } catch (e) {
    appendLog(out, "ERROR: " + e.message);
    toast(e.message, "danger");
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
  ["volumes", "Unused volumes", "Deletes volumes no container uses. Volumes hold real data - this cannot be undone."],
];

async function viewMaintenance() {
  content.innerHTML = `<h1>Maintenance</h1>
    <div class="panel"><div class="panel-head"><h2>Disk usage</h2></div>
      <div class="table-wrap" id="dfWrap"><p class="hint">Loading…</p></div></div>
    <div class="panel"><div class="panel-head"><h2>Prune</h2>
      <span class="spacer"></span><button class="btn btn-primary" id="pruneAll">Prune everything</button></div>
      <p>Each cleans one kind of leftover. <strong>Prune everything</strong> runs the safe four together -
      volumes always stay a separate, deliberate step.</p>
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
            result.textContent = `Will permanently delete: ${prev.volumes.join(", ")}. Click again to confirm.`;
            setTimeout(() => { delete card.dataset.armed; if (result.textContent.startsWith("Will")) result.textContent = ""; }, 8000);
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
      toast(lines.join(" · "), res.ok ? "success" : "danger");
      viewMaintenance();
    } catch (err) {
      toast(err.message, "danger");
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
          toast(res.message, "success");
          await refreshStacks();
        } catch (e) { toast(e.message, "danger"); }
        btn.disabled = false; armed = false; btn.textContent = "Restore"; btn.classList.remove("btn-danger");
      });
    });
  };
  document.getElementById("backupNow").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try { const r = await api("/api/backup/run", { method: "POST", body: {} }); toast(`Backup made: ${r.name}`, "success"); await load(); }
    catch (err) { toast(err.message, "danger"); }
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
      toast("Settings saved.", "success");
    } catch (e) { toast(e.message, "danger"); }
  });

  f("testRuntime").addEventListener("click", async () => {
    try {
      const r = await api("/api/settings/test-runtime", { method: "POST", body: {
        engine: f("setEngine").value, socket: f("setSocket").value } });
      toast(r.message, "success");
    } catch (e) { toast(e.message, "danger"); }
  });
  f("testSmtp").addEventListener("click", async () => {
    toast("Sending test email…");
    try { const r = await api("/api/settings/test-smtp", { method: "POST", body: {} }); toast(r.message, "success"); }
    catch (e) { toast(e.message, "danger"); }
  });
  f("pwBtn").addEventListener("click", async () => {
    try {
      await api("/api/account/password", { method: "POST", body: {
        current: f("pwCurrent").value, new: f("pwNew").value } });
      f("pwCurrent").value = f("pwNew").value = "";
      toast("Password changed.", "success");
    } catch (e) { toast(e.message, "danger"); }
  });

  renderTfa(document.getElementById("tfaHost"));
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
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (line === "[dockle-restarting]") { restarting = true; panel.line("Reconnecting Dockle…"); continue; }
        if (line === "[dockle-done:ok]" || line === "[dockle-done:error]") continue;
        if (line) panel.line(line);
      }
    }
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
    await waitForCompanionReconnect(panel);
  } else {
    panel.done(true);
  }
  if (location.hash === "#/settings") await renderHostCompanionPanel();
}

async function waitForCompanionReconnect(panel) {
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

async function renderHostCompanionPanel() {
  document.querySelectorAll(".host-companion-panel").forEach(p => p.remove());
  const panel = el(`<div class="panel host-companion-panel"><div class="panel-head"><h2>Host (Tailscale &amp; updates)</h2></div>
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
      ${os.supported ? `<div class="btn-row">
        <button class="btn" id="osCheckBtn">Check for updates</button>
        <button class="btn btn-primary" id="osApplyBtn" disabled>Apply updates</button></div>
      <p class="hint" id="osResult"></p>` : ""}
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
      } catch (err) { toast(err.message, "danger"); }
      e.target.disabled = false; e.target.textContent = "Check for updates";
    });
    body.querySelector("#osApplyBtn").addEventListener("click", async (e) => {
      e.target.disabled = true; e.target.textContent = "Applying…";
      try {
        await api("/api/hostcompanion/os-update-apply", { method: "POST", body: {} });
        toast("Host packages updated.", "success");
        body.querySelector("#osResult").textContent = "Up to date.";
      } catch (err) { toast(err.message, "danger"); }
      e.target.disabled = true; e.target.textContent = "Apply updates";
    });
  }
  if (!ts.installed) {
    body.querySelector("#tsInstallBtn").addEventListener("click", async (e) => {
      e.target.disabled = true; e.target.textContent = "Installing…";
      try {
        const r = await api("/api/hostcompanion/tailscale/install", { method: "POST", body: {} });
        toast(r.message, "success");
        panel.remove();
        await renderHostCompanionPanel();
      } catch (err) { toast(err.message, "danger"); e.target.disabled = false; e.target.textContent = "Install Tailscale"; }
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
    toast(r.message, "success");
  }, "restart Docker on the host");

  const rebootBtn = document.getElementById("topbarRebootBtn");
  rebootBtn.classList.remove("hidden");
  rebootBtn.dataset.tipOrig = "Reboot server";
  armedAction(rebootBtn, async () => {
    const r = await api("/api/hostcompanion/reboot", { method: "POST", body: {} });
    toast(r.message, "success");
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
      flow.querySelector("#tfaConfirm").addEventListener("click", async () => {
        try {
          await api("/api/2fa/enable", { method: "POST", body: { code: flow.querySelector("#tfaCode").value } });
          flow.innerHTML = '<p class="alert alert-success">✓ Two-factor is on. You’ll need your app next sign-in.</p>';
        } catch (e) { toast(e.message, "danger"); }
      });
    } catch (e) { toast(e.message, "danger"); }
  });
  host.querySelector("#tfaOff").addEventListener("click", async () => {
    const flow = host.querySelector("#tfaFlow");
    flow.innerHTML = `<div class="form-grid">
      <div class="field"><label for="tfaOffCode">Enter a current six-digit code to turn 2FA off</label>
      <input id="tfaOffCode" inputmode="numeric"></div>
      <button class="btn btn-danger" id="tfaOffConfirm">Turn off</button></div>`;
    flow.querySelector("#tfaOffConfirm").addEventListener("click", async () => {
      try {
        await api("/api/2fa/disable", { method: "POST", body: { code: flow.querySelector("#tfaOffCode").value } });
        flow.innerHTML = '<p class="alert alert-success">✓ Two-factor is off.</p>';
      } catch (e) { toast(e.message, "danger"); }
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
setInterval(() => { if ((location.hash || "#/") === "#/") refreshStacks(); }, 15000);
initHostPowerButtons();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/static/sw.js");
