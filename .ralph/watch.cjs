// Low-fi live view of the daemon's state, straight from SQLite (no browser).
// Handy on the box when the web control plane (loopback :4280) isn't. Run with `watch`:
//   watch -n2 'node ~/repos/ralph-autopilot/.ralph/watch.cjs'
// node_modules and the db are resolved relative to this script, so cwd is free.
const path = require("node:path");
const D = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
const dbPath = process.argv[2] || path.join(__dirname, "ralph.sqlite");
const db = new D(dbPath, { readonly: true });
const now = Date.now();

const agents = db
  .prepare(
    `SELECT r.issue_number AS issue, ag.phase AS phase, ag.started_at AS started, ag.branch AS branch
       FROM agents ag JOIN runs r ON r.id = ag.run_id
      WHERE ag.ended_at IS NULL ORDER BY ag.started_at`,
  )
  .all();

console.log(new Date().toISOString().slice(11, 19) + "  in flight: " + agents.length);
for (const a of agents) {
  const mins = ((now - Date.parse(a.started)) / 60000).toFixed(1);
  console.log(`  #${a.issue}  ${(a.phase || "impl").padEnd(9)}  ${mins}m  ${a.branch}`);
}
if (agents.length === 0) console.log("  (no agents in flight)");

const out = db
  .prepare(
    `SELECT issue_number AS issue, event, ts FROM run_log
      WHERE event IN ('pr-opened','review-worklist','review-maxed','escalated','merged','agent-stuck')
      ORDER BY id DESC LIMIT 6`,
  )
  .all();
if (out.length) {
  console.log("recent:");
  for (const o of out.reverse()) console.log(`  ${o.ts.slice(11, 19)}  #${o.issue}  ${o.event}`);
}
