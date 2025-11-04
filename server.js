// server.js – Johanniter Österreich CIRS System (stabil & Render-ready)
import express from "express";
import path from "path";
import fs from "fs";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { fileURLToPath } from "url";
import ejsMate from "ejs-mate";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

// --- TEMPLATE ENGINE ---
app.engine("ejs", ejsMate);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// --- MIDDLEWARE ---
app.use(helmet());
app.use(morgan("dev"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- STATIC FILES ---
app.use(express.static(path.join(__dirname, "public")));

// --- DATABASE SETUP ---
// 👉 persistente Datei unter /data/cirs.db (bleibt über Deploys erhalten)
const DB_PATH = path.join(__dirname, "data", "cirs.db");

// Stelle sicher, dass der data-Ordner existiert
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let db;
(async () => {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT,
      title TEXT,
      location TEXT,
      asset TEXT,
      description TEXT,
      immediate TEXT,
      when_ts TEXT,
      contact_name TEXT,
      contact_email TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("📘 Datenbank bereit:", DB_PATH);
})();

// --- ROUTES ---

// Übersicht aller Meldungen
app.get("/", async (req, res) => {
  // warte kurz, falls DB-Init beim Start noch läuft
  if (!db) await new Promise(r => setTimeout(r, 300));

  const rows = await db.all("SELECT * FROM reports ORDER BY id DESC");
  res.render("list", { title: "CIRS Übersicht", rows });
});

// Formularseite
app.get("/new", (req, res) => {
  res.render("new", { title: "Neue CIRS-Meldung" });
});

// API-Endpoint für neue Meldung
app.post("/api/report", async (req, res) => {
  try {
    const {
      category,
      title,
      location,
      asset,
      description,
      immediate,
      when,
      contactName,
      contactEmail,
    } = req.body;

    await db.run(
      `INSERT INTO reports
       (category, title, location, asset, description, immediate, when_ts, contact_name, contact_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [category, title, location, asset, description, immediate, when, contactName, contactEmail]
    );

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Fehler beim Speichern:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Einzelmeldung ansehen (read-only)
app.get("/report/:id", async (req, res) => {
  const report = await db.get("SELECT * FROM reports WHERE id = ?", req.params.id);
  if (!report) return res.status(404).send("Meldung nicht gefunden.");

  res.render("new", { title: `Meldung #${report.id}`, p: report, readonly: true });
});

// --- ERROR HANDLING ---
app.use((req, res) => res.status(404).send("Seite nicht gefunden"));
app.use((err, req, res, next) => {
  console.error("❌ [ERROR]", err.stack || err);
  res.status(500).send("Interner Fehler – siehe Logs.");
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 CIRS läuft auf Port ${PORT}`);
});


