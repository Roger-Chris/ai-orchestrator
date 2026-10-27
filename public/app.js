const $ = (sel) => document.querySelector(sel);
const PROVIDERS = ["claude", "codex", "gemini", "perplexity"];
const LABEL = { claude: "Claude", codex: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity" };

function token() {
  try { return localStorage.getItem("orc.token") || ""; } catch { return ""; }
}
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { $("#tokenDlg").showModal(); throw new Error("unauthorized"); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Small, safe markdown renderer: escapes everything, then adds formatting. */
function md(src) {
  const blocks = [];
  let s = esc(src).replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code data-lang="${lang}">${code}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s
    .replace(/^#### (.*)$/gm, "<h4>$1</h4>")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/(?:^(?:[-*]|\d+\.) .*(?:\n|$))+/gm, (list) => {
    const ordered = /^\d+\./.test(list);
    const items = list.trim().split("\n").map((l) => `<li>${l.replace(/^(?:[-*]|\d+\.) /, "")}</li>`).join("");
    return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
  });
  s = s.split(/\n{2,}/).map((p) => (/^\s*<(h\d|ul|ol|pre)|^\u0000/.test(p) ? p : `<p>${p.replace(/\n/g, "<br>")}</p>`)).join("\n");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

const ago = (ts) => {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(ts).toLocaleDateString();
};

// ---------- tabs
document.querySelectorAll(".tab").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${b.dataset.tab}`));
    if (b.dataset.tab === "usage") loadUsage();
  }),
);

// ---------- devices
function providerChip(p) {
  const cls = p.ready ? "ok" : p.coolingDownUntil ? "warn" : "err";
  const title = p.coolingDownUntil ? `usage limit, back ${new Date(p.coolingDownUntil).toLocaleTimeString()}` : p.detail || (p.ready ? "ready" : "not available");
  return `<span class="chip" title="${esc(title)}"><span class="dot ${cls}"></span>${LABEL[p.id] || p.id}${p.load > 0 ? ` · ${Math.round(p.load * 100)}%` : ""}</span>`;
}
async function loadNodes(refresh = false) {
  try {
    const n = await api(refresh ? "/api/nodes/refresh" : "/api/nodes", refresh ? { method: "POST" } : {});
    $("#nodeName").textContent = `· ${n.self.name}`;
    const node = (x, extra) =>
      `<div class="node"><div class="node-h"><span>${esc(x.name)}</span><span class="muted small">${extra}</span></div><div class="chips">${x.providers.map(providerChip).join("")}</div></div>`;
    $("#nodes").innerHTML =
      node(n.self, "this device") +
      n.peers.map((p) => node(p, p.online ? `via ${p.via}` : "offline")).join("") +
      (n.peers.length ? "" : `<p class="muted small">No other devices yet. Run <code>orc serve</code> on another machine on your tailnet with the same ORC_TOKEN.</p>`);
  } catch (e) {
    $("#nodes").innerHTML = `<p class="muted small">${esc(e.message)}</p>`;
  }
}
$("#refreshNodes").addEventListener("click", () => loadNodes(true));

// ---------- history
let currentRun = null;
async function loadHistory() {
  try {
    const runs = await api("/api/runs?limit=40");
    const dot = { done: "ok", failed: "err", cancelled: "err" };
    $("#history").innerHTML = runs
      .map((r) => `<li data-id="${r.id}" class="${r.id === currentRun ? "active" : ""}" title="${esc(r.task)}"><span class="dot ${dot[r.status] || "warn"}"></span><span class="t">${esc(r.task)}</span><span class="muted small">${ago(r.createdAt)}</span></li>`)
      .join("") || `<li class="muted small">No runs yet.</li>`;
  } catch { /* token dialog handles auth */ }
}
$("#history").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (li) openRun(li.dataset.id);
});

// ---------- composer
async function loadMeta() {
  const [agents, caps] = await Promise.all([api("/api/agents"), api("/api/capabilities")]);
  $("#provider").innerHTML += PROVIDERS.map((p) => `<option value="${p}">${LABEL[p]}</option>`).join("");
  $("#agent").innerHTML += agents.map((a) => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("");
  $("#agents").innerHTML = agents
    .map((a) => `<div class="card"><h3>${esc(a.name)}</h3><div class="muted small">${esc(a.kind)} · prefers ${a.prefer.map((p) => LABEL[p]).join(", ") || "any"}${a.permission ? ` · ${a.permission}` : ""}</div><p>${esc(a.description)}</p></div>`)
    .join("");
  $("#caps").innerHTML =
    `<thead><tr><th>Kind of work</th>${PROVIDERS.map((p) => `<th class="p-${p}">${LABEL[p]}</th>`).join("")}</tr></thead><tbody>` +
    Object.keys(caps)
      .map((k) => {
        const best = Math.max(...PROVIDERS.map((p) => caps[k][p]));
        return `<tr><td>${k.replace(/_/g, " ")}</td>${PROVIDERS.map((p) => `<td class="${caps[k][p] === best ? "best" : ""}">${caps[k][p]}</td>`).join("")}</tr>`;
      })
      .join("") +
    "</tbody>";
}

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { task: $("#task").value.trim(), mode: $("#mode").value };
  for (const k of ["provider", "agent", "permission", "cwd"]) if ($(`#${k}`).value.trim()) body[k] = $(`#${k}`).value.trim();
  // Branch work writes code (on branches, never in your folder), so it needs edit access.
  if ($("#branches").checked) {
    body.branches = true;
    if (!body.permission) body.permission = "edit";
  }
  if (!body.task) return;
  $("#runBtn").disabled = true;
  try {
    const run = await api("/api/runs", { method: "POST", body: JSON.stringify(body) });
    loadHistory();
    openRun(run.id);
  } catch (err) {
    alert(err.message);
  } finally {
    $("#runBtn").disabled = false;
  }
});
$("#task").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#composer").requestSubmit();
});

