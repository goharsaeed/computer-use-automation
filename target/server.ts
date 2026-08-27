import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3456);

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

type Member = {
  id: string;
  name: string;
  savingsBalance: string;
  checkingBalance: string;
};

function loadMembers(): Member[] {
  const raw = fs.readFileSync(path.join(__dirname, "data", "members.json"), "utf8");
  return JSON.parse(raw).members as Member[];
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/lookup", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "lookup.html"));
});

app.post("/lookup", (req, res) => {
  const memberId = String(req.body.memberId || "").trim();
  if (!memberId) {
    return res.status(400).send(renderError("Validation error", "Member ID is required."));
  }
  if (!/^\d+$/.test(memberId)) {
    return res
      .status(400)
      .send(renderError("Validation error", "Member ID must be numeric."));
  }

  const member = loadMembers().find((m) => m.id === memberId);
  if (!member) {
    return res
      .status(404)
      .send(
        renderError(
          "Record not found",
          `No member found for ID ${memberId}.`,
          "MEMBER_NOT_FOUND"
        )
      );
  }

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Member Detail — Vital Core</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header><h1>Vital Core Servicing</h1><p class="muted">Back-office proxy target</p></header>
  <main>
    <h2>Member Detail</h2>
    <div class="card" id="member-detail">
      <p><strong>Member ID:</strong> <span id="member-id">${member.id}</span></p>
      <p><strong>Name:</strong> <span id="member-name">${member.name}</span></p>
      <p><strong>Savings Balance:</strong> $<span id="savings-balance">${member.savingsBalance}</span></p>
      <p><strong>Checking Balance:</strong> $<span id="checking-balance">${member.checkingBalance}</span></p>
    </div>
    <p><a href="/lookup">Back to lookup</a></p>
  </main>
</body>
</html>`;
  res.send(html);
});

function renderError(title: string, message: string, code?: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title} — Vital Core</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header><h1>Vital Core Servicing</h1></header>
  <main>
    <div class="card error" id="error-panel" data-error-code="${code || "ERROR"}">
      <h2 id="error-title">${title}</h2>
      <p id="error-message">${message}</p>
    </div>
    <p><a href="/lookup">Try again</a></p>
  </main>
</body>
</html>`;
}

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Vital Core proxy target listening on http://127.0.0.1:${PORT}`);
});
