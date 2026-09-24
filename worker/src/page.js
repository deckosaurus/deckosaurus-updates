// worker/src/page.js — the GET /stats dashboard: one inline HTML string, no
// build step. Chart.js loads from cdnjs; the page fetches GET /v1/stats
// itself on load. Light/dark via prefers-color-scheme; works at phone width.

export function renderStatsPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deckosaurus telemetry</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f8; --panel: #ffffff; --text: #16181b; --muted: #686e77;
    --border: #e3e5e9; --accent: #3f6fd6; --err: #c0392b;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #121316; --panel: #1c1e22; --text: #ecedf0; --muted: #9aa0aa; --border: #2b2e33; --accent: #82a6ee; --err: #e0685a; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text); padding: 16px;
    font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  h1 { font-size: 1.2rem; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 0.85rem; margin: 0 0 20px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 20px; }
  .tile { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  .tile .n { font-size: 1.7rem; font-weight: 600; line-height: 1.1; }
  .tile .l { color: var(--muted); font-size: 0.8rem; margin-top: 2px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 14px; margin-bottom: 20px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; min-width: 0; }
  .panel h2 { font-size: 0.78rem; margin: 0 0 10px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .panel.wide { grid-column: 1 / -1; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; }
  footer { color: var(--muted); font-size: 0.78rem; margin-top: 4px; }
  footer a { color: var(--accent); }
  .err { color: var(--err); }
  canvas { max-width: 100%; }
</style>
</head>
<body>
<h1>Deckosaurus telemetry</h1>
<p class="sub" id="asof">loading…</p>

<div class="tiles">
  <div class="tile"><div class="n" id="t1d">–</div><div class="l">installs, 1d</div></div>
  <div class="tile"><div class="n" id="t7d">–</div><div class="l">installs, 7d</div></div>
  <div class="tile"><div class="n" id="t30d">–</div><div class="l">installs, 30d</div></div>
</div>

<div class="grid">
  <div class="panel wide">
    <h2>Launches per day</h2>
    <canvas id="perDay" height="90"></canvas>
  </div>
  <div class="panel">
    <h2>Version share</h2>
    <canvas id="versionChart"></canvas>
  </div>
  <div class="panel">
    <h2>Channel share</h2>
    <canvas id="channelChart"></canvas>
  </div>
  <div class="panel">
    <h2>macOS share</h2>
    <canvas id="macosChart"></canvas>
  </div>
  <div class="panel">
    <h2>Update funnel (installed)</h2>
    <table id="updatesTable"><thead><tr><th>to build</th><th>n</th></tr></thead><tbody></tbody></table>
  </div>
  <div class="panel">
    <h2>Update checks</h2>
    <table id="checksTable"><thead><tr><th>result</th><th>n</th></tr></thead><tbody></tbody></table>
  </div>
</div>

<footer>anonymous install ids; probe rows excluded; see <a href="https://updates.deckosaurus.com/privacy.html">/privacy.html</a> on updates.deckosaurus.com</footer>

<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script>
(function () {
  var PALETTE = ["#3f6fd6", "#43a682", "#d68b3f", "#b756c4", "#d64f5f", "#4fb0c4", "#8f8f3f"];
  var isDark = matchMedia("(prefers-color-scheme: dark)").matches;
  Chart.defaults.color = isDark ? "#ecedf0" : "#16181b";
  Chart.defaults.borderColor = isDark ? "#2b2e33" : "#e3e5e9";
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

  function fillTable(sel, rows, keyField) {
    var body = document.querySelector(sel + " tbody");
    body.innerHTML = "";
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      var td1 = document.createElement("td"); td1.textContent = r[keyField] || "(empty)";
      var td2 = document.createElement("td"); td2.textContent = r.n;
      tr.appendChild(td1); tr.appendChild(td2);
      body.appendChild(tr);
    });
  }

  function doughnut(id, rows, labelField) {
    new Chart(document.getElementById(id), {
      type: "doughnut",
      data: {
        labels: rows.map(function (r) { return r[labelField] || "(empty)"; }),
        datasets: [{ data: rows.map(function (r) { return r.n; }), backgroundColor: PALETTE, borderWidth: 0 }],
      },
      options: { plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } } } },
    });
  }

  function aggregate(rows, field) {
    var agg = {};
    rows.forEach(function (r) { agg[r[field]] = (agg[r[field]] || 0) + r.n; });
    return Object.keys(agg).map(function (k) {
      var out = { n: agg[k] };
      out[field] = k;
      return out;
    });
  }

  fetch("/v1/stats?t=" + Date.now(), { cache: "no-store" }).then(function (res) {
    if (!res.ok) throw new Error("stats fetch failed: " + res.status);
    return res.json();
  }).then(function (s) {
    document.getElementById("asof").textContent =
      "as of " + s.generatedAt + " · live: " + s.source.live + " · history: " + s.source.history;
    document.getElementById("t1d").textContent = s.installs["1d"];
    document.getElementById("t7d").textContent = s.installs["7d"];
    document.getElementById("t30d").textContent = s.installs["30d"];

    new Chart(document.getElementById("perDay"), {
      type: "line",
      data: {
        labels: s.launchesPerDay.map(function (r) { return r.day; }),
        datasets: [
          { label: "launches", data: s.launchesPerDay.map(function (r) { return r.launches; }), borderColor: PALETTE[0], backgroundColor: PALETTE[0], tension: 0.25 },
          { label: "installs", data: s.launchesPerDay.map(function (r) { return r.installs; }), borderColor: PALETTE[1], backgroundColor: PALETTE[1], tension: 0.25 },
        ],
      },
      options: { scales: { x: { grid: { display: false } }, y: { beginAtZero: true } } },
    });

    doughnut("versionChart", aggregate(s.launchesByVersionChannel, "version"), "version");
    doughnut("channelChart", aggregate(s.launchesByVersionChannel, "channel"), "channel");
    doughnut("macosChart", s.macosShare, "macos");
    fillTable("#updatesTable", s.updatesInstalled, "to");
    fillTable("#checksTable", s.updateChecks, "result");
  }).catch(function (err) {
    var el = document.getElementById("asof");
    el.textContent = "failed to load stats: " + err.message;
    el.className = "err";
  });
})();
</script>
</body>
</html>`;
}