// ---------- run view
let streamAbort = null;
const stepEls = new Map();

function stepCard(id, title, meta = "") {
  let el = stepEls.get(id);
  if (!el) {
    el = document.createElement("div");
    el.className = "step pending";
    el.innerHTML = `<div class="step-h"><span class="step-title"></span><span class="badge muted">pending</span></div><div class="muted small meta"></div><div class="log"></div><div class="out md hidden"></div><div class="rate hidden"><span class="muted small">Good pick?</span><button class="ghost small" data-r="1" aria-label="Good">👍</button><button class="ghost small" data-r="-1" aria-label="Bad">👎</button></div>`;
    el.querySelector(".rate").addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      await api(`/api/runs/${currentRun}/steps/${id}/rate`, { method: "POST", body: JSON.stringify({ rating: +b.dataset.r }) });
      el.querySelectorAll(".rate button").forEach((x) => x.classList.toggle("on", x === b));
    });
    $("#steps").appendChild(el);
    stepEls.set(id, el);
  }
  if (title) el.querySelector(".step-title").textContent = title;
  if (meta) el.querySelector(".meta").textContent = meta;
  return el;
}
function setBadge(el, status, provider, node) {
  el.className = `step ${status}`;
  const b = el.querySelector(".badge");
  b.className = `badge ${provider ? `p-${provider}` : "muted"}`;
  b.textContent = provider ? `${LABEL[provider] || provider}${node ? ` @ ${node}` : ""}` : status;
}
function log(el, line) {
  const l = el.querySelector(".log");
  l.textContent += (l.textContent ? "\n" : "") + line;
  l.scrollTop = l.scrollHeight;
}

