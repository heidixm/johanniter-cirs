// server.js – Johanniter Österreich CIRS System (Render-kompatibel, kein native Modul)
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

app.engine("ejs", ejsMate);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(helmet());
app.use(morgan("dev"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DB_PATH = process.env.DATABASE_PATH || (process.env.RENDER ? "/tmp/cirs.db" : path.join(__dirname, "data", "cirs.db"));

let db;
(async () => {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
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

// Übersicht
app.get("/", async (req, res) => {
  const rows = await db.all("SELECT * FROM reports ORDER BY id DESC");
  res.render("list", { title: "CIRS Übersicht", rows });
});

// Neues Formular
app.get("/new", (req, res) => {
  res.render("new", { title: "Neue CIRS-Meldung" });
});

// Meldung speichern
app.post("/api/report", async (req, res) => {
  try {
    const { category, title, location, asset, description, immediate, when, contactName, contactEmail } = req.body;
    await db.run(
      `INSERT INTO reports (category, title, location, asset, description, immediate, when_ts, contact_name, contact_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [category, title, location, asset, description, immediate, when, contactName, contactEmail]
    );
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Fehler beim Speichern:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Detailseite
app.get("/report/:id", async (req, res) => {
  const report = await db.get("SELECT * FROM reports WHERE id = ?", req.params.id);
  if (!report) return res.status(404).send("Meldung nicht gefunden.");
  res.render("new", { title: `Meldung #${report.id}`, p: report, readonly: true });
});

// Fehler
app.use((req, res) => res.status(404).send("Seite nicht gefunden"));
app.use((err, req, res, next) => {
  console.error("❌ [ERROR]", err);
  res.status(500).send("Interner Fehler");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 CIRS läuft auf Port ${PORT}`));

