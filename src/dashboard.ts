import type { StatusReport } from "./types.js";

export function renderDashboard(report: StatusReport): string {
  const stat = (label: string, value: string | number) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`;
  const rows = report.recentActivities
    .map((activity) => `<tr><td>${new Date(activity.createdAt).toLocaleString()}</td><td>${activity.kind}</td><td>${escapeHtml(activity.title)}</td><td>${escapeHtml(activity.detail)}</td></tr>`)
    .join("");
  const summaries = report.summaries
    .map((summary) => `<article><time>${new Date(summary.createdAt).toLocaleString()}</time><p>${escapeHtml(summary.message)}</p></article>`)
    .join("");
  const workers = report.localWorkers
    .map((worker) => `<li><strong>${escapeHtml(worker.name)}</strong> <span class="${worker.status}">${worker.status}</span><small>${escapeHtml(worker.id)} · ${new Date(worker.lastSeenAt).toLocaleString()}</small></li>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Recursive Harness Status</title>
  <style>
    :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --text:#e6edf3; --muted:#8b949e; --line:#30363d; --accent:#7ee787; --warn:#f2cc60; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, ui-sans-serif, system-ui, Segoe UI, sans-serif; background:var(--bg); color:var(--text); }
    header, main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; border-bottom:1px solid var(--line); }
    h1 { margin:0; font-size:28px; }
    p { color:var(--muted); }
    .range { display:flex; gap:8px; }
    .range a { color:var(--text); border:1px solid var(--line); padding:8px 10px; border-radius:6px; text-decoration:none; }
    .range a.active { border-color:var(--accent); color:var(--accent); }
    .grid { display:grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap:12px; margin:22px 0; }
    .stat, section { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
    .stat span, small, time { display:block; color:var(--muted); font-size:12px; }
    .stat strong { display:block; margin-top:8px; font-size:24px; }
    .split { display:grid; grid-template-columns: 1fr 1fr; gap:16px; }
    table { width:100%; border-collapse:collapse; overflow:hidden; }
    th, td { border-bottom:1px solid var(--line); padding:10px; text-align:left; vertical-align:top; font-size:13px; }
    th { color:var(--muted); font-weight:600; }
    article { border-top:1px solid var(--line); padding:12px 0; }
    ul { padding:0; list-style:none; }
    li { border-top:1px solid var(--line); padding:12px 0; }
    .online { color:var(--accent); }
    .stale { color:var(--warn); }
    @media (max-width: 800px) { .grid, .split { grid-template-columns:1fr; } header { display:block; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Recursive Harness Status</h1>
      <p>Active image ${escapeHtml(report.activeRuntimeImage.id)} · generated ${new Date(report.generatedAt).toLocaleString()}</p>
    </div>
    <nav class="range">
      <a class="${report.stats.range === "24h" ? "active" : ""}" href="/?range=24h">24h</a>
      <a class="${report.stats.range === "7d" ? "active" : ""}" href="/?range=7d">7d</a>
    </nav>
  </header>
  <main>
    <div class="grid">
      ${stat("Activities", report.stats.totalActivities)}
      ${stat("Runs", report.stats.runs)}
      ${stat("Summaries", report.stats.summaries)}
      ${stat("Online workers", report.stats.localWorkersOnline)}
      ${stat("Promotions", report.stats.promotions)}
      ${stat("Rollbacks", report.stats.rollbacks)}
      ${stat("Anger signals", report.stats.angerEvents)}
      ${stat("Queued local tasks", report.stats.localTasksQueued)}
    </div>
    <div class="split">
      <section>
        <h2>5-hour summaries</h2>
        ${summaries || "<p>No summaries in this range yet.</p>"}
      </section>
      <section>
        <h2>Local workers</h2>
        <ul>${workers || "<li>No local worker has checked in yet.</li>"}</ul>
      </section>
    </div>
    <section style="margin-top:16px">
      <h2>Activity</h2>
      <table><thead><tr><th>Time</th><th>Kind</th><th>Title</th><th>Detail</th></tr></thead><tbody>${rows || "<tr><td colspan='4'>No activity yet.</td></tr>"}</tbody></table>
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char] ?? char);
}
