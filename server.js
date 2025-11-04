// server.js — Render-ready, ejs-mate Layouts, statische Assets, robustes Logging, Logo-Fallback

import fs from "fs";
import path from "path";
import url from "url";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import Database from "better-sqlite3";
import ejsMate from "ejs-mate";

dotenv.config();

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/* ---------------- Basic & Security ---------------- */
app.set("trust proxy", 1);
app.use(helmet());
app.use(morgan(process.env.LOG_FORMAT || "tiny"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

/* ---------------- Static files -------------------- */
// /public/... -> /...
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));
// Fallback: /logo.png auch dann liefern, wenn static mal nicht gegriffen hat
app.get("/logo.png", (req, res, next) => {
  const p = path.join(PUBLIC_DIR, "logo.png");
  if (fs.existsSync(p)) return res.sendFile(p);
  return res.status(404).send("Logo not found");
});

/* ---------------- Views (ejs-mate) --------------- */
app.engine("ejs", ejsMate);               // liefert layout(), partials(), block()
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
// Optional: Default-Layout erzwingen, auch wenn der View kein layout() aufruft
app.locals._layoutFile = "layout";

/* ---------------- Globals for views -------------- */
app.use((req, res, next) => {
  res.locals.logoUrl = "/logo.png";       // lokales Logo
  res.locals.title = "Johanniter Österreich – CIRS";
  next();
});

/* ---------------- SQLite ------------------------- */
const DEFAULT_LOCAL_DB = path.join(__dirname, "data", "cirs.db");
const RUNTIME_DB = process.env.DATABASE_PATH || (process.env.RENDER ? "/tmp/cirs.db" : DEFAULT_LOCAL_DB);
const REPO_DB = DEFAULT_LOCAL_DB;

fs.mkdirSync(path.dirname(RUNTIME_DB), { recursive: true });
try {
  if (!fs.existsSync(RUNTIME_DB) && fs.existsSync(REPO_DB)) {
    fs.copyFileSync(REPO_DB, RUNTIME_DB);
    console.log(`[DB] Kopiert: ${REPO_DB} → ${RUNTIME_DB}`);
  }
} catch (e) {
  console.warn("[DB] Kopieren fehlgeschlagen (non-fatal):", e.message);
}

const db = new Database(RUNTIME_DB);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT NOT NULL,
    asset TEXT,
    description TEXT NOT NULL,
    immediate TEXT,
    when_ts TEXT,
    tz TEXT,
    contact_name TEXT,
    contact_email TEXT
  );
`);

/* ---------------- Mail (optional) ---------------- */
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

/* ---------------- Routes ------------------------- */
// Healthcheck
app.get("/healthz", (req, res) => res.type("text").send("ok"));

// Übersicht
app.get("/", (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT id, created_at, category, title, location, COALESCE(asset,'') as asset
      FROM reports
      ORDER BY id DESC
    `).all();

    res.render("list", {
      title: "CIRS – Übersicht",
      rows,
      ok: req.query.ok === "1",
      // Hinweis: layout() im View ist ok, aber durch app.locals._layoutFile nicht nötig
    });
  } catch (err) {
    next(err);
  }
});

// Neues Formular
app.get("/new", (req, res, next) => {
  try {
    res.render("new", {
      readonly: false,
      showDisclaimer: true,
      title: "Neue Meldung"
    });
  } catch (err) {
    next(err);
  }
});

// Detailansicht
app.get("/report/:id", (req, res, next) => {
  try {
    const row = db.prepare(`SELECT * FROM reports WHERE id = ?`).get(Number(req.params.id));
    if (!row) return res.status(404).type("text").send("Not found");
    res.render("new", {
      readonly: true,
      preset: row,
      showDisclaimer: false,
      title: `Meldung #${row.id}`
    });
  } catch (err) {
    next(err);
  }
});

// Submit (Form)
app.post("/submit", (req, res, next) => {
  try {
    const required = ["category", "when", "location", "title", "description"];
    for (const f of required) {
      if (!req.body[f] || String(req.body[f]).trim() === "") {
        return res.status(400).type("text").send(`Feld fehlt: ${f}`);
      }
    }

    const nowIso = new Date().toISOString();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    const info = db.prepare(`
      INSERT INTO reports
        (created_at, category, title, location, asset, description, immediate, when_ts, tz, contact_name, contact_email)
      VALUES
        (@created_at, @category, @title, @location, @asset, @description, @immediate, @when_ts, @tz, @contact_name, @contact_email)
    `).run({
      created_at: nowIso,
      category: req.body.category,
      title: req.body.title,
      location: req.body.location,
      asset: req.body.asset || null,
      description: req.body.description,
      immediate: req.body.immediate || null,
      when_ts: req.body.when,
      tz,
      contact_name: req.body.contactName || null,
      contact_email: req.body.contactEmail || null,
    });

    if (mailer && process.env.MAIL_TO) {
      const url = `${req.protocol}://${req.get("host")}/report/${info.lastInsertRowid}`;
      mailer.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: process.env.MAIL_TO,
        subject: `[CIRS] ${req.body.category}: ${req.body.title}`,
        text: `Neue CIRS-Meldung #${info.lastInsertRowid}\n\n${url}\n`,
      }).catch(e => console.warn("[MAIL] Versand fehlgeschlagen (non-fatal):", e.message));
    }

    res.redirect("/?ok=1");
  } catch (err) {
    next(err);
  }
});

/* ---------------- Error Handling ----------------- */
// logge den Stack in die Render-Logs, aber gib nach außen nur eine kurze Meldung
app.use((err, req, res, next) => {
  console.error("[ERROR]", err.stack || err);
  res.status(500).type("text").send("Interner Fehler");
});

/* ---------------- Start Server ------------------- */
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`[DB] Pfad: ${RUNTIME_DB}`);
  console.log(`CIRS läuft auf ${HOST}:${PORT}`);
});
