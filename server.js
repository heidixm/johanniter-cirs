import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 3000,
  DATABASE_PATH = './cirs.db',
  SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS,
  MAIL_FROM, MAIL_TO
} = process.env;

// --- App-Basis ---
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '200kb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Rate Limit nur für API-Post
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
app.use('/api/', apiLimiter);

// --- DB ---
const db = new Database(DATABASE_PATH);
db.pragma('journal_mode = WAL');
db.prepare(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    category TEXT NOT NULL,
    when_ts TEXT NOT NULL,
    location TEXT NOT NULL,
    asset TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    immediate TEXT,
    contact_name TEXT,
    contact_email TEXT,
    user_agent TEXT,
    tz TEXT
  )
`).run();

// --- Mailer ---
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 587),
  secure: String(SMTP_SECURE).toLowerCase() === 'true',
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
});

// --- Utils ---
const LOGO_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f8/Logo_der_Johanniter_Unfall-Hilfe.svg/1200px-Logo_der_Johanniter_Unfall-Hilfe.svg.png';

function clean(str = '', max = 5000) {
  return String(str).replace(/\s+/g, ' ').trim().slice(0, max);
}
function required(v) { return v && String(v).trim().length > 0; }

// --- Routes ---
// Startseite: Liste
app.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT id, created_at, category, title, location, asset
    FROM reports
    ORDER BY id DESC
    LIMIT 500
  `).all();

  const ok = req.query.ok === '1';
  res.render('list', {
    logoUrl: LOGO_URL,
    rows,
    ok
  });
});

// Detailansicht (optional, praktisch)
app.get('/report/:id', (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return next();
  const row = db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id);
  if (!row) return res.status(404).send('Nicht gefunden');
  res.render('new', { // Reuse Template, schaltet Formular aus, zeigt Daten read-only
    logoUrl: LOGO_URL,
    preset: row,
    readonly: true,
    showDisclaimer: false
  });
});

// Formularseite für neue Meldung
app.get('/new', (req, res) => {
  res.render('new', {
    logoUrl: LOGO_URL,
    preset: null,
    readonly: false,
    showDisclaimer: true
  });
});

// API: Meldung speichern + Mail
app.post('/api/report', async (req, res) => {
  const {
    category, when, location, asset,
    title, description, immediate,
    contactName, contactEmail, userAgent, tz
  } = req.body || {};

  if (!required(category) || !required(when) || !required(location) || !required(title) || !required(description)) {
    return res.status(400).json({ error: 'Pflichtfelder fehlen.' });
  }

  const nowIso = new Date().toISOString();
  const data = {
    category: clean(category, 200),
    when_ts: clean(when, 64),
    location: clean(location, 300),
    asset: clean(asset, 300),
    title: clean(title, 300),
    description: clean(description, 5000),
    immediate: clean(immediate, 2000),
    contact_name: clean(contactName, 200),
    contact_email: clean(contactEmail, 300),
    user_agent: clean(userAgent || req.headers['user-agent'] || '', 500),
    tz: clean(tz || '', 64)
  };

  const insert = db.prepare(`
    INSERT INTO reports (created_at, category, when_ts, location, asset, title, description, immediate, contact_name, contact_email, user_agent, tz)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = insert.run(
    nowIso, data.category, data.when_ts, data.location, data.asset,
    data.title, data.description, data.immediate, data.contact_name,
    data.contact_email, data.user_agent, data.tz
  );

  // Mail bauen
  const subject = `[CIRS] ${data.category} – ${data.title}`;
  const lines = [
    `Kategorie: ${data.category}`,
    `Zeitpunkt: ${data.when_ts} (${data.tz || 'TZ unbekannt'})`,
    `Standort/Dienststelle: ${data.location}`,
    `Material/Fahrzeug: ${data.asset || '—'}`,
    ``,
    `BESCHREIBUNG:`,
    data.description,
    ``,
    `Sofortmaßnahmen:`,
    data.immediate || '—',
    ``,
    `Kontakt (optional): ${data.contact_name || '—'} ${data.contact_email ? `<${data.contact_email}>` : ''}`,
    ``,
    `Technik: ${data.user_agent}`,
    `Erfasst: ${nowIso}`,
    `Report-ID: ${info.lastInsertRowid}`
  ];
  const text = lines.join('\n');

  try {
    if (SMTP_HOST) {
      await transporter.sendMail({
        from: MAIL_FROM || SMTP_USER,
        to: MAIL_TO || 'fahrdienstleiter@example.org',
        subject,
        text
      });
    }
  } catch (err) {
    console.error('Mail-Fehler:', err);
    // Weiterhin 200 zurückgeben, Eintrag ist gespeichert; optional: Fehlerflag mitschicken
    return res.status(502).json({ error: 'Mailversand fehlgeschlagen, Meldung wurde aber gespeichert.' });
  }

  // Erfolgreich: bei klassischen Form-Posts redirecten; bei Fetch-POST JSON
  const accept = (req.headers['accept'] || '').toLowerCase();
  if (accept.includes('application/json')) {
    return res.json({ ok: true, id: info.lastInsertRowid });
  } else {
    return res.redirect('/?ok=1');
  }
});

// Fallback
app.use((req, res) => res.status(404).send('404'));

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log(`CIRS läuft auf Port ${port}`));;

