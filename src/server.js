const express = require("express");
const os = require("os");

const app = express();
const PORT = process.env.PORT || 3968;
// ECS injects this env var into every container automatically (Fargate + EC2 launch types).
// Reading it lets us prove which task/container answered a request when the app is scaled out.
const METADATA_URI = process.env.ECS_CONTAINER_METADATA_URI_V4;

const startedAt = new Date();
let requestCount = 0;

app.use((req, res, next) => {
  requestCount += 1;
  next();
});

app.get("/", (req, res) => {
  const uptimeSeconds = Math.round(process.uptime());
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ECS Learning App</title>
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0b1220;
    color: #e8edf3;
    font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  }
  main {
    max-width: 480px;
    padding: 32px;
    text-align: center;
  }
  h1 { margin: 0 0 8px; font-size: 1.8rem; }
  p { color: #8fa1b8; margin: 4px 0; }
  code {
    background: #1a2740;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.85em;
  }
  dl {
    text-align: left;
    margin-top: 24px;
    font-family: ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, Consolas, monospace;
    font-size: 0.85rem;
    border-top: 1px solid #2a3a54;
    padding-top: 16px;
  }
  dl div { display: flex; justify-content: space-between; padding: 4px 0; }
  dt { color: #8fa1b8; }
</style>
</head>
<body>
<main>
  <h1>🚢 Hello from ECS</h1>
  <p>This page is being served by a container. Try <code>/health</code> and <code>/api/info</code> too.</p>
  <dl>
    <div><dt>hostname</dt><dd>${os.hostname()}</dd></div>
    <div><dt>uptime</dt><dd>${uptimeSeconds}s</dd></div>
    <div><dt>started</dt><dd>${startedAt.toISOString()}</dd></div>
    <div><dt>requests served</dt><dd>${requestCount}</dd></div>
  </dl>
</main>
</body>
</html>`);
});

// ECS/ALB health checks hit this endpoint. Keep it cheap and dependency-free
// so a slow downstream service never makes ECS think the task is unhealthy.
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/api/info", async (req, res) => {
  const info = {
    hostname: os.hostname(),
    platform: os.platform(),
    nodeVersion: process.version,
    env: process.env.NODE_ENV || "development",
    memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };

  if (METADATA_URI) {
    try {
      const metadataRes = await fetch(`${METADATA_URI}/task`);
      info.ecsTaskMetadata = await metadataRes.json();
    } catch (err) {
      info.ecsTaskMetadataError = err.message;
    }
  } else {
    info.ecsTaskMetadata = "Not running inside ECS (no metadata endpoint found)";
  }

  res.json(info);
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// ECS sends SIGTERM before stopping a task (during deploys/scale-in). Shutting
// down cleanly avoids dropped connections and lets the ALB deregister the task first.
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  server.close(() => process.exit(0));
});