function handle(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case "run.classified":
      $("#runMeta").textContent = `${d.kind.replace(/_/g, " ")} · ${d.complexity}${d.alsoKinds.length ? ` · also ${d.alsoKinds.join(", ")}` : ""}`;
      break;
    case "plan.created":
      if (stepEls.has("plan")) setBadge(stepEls.get("plan"), "done");
      for (const s of d.steps) stepCard(s.id, s.title, `${s.agent || s.kind}${s.dependsOn.length ? ` · after ${s.dependsOn.join(", ")}` : ""}`);
      break;
    case "step.started": {
      const el = stepCard(ev.stepId, d.title, d.agent ? `${d.agent} · ${d.kind}` : d.kind);
      const top = d.ranking?.[0];
      setBadge(el, "running", top?.provider, top?.node);
      if (d.ranking?.length) log(el, `ranked: ${d.ranking.map((r) => `${r.provider}@${r.node} ${r.score.toFixed(1)}`).join(" > ")}`);
      el.dataset.text = "";
      break;
    }
    case "step.progress": {
      const note = { context: "Memory & code map", branches: "Git branches" }[ev.stepId];
      const el = stepCard(ev.stepId, ev.stepId === "plan" ? "Planning" : note || "");
      log(el, d.note);
      // These are notes, not steps: nothing will ever "complete" them.
      if (note) setBadge(el, "done");
      break;
    }
    case "step.fallback":
      log(stepCard(ev.stepId), `↻ falling back to ${d.to} @ ${d.node}`);
      setBadge(stepCard(ev.stepId), "running", d.to, d.node);
      break;
    case "step.delta": {
      const el = stepCard(ev.stepId);
      el.dataset.text = (el.dataset.text || "") + d.text;
      const out = el.querySelector(".out");
      out.classList.remove("hidden");
      out.textContent = el.dataset.text.slice(-4000);
      break;
    }
    case "step.completed": {
      const el = stepCard(ev.stepId);
      setBadge(el, "done", d.provider, d.node);
      log(el, `✓ ${(d.durationMs / 1000).toFixed(1)}s${d.model ? ` · ${d.model}` : ""}`);
      const out = el.querySelector(".out");
      out.classList.remove("hidden");
      out.innerHTML = md(d.output || "");
      if (ev.stepId !== "synthesis") el.querySelector(".rate").classList.remove("hidden");
      break;
    }
    case "step.failed": {
      const el = stepCard(ev.stepId);
      el.className = `step ${d.skipped ? "skipped" : "failed"}`;
      log(el, `✗ ${d.error}`);
      break;
    }
    case "design.review_ready": {
      const reviews = d.reviews.map((r) => `${LABEL[r.provider] || r.provider || "?"}: ${r.ok ? r.verdict || "reviewed" : "failed"}`).join(" · ");
      $("#approvalMeta").textContent = `Round ${d.round}. Read the draft and the reviews above. ${reviews || "No reviewer was available."}`;
      $("#approvalNotes").value = "";
      $("#approval").classList.remove("hidden");
      $("#runMeta").textContent = "waiting for your approval";
      break;
    }
    case "design.approved":
    case "design.revising":
      $("#approval").classList.add("hidden");
      $("#runMeta").textContent = ev.type === "design.approved" ? `design approved${d.savedTo ? ` · saved to ${d.savedTo}` : ""}` : "revising the design";
      break;
    case "run.completed":
      loadBranches(ev.runId);
      $("#approval").classList.add("hidden");
      $("#resultWrap").classList.remove("hidden");
      $("#result").innerHTML = md(d.result || "");
      $("#result").dataset.raw = d.result || "";
      $("#cancelBtn").classList.add("hidden");
      loadHistory();
      loadNodes();
      break;
    case "run.failed":
      loadBranches(ev.runId);
      $("#approval").classList.add("hidden");
      $("#resultWrap").classList.remove("hidden");
      $("#result").innerHTML = `<p><strong>Run failed:</strong> ${esc(d.error)}</p>`;
      $("#cancelBtn").classList.add("hidden");
      loadHistory();
      break;
  }
}

async function openRun(id) {
  streamAbort?.abort();
  currentRun = id;
  stepEls.clear();
  $("#steps").innerHTML = "";
  $("#runView").classList.remove("hidden");
  $("#resultWrap").classList.add("hidden");
  $("#approval").classList.add("hidden");
  $("#branchesWrap").classList.add("hidden");
  $("#cancelBtn").classList.remove("hidden");
  document.querySelectorAll("#history li").forEach((li) => li.classList.toggle("active", li.dataset.id === id));
  const run = await api(`/api/runs/${id}`);
  $("#runTitle").textContent = run.task;
  $("#runMeta").textContent = run.status;
  if (["done", "failed", "cancelled"].includes(run.status)) $("#cancelBtn").classList.add("hidden");

  // SSE over fetch so the token travels in a header, never in the URL.
  streamAbort = new AbortController();
  const headers = token() ? { Authorization: `Bearer ${token()}` } : {};
  try {
    const res = await fetch(`/api/runs/${id}/events`, { headers, signal: streamAbort.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!data || data === "{}") continue;
        try {
          if (currentRun === id) handle(JSON.parse(data));
        } catch { /* ignore malformed frame */ }
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") console.error(e);
  }
}

$("#cancelBtn").addEventListener("click", async () => {
  if (currentRun) await api(`/api/runs/${currentRun}/cancel`, { method: "POST" });
});
// ---------- branches (review and merge on this device)
async function loadBranches(runId) {
  const run = await api(`/api/runs/${runId}`).catch(() => null);
  if (!run || currentRun !== runId) return;
  const steps = run.steps.filter((s) => s.branch?.pushed);
  $("#branchesWrap").classList.toggle("hidden", !steps.length);
  $("#branchList").innerHTML = steps
    .map((s) => {
      const b = s.branch;
      const tests = !b.tests ? `<span class="muted">tests not run</span>` : b.tests.ok ? `<span class="ok">tests passed</span>` : `<span class="bad">tests failed</span>`;
      const state = b.merged ? `<span class="ok">merged</span>` : b.mergeError ? `<span class="bad">${esc(b.mergeError)}</span>` : "";
      return `<div class="branch" data-step="${esc(s.id)}">
        <div class="branch-h"><strong>${esc(s.title)}</strong><span class="badge p-${esc(s.provider)}">${esc(LABEL[s.provider] || s.provider)} @ ${esc(b.node)}</span></div>
        <div class="small"><code>${esc(b.name)}</code> · ${b.changedFiles.length} file(s) · ${tests}</div>
        <details><summary class="small">Changes</summary><pre>${esc(b.diffStat)}</pre><pre>${esc(b.diff)}</pre>${b.tests && !b.tests.ok ? `<pre>${esc(b.tests.output)}</pre>` : ""}</details>
        <div class="approval-actions"><button class="primary small merge" ${b.merged ? "disabled" : ""}>${b.merged ? "Merged" : "Merge"}</button><span class="small state">${state}</span></div>
      </div>`;
    })
    .join("");
}
async function mergeStep(el) {
  const btn = el.querySelector(".merge");
  btn.disabled = true;
  try {
    await api(`/api/runs/${currentRun}/steps/${el.dataset.step}/merge`, { method: "POST" });
  } catch (e) {
    el.querySelector(".state").textContent = e.message;
  }
  await loadBranches(currentRun);
}
$("#branchList").addEventListener("click", (e) => {
  const el = e.target.closest(".merge") && e.target.closest(".branch");
  if (el) mergeStep(el);
});
$("#mergeAllBtn").addEventListener("click", async () => {
  // In plan order, so a branch that builds on another merges after it.
  for (const el of [...document.querySelectorAll("#branchList .branch")]) {
    if (el.querySelector(".merge").disabled || el.querySelector(".bad")) continue;
    await mergeStep(document.querySelector(`#branchList .branch[data-step="${CSS.escape(el.dataset.step)}"]`));
  }
});

async function decide(action) {
  const text = $("#approvalNotes").value.trim();
  if (action === "revise" && !text) return $("#approvalNotes").focus();
  const body = action === "approve" ? { notes: text } : { feedback: text };
  try {
    await api(`/api/runs/${currentRun}/${action}`, { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    alert(e.message);
  }
}
$("#approveBtn").addEventListener("click", () => decide("approve"));
$("#reviseBtn").addEventListener("click", () => decide("revise"));
$("#copyBtn").addEventListener("click", () => navigator.clipboard.writeText($("#result").dataset.raw || $("#result").innerText));

// ---------- usage
async function loadUsage() {
  const rows = await api("/api/usage?days=7");
  $("#usage").innerHTML =
    "<thead><tr><th>Day</th><th>Model</th><th>Device</th><th>Calls</th><th>OK</th><th>Failed</th><th>Avg time</th></tr></thead><tbody>" +
    (rows.length
      ? rows.map((r) => `<tr><td>${r.day}</td><td class="p-${r.provider}">${LABEL[r.provider] || r.provider}</td><td>${esc(r.node)}</td><td>${r.calls}</td><td>${r.ok}</td><td>${r.failed}</td><td>${(r.duration_ms / Math.max(r.calls, 1) / 1000).toFixed(1)}s</td></tr>`).join("")
      : `<tr><td colspan="7" class="muted">No calls yet.</td></tr>`) +
    "</tbody>";
}

// ---------- token dialog
$("#tokenBtn").addEventListener("click", () => {
  $("#tokenInput").value = token();
  $("#tokenDlg").showModal();
});
$("#tokenSave").addEventListener("click", () => {
  try { localStorage.setItem("orc.token", $("#tokenInput").value.trim()); } catch { /* storage blocked */ }
  location.reload();
});

loadNodes();
loadHistory();
loadMeta().catch(() => {});
setInterval(loadNodes, 20_000);
