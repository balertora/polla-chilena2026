// ─────────────────────────────────────────────────────────────
// La Polla Chilena — Primera División predictor server
// Node + Express + SQLite + WebSocket
// Fixture/result sync: TheSportsDB (free). Live scores: ESPN public JSON.
// Full manual admin fallback for everything.
// ─────────────────────────────────────────────────────────────
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'polla.db');

// App version = short hash of the client.html being served. Injected into the
// page (replacing __APP_VERSION__) and sent in every state payload, so a tab
// running an older build can prompt the user to reload after a deploy.
let CLIENT_HTML = '', CLIENT_VERSION = '';
try {
  const raw = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');
  CLIENT_VERSION = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
  CLIENT_HTML = raw.replace("const APP_VERSION = '__APP_VERSION__'", `const APP_VERSION = '${CLIENT_VERSION}'`);
} catch (e) { console.error('client.html load failed:', e.message); }

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const db = new sqlite3.Database(DB_PATH);
const dbRun = (sql, p=[]) => new Promise((res, rej) => db.run(sql, p, function(e){ e ? rej(e) : res(this); }));
const dbGet = (sql, p=[]) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbAll = (sql, p=[]) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

// ── Schema ───────────────────────────────────────────────────
async function initDb(){
  await dbRun(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    recovery_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    baseline REAL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS fixtures (
    id TEXT PRIMARY KEY,
    round INTEGER,
    kickoff TEXT,
    home TEXT NOT NULL,
    away TEXT NOT NULL,
    home_score INTEGER,
    away_score INTEGER,
    status TEXT DEFAULT 'scheduled',   -- scheduled | finished | postponed
    result_source TEXT,                -- tsdb | espn | admin
    updated_at TEXT
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS predictions (
    user_id INTEGER NOT NULL,
    fixture_id TEXT NOT NULL,
    home_score INTEGER,
    away_score INTEGER,
    updated_at TEXT,
    PRIMARY KEY (user_id, fixture_id)
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT
  )`);
  // Defaults
  const defaults = {
    tsdb_league_id: '4478',      // TheSportsDB: Chilean Primera División
    tsdb_season: '2026',
    espn_slug: 'chi.1',          // ESPN league slug for live scores
    sync_enabled: 'true',
    app_name: 'La Polla Chilena',
    polla_start: '',             // ISO date — games before this are hidden & don't score
    pts_exact: '5',              // points for exact score
    pts_correct: '3',            // points for correct result (win/draw/loss)
    pts_miss: '1',               // points SUBTRACTED per un-predicted started game
    pts_fecha: '1',              // bonus to the top scorer(s) of a completed round
  };
  for(const [k,v] of Object.entries(defaults)){
    await dbRun(`INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)`, [k, v]);
  }
}

async function getSetting(key){ const r = await dbGet(`SELECT value FROM settings WHERE key=?`,[key]); return r?.value; }
async function setSetting(key, value){ await dbRun(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[key,String(value)]); }

// ── Auth helpers ─────────────────────────────────────────────
function hashPassword(password, salt){
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function newSalt(){ return crypto.randomBytes(16).toString('hex'); }
function newToken(){ return crypto.randomBytes(24).toString('hex'); }
// Readable recovery code: XXXX-XXXX-XXXX (no ambiguous chars)
function newRecoveryCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({length:4},()=>chars[crypto.randomInt(chars.length)]).join('');
  return `${seg()}-${seg()}-${seg()}`;
}
function hashRecovery(code){ return crypto.createHash('sha256').update(code.trim().toUpperCase()).digest('hex'); }

async function userFromToken(token){
  if(!token) return null;
  const s = await dbGet(`SELECT user_id FROM sessions WHERE token=?`,[token]);
  if(!s) return null;
  return dbGet(`SELECT * FROM users WHERE id=?`,[s.user_id]);
}
async function authMiddleware(req, res, next){
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  req.user = await userFromToken(token);
  next();
}
function requireAuth(req, res, next){ if(!req.user) return res.status(401).json({error:'No autenticado'}); next(); }
function requireAdmin(req, res, next){ if(!req.user?.is_admin) return res.status(403).json({error:'Solo admin'}); next(); }
app.use(authMiddleware);

// ── Scoring (server copy — used only for late-joiner baseline snapshot) ──
// Point values are configurable via settings (pts_exact/correct/miss/fecha).
function gamePoints(pred, fx, pts){
  if(fx.status!=='finished' || fx.home_score==null) return null;
  if(!pred || pred.home_score==null || pred.away_score==null) return null;
  if(pred.home_score===fx.home_score && pred.away_score===fx.away_score) return pts.exact;
  const o = (h,a)=> h>a?'H':a>h?'A':'D';
  return o(pred.home_score,pred.away_score)===o(fx.home_score,fx.away_score) ? pts.correct : 0;
}
async function scoringPoints(){
  const num = async (k, d) => { const v = parseFloat(await getSetting(k)); return isNaN(v)?d:v; };
  return {
    exact:   await num('pts_exact', 5),
    correct: await num('pts_correct', 3),
    miss:    await num('pts_miss', 1),
    fecha:   await num('pts_fecha', 1),
  };
}
async function computeTotals(){
  const users = await dbAll(`SELECT * FROM users`);
  const allFixtures = await dbAll(`SELECT * FROM fixtures`);
  const preds = await dbAll(`SELECT * FROM predictions`);
  const pts = await scoringPoints();
  const predMap = {}; // user_id -> fixture_id -> pred
  for(const p of preds){ (predMap[p.user_id]||(predMap[p.user_id]={}))[p.fixture_id]=p; }
  const now = Date.now();
  const started = fx => fx.kickoff && new Date(fx.kickoff).getTime() <= now;

  // Polla start date: fixtures kicking off before this are excluded entirely
  const startRaw = await getSetting('polla_start');
  const startTs = startRaw ? new Date(startRaw).getTime() : null;
  const fixtures = allFixtures.filter(fx =>
    !startTs || (fx.kickoff && new Date(fx.kickoff).getTime() >= startTs));

  // Per-user per-round scores
  const rounds = [...new Set(fixtures.filter(f=>f.round!=null).map(f=>f.round))];
  const roundComplete = {};
  for(const r of rounds){
    const fxs = fixtures.filter(f=>f.round===r);
    roundComplete[r] = fxs.length>0 && fxs.every(f=>f.status==='finished');
  }
  const totals = {};
  const roundScores = {}; // round -> user_id -> pts
  for(const u of users){
    let sum = u.baseline || 0;
    const uCreated = new Date(u.created_at).getTime();
    for(const fx of fixtures){
      const p = (predMap[u.id]||{})[fx.id];
      const gp = gamePoints(p, fx, pts);
      if(gp!=null) sum += gp;
      // Missed: game started, no prediction, kicked off after user joined
      const missed = started(fx) && (!p || p.home_score==null)
        && fx.kickoff && new Date(fx.kickoff).getTime() > uCreated
        && fx.status!=='postponed';
      if(missed) sum -= pts.miss;
      if(fx.round!=null && roundComplete[fx.round]){
        if(!roundScores[fx.round]) roundScores[fx.round]={};
        const cur = roundScores[fx.round][u.id]||0;
        roundScores[fx.round][u.id] = cur + (gp!=null?gp:0) - (missed?pts.miss:0);
      }
    }
    totals[u.id]=sum;
  }
  // Fecha winners: bonus to top scorer(s) of each complete round
  for(const r of Object.keys(roundScores)){
    const scores = roundScores[r];
    const max = Math.max(...Object.values(scores));
    for(const [uid, s] of Object.entries(scores)){
      if(s===max) totals[uid] = (totals[uid]||0) + pts.fecha;
    }
  }
  return totals;
}

// ── Auth routes ──────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try{
    const { name, password } = req.body || {};
    const clean = String(name||'').trim();
    if(!clean || clean.length<2 || clean.length>30) return res.status(400).json({error:'Nombre inválido (2–30 caracteres)'});
    if(!password || String(password).length<4) return res.status(400).json({error:'Contraseña muy corta (mínimo 4)'});
    const exists = await dbGet(`SELECT id FROM users WHERE lower(name)=lower(?)`,[clean]);
    if(exists) return res.status(409).json({error:'Ese nombre ya existe'});

    // Late-joiner baseline: min current total among existing users (0 if none)
    const totals = await computeTotals();
    const vals = Object.values(totals);
    const baseline = vals.length ? Math.min(...vals) : 0;

    const count = await dbGet(`SELECT COUNT(*) AS c FROM users`);
    const isAdmin = count.c === 0 ? 1 : 0;   // first user = admin

    const salt = newSalt();
    const recovery = newRecoveryCode();
    const r = await dbRun(
      `INSERT INTO users (name, pass_hash, salt, recovery_hash, is_admin, baseline, created_at) VALUES (?,?,?,?,?,?,?)`,
      [clean, hashPassword(password, salt), salt, hashRecovery(recovery), isAdmin, baseline, new Date().toISOString()]
    );
    const token = newToken();
    await dbRun(`INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)`,[token, r.lastID, new Date().toISOString()]);
    scheduleBroadcast();
    res.json({ token, name: clean, isAdmin: !!isAdmin, recoveryCode: recovery, baseline });
  }catch(e){ console.error(e); res.status(500).json({error:'Error del servidor'}); }
});

app.post('/api/login', async (req, res) => {
  try{
    const { name, password } = req.body || {};
    const u = await dbGet(`SELECT * FROM users WHERE lower(name)=lower(?)`,[String(name||'').trim()]);
    if(!u || hashPassword(password, u.salt) !== u.pass_hash) return res.status(401).json({error:'Nombre o contraseña incorrectos'});
    const token = newToken();
    await dbRun(`INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)`,[token, u.id, new Date().toISOString()]);
    res.json({ token, name: u.name, isAdmin: !!u.is_admin });
  }catch(e){ console.error(e); res.status(500).json({error:'Error del servidor'}); }
});

// Forgot password: name + recovery code -> set new password, rotate recovery code
app.post('/api/reset-password', async (req, res) => {
  try{
    const { name, recoveryCode, newPassword } = req.body || {};
    if(!newPassword || String(newPassword).length<4) return res.status(400).json({error:'Contraseña muy corta (mínimo 4)'});
    const u = await dbGet(`SELECT * FROM users WHERE lower(name)=lower(?)`,[String(name||'').trim()]);
    if(!u || hashRecovery(String(recoveryCode||'')) !== u.recovery_hash)
      return res.status(401).json({error:'Nombre o código de recuperación incorrectos'});
    const salt = newSalt();
    const recovery = newRecoveryCode();
    await dbRun(`UPDATE users SET pass_hash=?, salt=?, recovery_hash=? WHERE id=?`,
      [hashPassword(newPassword, salt), salt, hashRecovery(recovery), u.id]);
    await dbRun(`DELETE FROM sessions WHERE user_id=?`,[u.id]); // log out old sessions
    const token = newToken();
    await dbRun(`INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)`,[token, u.id, new Date().toISOString()]);
    res.json({ token, name: u.name, isAdmin: !!u.is_admin, recoveryCode: recovery });
  }catch(e){ console.error(e); res.status(500).json({error:'Error del servidor'}); }
});

app.post('/api/logout', requireAuth, async (req, res) => {
  const h = req.headers.authorization || '';
  await dbRun(`DELETE FROM sessions WHERE token=?`,[h.slice(7)]);
  res.json({ok:true});
});

// ── Predictions ──────────────────────────────────────────────
app.put('/api/predictions/:fixtureId', requireAuth, async (req, res) => {
  try{
    const fx = await dbGet(`SELECT * FROM fixtures WHERE id=?`,[req.params.fixtureId]);
    if(!fx) return res.status(404).json({error:'Partido no encontrado'});
    if(fx.kickoff && new Date(fx.kickoff).getTime() <= Date.now())
      return res.status(403).json({error:'El partido ya comenzó'});
    const { homeScore, awayScore } = req.body || {};
    const hs = homeScore==null||homeScore==='' ? null : parseInt(homeScore,10);
    const as_ = awayScore==null||awayScore==='' ? null : parseInt(awayScore,10);
    if((hs!=null && (isNaN(hs)||hs<0||hs>99)) || (as_!=null && (isNaN(as_)||as_<0||as_>99)))
      return res.status(400).json({error:'Marcador inválido'});
    await dbRun(
      `INSERT INTO predictions (user_id, fixture_id, home_score, away_score, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(user_id, fixture_id) DO UPDATE SET home_score=excluded.home_score, away_score=excluded.away_score, updated_at=excluded.updated_at`,
      [req.user.id, fx.id, hs, as_, new Date().toISOString()]
    );
    scheduleBroadcast();
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({error:'Error del servidor'}); }
});

// ── Admin: fixtures & results ────────────────────────────────
app.post('/api/admin/fixtures', requireAuth, requireAdmin, async (req, res) => {
  try{
    const { round, kickoff, home, away } = req.body || {};
    if(!home || !away || !kickoff) return res.status(400).json({error:'Faltan datos (equipos, fecha/hora)'});
    const id = 'man-' + crypto.randomBytes(6).toString('hex');
    await dbRun(`INSERT INTO fixtures (id, round, kickoff, home, away, status, updated_at) VALUES (?,?,?,?,?,'scheduled',?)`,
      [id, round!=null?parseInt(round,10):null, new Date(kickoff).toISOString(), String(home).trim(), String(away).trim(), new Date().toISOString()]);
    scheduleBroadcast();
    res.json({ok:true, id});
  }catch(e){ console.error(e); res.status(500).json({error:'Error del servidor'}); }
});

app.put('/api/admin/fixtures/:id', requireAuth, requireAdmin, async (req, res) => {
  try{
    const fx = await dbGet(`SELECT * FROM fixtures WHERE id=?`,[req.params.id]);
    if(!fx) return res.status(404).json({error:'Partido no encontrado'});
    const { round, kickoff, home, away, status } = req.body || {};
    await dbRun(`UPDATE fixtures SET round=?, kickoff=?, home=?, away=?, status=?, updated_at=? WHERE id=?`,
      [ round!==undefined ? (round!=null&&round!==''?parseInt(round,10):null) : fx.round,
        kickoff ? new Date(kickoff).toISOString() : fx.kickoff,
        home!=null ? String(home).trim() : fx.home,
        away!=null ? String(away).trim() : fx.away,
        status || fx.status,
        new Date().toISOString(), fx.id ]);
    scheduleBroadcast();
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({error:'Error del servidor'}); }
});

app.put('/api/admin/results/:id', requireAuth, requireAdmin, async (req, res) => {
  try{
    const fx = await dbGet(`SELECT * FROM fixtures WHERE id=?`,[req.params.id]);
    if(!fx) return res.status(404).json({error:'Partido no encontrado'});
    const { homeScore, awayScore } = req.body || {};
    if(homeScore==null || awayScore==null){
      // Clear result
      await dbRun(`UPDATE fixtures SET home_score=NULL, away_score=NULL, status='scheduled', result_source=NULL, updated_at=? WHERE id=?`,
        [new Date().toISOString(), fx.id]);
    } else {
      await dbRun(`UPDATE fixtures SET home_score=?, away_score=?, status='finished', result_source='admin', updated_at=? WHERE id=?`,
        [parseInt(homeScore,10), parseInt(awayScore,10), new Date().toISOString(), fx.id]);
    }
    scheduleBroadcast();
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({error:'Error del servidor'}); }
});

app.delete('/api/admin/fixtures/:id', requireAuth, requireAdmin, async (req, res) => {
  await dbRun(`DELETE FROM fixtures WHERE id=?`,[req.params.id]);
  await dbRun(`DELETE FROM predictions WHERE fixture_id=?`,[req.params.id]);
  scheduleBroadcast();
  res.json({ok:true});
});

// Import TheSportsDB CSV export. Columns (with header):
//   idEvent, strTimestamp (UTC), Round ("Round N"), Home Team, Home Score, Away Team, Away Score, ...
// strTimestamp is UTC. Empty scores = not played yet. Re-import updates existing
// (matched by idEvent) but never overwrites an admin-entered result.
app.post('/api/admin/import-csv', requireAuth, requireAdmin, async (req, res) => {
  try{
    const { text } = req.body || {};
    if(!text || !String(text).trim()) return res.status(400).json({error:'CSV vacío'});
    const { rows, errors } = parseCsvText(text);
    if(!rows.length) return res.status(400).json({error:'No se encontraron partidos en el CSV', errors});
    const added = await upsertFixtureRows(rows);
    scheduleBroadcast();
    res.json({ ok:true, added, errors });
  }catch(e){ console.error(e); res.status(500).json({error:e.message}); }
});

app.post('/api/admin/sync', requireAuth, requireAdmin, async (req, res) => {
  const result = await syncFixtures();
  scheduleBroadcast();
  res.json(result);
});

// Debug: show what the CSV URL returns + what's stored (admin only)
app.get('/api/admin/debug', requireAuth, requireAdmin, async (req, res) => {
  try{
    const leagueId = await getSetting('tsdb_league_id');
    const season = await getSetting('tsdb_season');
    const url = `https://www.thesportsdb.com/season/${leagueId}-chile-primera-division/${season}?csv=1&all=1`;
    let csvCount=0, csvErr=null, sample=null, rawSnippet=null, contentType=null, rawLen=0;
    try{
      const r = await fetch(url, { headers:{ 'User-Agent':'polla-chilena/1.0' } });
      contentType = r.headers.get('content-type');
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      const raw = await r.text();
      rawLen = raw.length;
      // Snippet around the CSV header so we can see the real format
      const m = raw.match(/idEvent\s*,\s*strTimestamp/i);
      rawSnippet = m ? raw.slice(m.index, m.index+400) : raw.slice(0, 400);
      const parsed = parseCsvText(raw);
      csvCount = parsed.rows.length;
      sample = parsed.rows.slice(0,3);
    }catch(e){ csvErr = e.message; }
    const stored = await dbAll(`SELECT id, round, kickoff, home, away, home_score, away_score, status, result_source FROM fixtures ORDER BY kickoff LIMIT 5`);
    const storedCount = await dbGet(`SELECT COUNT(*) AS c FROM fixtures`);
    res.json({ url, contentType, rawLen, csvCount, csvErr, rawSnippet, sample, storedCount: storedCount.c, storedSample: stored });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// Debug live scores: shows the ESPN feed and what matched (admin only)
app.get('/api/admin/debug-live', requireAuth, requireAdmin, async (req, res) => {
  try{
    const slug = await getSetting('espn_slug');
    const now = Date.now();
    const ymdOf = (ms) => { const d=new Date(ms); return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`; };
    const dates = [...new Set([ymdOf(now-24*3600*1000), ymdOf(now), ymdOf(now+24*3600*1000)])];
    let espnGames = [];
    for(const ymd of dates){
      try{
        const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${ymd}`);
        for(const ev of (data?.events||[])){
          const c = ev.competitions?.[0];
          const h = c?.competitors?.find(x=>x.homeAway==='home');
          const a = c?.competitors?.find(x=>x.homeAway==='away');
          espnGames.push({ home:h?.team?.displayName, away:a?.team?.displayName,
            hs:h?.score, as:a?.score, state:ev.status?.type?.state, clock:ev.status?.displayClock });
        }
      }catch(e){ espnGames.push({error:e.message, date:ymd}); }
    }
    const liveWindow = (await dbAll(`SELECT id, home, away, kickoff FROM fixtures WHERE status!='finished' AND kickoff IS NOT NULL`))
      .filter(f=>{ const k=new Date(f.kickoff).getTime(); return now>=k-10*60*1000 && now<=k+140*60*1000; });
    res.json({ slug, dates, espnGames, liveWindow, currentLive: _liveScores });
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.put('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  try{
    const allowed = ['tsdb_league_id','tsdb_season','espn_slug','sync_enabled','polla_start',
                     'pts_exact','pts_correct','pts_miss','pts_fecha'];
    const numeric = ['pts_exact','pts_correct','pts_miss','pts_fecha'];
    for(const [k,v] of Object.entries(req.body||{})){
      if(!allowed.includes(k)) continue;
      if(numeric.includes(k)){
        const n = parseFloat(v);
        if(isNaN(n) || n<0 || n>100) return res.status(400).json({error:`Valor inválido para ${k} (0–100)`});
        await setSetting(k, n);
      } else {
        await setSetting(k, v);
      }
    }
    scheduleBroadcast();
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({error:'Error del servidor'}); }
});

// Bulk import fixtures from pasted text: "round | YYYY-MM-DD HH:MM | Home | Away"
// Time is Chile local (UTC-3). Missing time -> 15:00.
app.post('/api/admin/bulk-fixtures', requireAuth, requireAdmin, async (req, res) => {
  try{
    const { text } = req.body || {};
    if(!text || !String(text).trim()) return res.status(400).json({error:'Texto vacío'});
    const lines = String(text).split('\n').map(l=>l.trim()).filter(Boolean);
    let added=0, errors=[];
    for(const [i,line] of lines.entries()){
      const parts = line.split('|').map(s=>s.trim());
      if(parts.length < 4){ errors.push(`Línea ${i+1}: faltan campos`); continue; }
      const [roundStr, dtStr, home, away] = parts;
      const round = roundStr!=='' ? parseInt(roundStr,10) : null;
      let iso = null;
      const m = dtStr.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
      if(m){ iso = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2,'0')}:${m[5]}:00-03:00`).toISOString(); }
      else {
        const md = dtStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if(md){ iso = new Date(`${dtStr}T15:00:00-03:00`).toISOString(); }
        else { errors.push(`Línea ${i+1}: fecha inválida "${dtStr}"`); continue; }
      }
      if(!home || !away){ errors.push(`Línea ${i+1}: faltan equipos`); continue; }
      const id = 'bulk-' + crypto.createHash('md5').update(`${round}|${home}|${away}`).digest('hex').slice(0,10);
      const existing = await dbGet(`SELECT id FROM fixtures WHERE id=?`,[id]);
      if(existing){
        await dbRun(`UPDATE fixtures SET round=?, kickoff=?, home=?, away=?, updated_at=? WHERE id=?`,
          [round, iso, home, away, new Date().toISOString(), id]);
      } else {
        await dbRun(`INSERT INTO fixtures (id, round, kickoff, home, away, status, updated_at) VALUES (?,?,?,?,?,'scheduled',?)`,
          [id, round, iso, home, away, new Date().toISOString()]);
      }
      added++;
    }
    scheduleBroadcast();
    res.json({ ok:true, added, errors });
  }catch(e){ console.error(e); res.status(500).json({error:e.message}); }
});

// Admin: reset a user's password -> returns fresh recovery code
app.post('/api/admin/reset-user/:name', requireAuth, requireAdmin, async (req, res) => {
  try{
    const u = await dbGet(`SELECT * FROM users WHERE lower(name)=lower(?)`,[req.params.name]);
    if(!u) return res.status(404).json({error:'Usuario no encontrado'});
    const recovery = newRecoveryCode();
    await dbRun(`UPDATE users SET recovery_hash=? WHERE id=?`,[hashRecovery(recovery), u.id]);
    res.json({ok:true, name:u.name, recoveryCode:recovery});
  }catch(e){ console.error(e); res.status(500).json({error:'Error del servidor'}); }
});

app.delete('/api/admin/users/:name', requireAuth, requireAdmin, async (req, res) => {
  const u = await dbGet(`SELECT * FROM users WHERE lower(name)=lower(?)`,[req.params.name]);
  if(!u) return res.status(404).json({error:'Usuario no encontrado'});
  if(u.id===req.user.id) return res.status(400).json({error:'No puedes eliminarte a ti mismo'});
  await dbRun(`DELETE FROM users WHERE id=?`,[u.id]);
  await dbRun(`DELETE FROM predictions WHERE user_id=?`,[u.id]);
  await dbRun(`DELETE FROM sessions WHERE user_id=?`,[u.id]);
  scheduleBroadcast();
  res.json({ok:true});
});

// Shared CSV parser (used by both URL sync and manual paste import)
function fetchJson(url){
  return fetch(url, { headers: { 'User-Agent':'polla-chilena/1.0' } }).then(r => {
    if(!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return r.json();
  });
}
function parseCsvText(raw){
  const parseCsvLine = (line) => {
    const out=[]; let cur=''; let inQ=false;
    for(let i=0;i<line.length;i++){
      const c=line[i];
      if(c==='"'){ if(inQ && line[i+1]==='"'){ cur+='"'; i++; } else inQ=!inQ; }
      else if(c===',' && !inQ){ out.push(cur); cur=''; }
      else cur+=c;
    }
    out.push(cur); return out;
  };
  let text = String(raw||'');
  // The public page returns HTML with the CSV embedded. Isolate the CSV block:
  // from the header ("idEvent,strTimestamp,...") to just before the footer text.
  const startMatch = text.match(/idEvent\s*,\s*strTimestamp/i);
  if(startMatch){
    text = text.slice(startMatch.index);
    // Cut off known footer / trailing HTML after the last data row
    const cut = text.search(/Copy ALL text|<\/|&copy;|\bTimezone:/i);
    if(cut>0) text = text.slice(0, cut);
  }
  // Decode common HTML entities and strip any stray tags
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
             .replace(/&quot;/g,'"').replace(/&#0?39;/g,"'").replace(/&amp;/g,'&')
             .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&ntilde;/gi,'ñ');
  // Normalize line endings (CRLF, CR, or literal "\r\n" sequences)
  text = text.replace(/\r\n?/g, '\n');
  const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);
  if(!lines.length) return { rows:[], errors:['CSV vacío'] };
  let headIdx = lines.findIndex(l => /idevent/i.test(l) && /strtimestamp/i.test(l));
  if(headIdx<0) headIdx = 0;
  const head = parseCsvLine(lines[headIdx]).map(h=>h.toLowerCase().trim());
  const hasHeader = head.includes('idevent') || head.includes('strtimestamp');
  const idx = { id:head.indexOf('idevent'), ts:head.indexOf('strtimestamp'), round:head.indexOf('round'),
    home:head.indexOf('home team'), hs:head.indexOf('home score'), away:head.indexOf('away team'), as:head.indexOf('away score') };
  const rows=[], errors=[];
  for(let i=(hasHeader?headIdx+1:0);i<lines.length;i++){
    const f = parseCsvLine(lines[i]);
    if(f.length<4) continue; // skip stray lines
    const get = (name, pos) => (hasHeader && idx[name]>=0 ? f[idx[name]] : f[pos]) ?? '';
    const idEvent=String(get('id',0)).trim(), tsRaw=String(get('ts',1)).trim(), roundRaw=String(get('round',2)).trim();
    const home=String(get('home',3)).trim(), hsRaw=String(get('hs',4)).trim(), away=String(get('away',5)).trim(), asRaw=String(get('as',6)).trim();
    if(!home || !away){ continue; } // silently skip non-game lines
    const rm = roundRaw.match(/(\d+)/); const round = rm?parseInt(rm[1],10):null;
    const tm = tsRaw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if(!tm){ errors.push(`"${home} v ${away}": fecha inválida "${tsRaw}"`); continue; }
    const iso = new Date(`${tm[1]}-${tm[2]}-${tm[3]}T${tm[4]}:${tm[5]}:00Z`).toISOString();
    const hasScore = hsRaw!=='' && asRaw!=='';
    const id = idEvent ? 'tsdb-'+idEvent : 'csv-'+crypto.createHash('md5').update(`${round}|${home}|${away}`).digest('hex').slice(0,10);
    rows.push({ id, round, iso, home, away, hs:hasScore?parseInt(hsRaw,10):null, as:hasScore?parseInt(asRaw,10):null, finished:hasScore });
  }
  return { rows, errors };
}

async function upsertFixtureRows(rows){
  let count=0;
  for(const r of rows){
    const existing = await dbGet(`SELECT * FROM fixtures WHERE id=?`,[r.id]);
    const keepAdmin = existing?.result_source==='admin';
    if(!existing){
      await dbRun(`INSERT INTO fixtures (id, round, kickoff, home, away, home_score, away_score, status, result_source, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [r.id, r.round, r.iso, r.home, r.away, r.finished?r.hs:null, r.finished?r.as:null,
         r.finished?'finished':'scheduled', r.finished?'csv':null, new Date().toISOString()]);
    } else {
      await dbRun(`UPDATE fixtures SET round=?, kickoff=?, home=?, away=?, home_score=?, away_score=?, status=?, result_source=?, updated_at=? WHERE id=?`,
        [ r.round, r.iso, r.home, r.away,
          keepAdmin ? existing.home_score : (r.finished?r.hs:existing.home_score),
          keepAdmin ? existing.away_score : (r.finished?r.as:existing.away_score),
          keepAdmin ? existing.status : (r.finished?'finished':(existing.status==='postponed'?'postponed':'scheduled')),
          keepAdmin ? 'admin' : (r.finished?'csv':existing.result_source),
          new Date().toISOString(), r.id ]);
    }
    count++;
  }
  return count;
}

// Sync fixtures from the public TheSportsDB CSV export URL (full season, no API limit)
async function syncFixtures(){
  try{
    const leagueId = await getSetting('tsdb_league_id');
    const season = await getSetting('tsdb_season');
    const url = `https://www.thesportsdb.com/season/${leagueId}-chile-primera-division/${season}?csv=1&all=1`;
    const r = await fetch(url, { headers: { 'User-Agent':'polla-chilena/1.0' } });
    if(!r.ok) return { ok:false, error:`HTTP ${r.status} al descargar el CSV`, count:0 };
    const text = await r.text();
    const { rows, errors } = parseCsvText(text);
    if(!rows.length) return { ok:false, error:'El CSV no trajo partidos — revisa league ID y temporada', count:0 };
    const count = await upsertFixtureRows(rows);
    await setSetting('last_sync', new Date().toISOString());
    return { ok:true, count, errors };
  }catch(e){
    console.error('syncFixtures:', e.message);
    return { ok:false, error:e.message, count:0 };
  }
}

// ── Live scores: ESPN public scoreboard ──────────────────────
let _liveScores = {}; // fixtureId -> { hs, as, clock, state }

// Normalize a team name: lowercase, strip accents, drop common football words + punctuation
function normName(s){
  return String(s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[.\-']/g,' ')
    .replace(/\b(club|deportes?|deportivo|cd|cf|sc|fc|de|del|la|el|los|las)\b/g,' ')
    .replace(/\s+/g,' ').trim();
}
// Distinctive keys for each of our 16 canonical teams (incl. ESPN's abbreviations).
// The two "Concepción" clubs must stay distinct, so their keys are the full two-word forms.
function teamKeys(name){
  const n = normName(name);
  const keys = new Set([n]);
  const map = {
    'audax italiano': ['audax'],
    'colo colo': ['colo colo','colocolo'],
    'coquimbo unido': ['coquimbo'],
    'serena': ['serena'],
    'limache': ['limache'],
    'everton vina mar': ['everton'],
    'o higgins': ['o higgins','ohiggins','higgins'],
    'union calera': ['union calera','calera'],
    'universidad catolica': ['universidad catolica','catolica'],
    'universidad chile': ['universidad chile','u chile'],
    'universidad concepcion': ['universidad concepcion','u concepcion'],
    'concepcion': ['concepcion'], // "Deportes Concepción" -> normed to just "concepcion"
  };
  if(map[n]) map[n].forEach(k=>keys.add(k));
  return [...keys];
}
// True if ESPN's name refers to our fixture team. Prefers exact key match; only
// falls back to substring for keys long enough to be unambiguous (avoids
// "concepcion" matching "universidad concepcion" and vice-versa).
function namesMatch(ourName, espnName){
  const en = normName(espnName);
  if(!en) return false;
  const keys = teamKeys(ourName);
  for(const k of keys){ if(en===k) return true; }
  for(const k of keys){
    if(k.length>=6 && (en.includes(k) || k.includes(en))){
      // Guard the Concepción ambiguity: never cross-match the two clubs
      const ourIsUniConce = keys.includes('universidad concepcion');
      const ourIsDepConce = normName(ourName)==='concepcion';
      if((ourIsUniConce || ourIsDepConce)){
        if(ourIsUniConce && !en.includes('universidad')) return false;
        if(ourIsDepConce && en.includes('universidad')) return false;
      }
      return true;
    }
  }
  return false;
}

async function pollLive(){
  try{
    if((await getSetting('sync_enabled'))!=='true') return;
    const now = Date.now();
    // Any fixture in its live window? (kickoff-10min .. kickoff+140min, not finished)
    const fixtures = await dbAll(`SELECT * FROM fixtures WHERE status != 'finished' AND kickoff IS NOT NULL`);
    const liveWindow = fixtures.filter(f => {
      const k = new Date(f.kickoff).getTime();
      return now >= k - 10*60*1000 && now <= k + 140*60*1000;
    });
    if(!liveWindow.length){ if(Object.keys(_liveScores).length){ _liveScores={}; scheduleBroadcast(); } return; }

    const slug = await getSetting('espn_slug');
    // Query a small date range so games near the UTC day boundary aren't missed
    // (e.g. a 21:00 Chile kickoff is 00:00 UTC the next day).
    const ymdOf = (ms) => { const d=new Date(ms); return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`; };
    const dates = [...new Set([ymdOf(now - 24*3600*1000), ymdOf(now), ymdOf(now + 24*3600*1000)])];
    let events = [];
    for(const ymd of dates){
      try{
        const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${ymd}`);
        if(data?.events?.length) events = events.concat(data.events);
      }catch(e){ /* ignore a single date failure */ }
    }
    const newLive = {};
    for(const fx of liveWindow){
      for(const ev of events){
        const comp = ev.competitions?.[0];
        if(!comp) continue;
        const homeC = comp.competitors?.find(c=>c.homeAway==='home');
        const awayC = comp.competitors?.find(c=>c.homeAway==='away');
        if(!homeC || !awayC) continue;
        if(namesMatch(fx.home, homeC.team?.displayName) && namesMatch(fx.away, awayC.team?.displayName)){
          const state = ev.status?.type?.state; // pre | in | post
          if(state==='in'){
            newLive[fx.id] = { hs: parseInt(homeC.score,10), as: parseInt(awayC.score,10), clock: ev.status?.displayClock||'', state };
          } else if(state==='post' && fx.result_source!=='admin'){
            // Final: write result
            await dbRun(`UPDATE fixtures SET home_score=?, away_score=?, status='finished', result_source='espn', updated_at=? WHERE id=?`,
              [parseInt(homeC.score,10), parseInt(awayC.score,10), new Date().toISOString(), fx.id]);
          }
          break;
        }
      }
    }
    const changed = JSON.stringify(newLive)!==JSON.stringify(_liveScores);
    _liveScores = newLive;
    if(changed) scheduleBroadcast();
  }catch(e){ console.error('pollLive:', e.message); }
}

// ── State snapshot + WebSocket broadcast ─────────────────────
async function buildSnapshot(forUser){
  const users = await dbAll(`SELECT id, name, is_admin, baseline, created_at FROM users ORDER BY created_at`);
  const startRaw = await getSetting('polla_start');
  const startTs = startRaw ? new Date(startRaw).getTime() : null;
  const allFixtures = await dbAll(`SELECT * FROM fixtures ORDER BY kickoff`);
  // Hide fixtures before the polla start date entirely (admin sees all in Admin tab via separate call)
  const fixtures = allFixtures.filter(fx =>
    !startTs || (fx.kickoff && new Date(fx.kickoff).getTime() >= startTs));
  const allPreds = await dbAll(`SELECT p.*, u.name AS user_name FROM predictions p JOIN users u ON u.id=p.user_id`);
  const now = Date.now();
  const startedSet = new Set(fixtures.filter(f=>f.kickoff && new Date(f.kickoff).getTime()<=now).map(f=>f.id));

  const myPreds = {};
  const otherPreds = {}; // name -> fixtureId -> {hs,as} — ONLY for started games (anti-copying)
  for(const p of allPreds){
    const entry = { hs: p.home_score, as: p.away_score };
    if(forUser && p.user_id===forUser.id) myPreds[p.fixture_id] = entry;
    else if(startedSet.has(p.fixture_id)){
      (otherPreds[p.user_name]||(otherPreds[p.user_name]={}))[p.fixture_id] = entry;
    }
  }
  const pts = await scoringPoints();
  const settings = {
    tsdb_league_id: await getSetting('tsdb_league_id'),
    tsdb_season: await getSetting('tsdb_season'),
    espn_slug: await getSetting('espn_slug'),
    sync_enabled: await getSetting('sync_enabled'),
    last_sync: await getSetting('last_sync'),
    polla_start: startRaw || '',
    pts_exact: pts.exact, pts_correct: pts.correct, pts_miss: pts.miss, pts_fecha: pts.fecha,
  };
  // Admins also get the full fixture list (incl. pre-start) for management
  const adminFixtures = forUser?.is_admin ? allFixtures : null;
  return {
    users: users.map(u=>({ name:u.name, isAdmin:!!u.is_admin, baseline:u.baseline, createdAt:u.created_at })),
    fixtures, adminFixtures, myPreds, otherPreds, live:_liveScores, settings, serverTime: new Date().toISOString(),
    serverVersion: CLIENT_VERSION,
  };
}

const wsClients = new Map(); // ws -> user
wss.on('connection', async (ws, req) => {
  try{
    const url = new URL(req.url, 'http://x');
    const user = await userFromToken(url.searchParams.get('token'));
    if(!user){ ws.close(4001, 'unauthorized'); return; }
    wsClients.set(ws, user);
    ws.send(JSON.stringify({ type:'state', data: await buildSnapshot(user) }));
    ws.on('close', ()=>wsClients.delete(ws));
  }catch(e){ ws.close(); }
});

let _broadcastTimer = null;
function scheduleBroadcast(){
  if(_broadcastTimer) return;
  _broadcastTimer = setTimeout(async () => {
    _broadcastTimer = null;
    for(const [ws, user] of wsClients){
      if(ws.readyState !== 1) continue;
      try{ ws.send(JSON.stringify({ type:'state', data: await buildSnapshot(user) })); }catch(e){}
    }
  }, 300);
}

// Kickoff-crossing rebroadcast: when a game's kickoff passes, others' picks unlock
setInterval(async () => {
  const fixtures = await dbAll(`SELECT id, kickoff FROM fixtures WHERE kickoff IS NOT NULL`);
  const now = Date.now();
  for(const f of fixtures){
    const k = new Date(f.kickoff).getTime();
    if(k <= now && k > now - 65*1000){ scheduleBroadcast(); break; }
  }
}, 60*1000);

// ── Static + boot ────────────────────────────────────────────
app.get('/', (req, res) => {
  // Never cache the HTML shell — always serve the latest build so users don't
  // get stuck on an old cached client after a deploy.
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  if(CLIENT_HTML) res.type('html').send(CLIENT_HTML);
  else res.sendFile(path.join(__dirname, 'client.html'));
});

initDb().then(async () => {
  server.listen(PORT, () => console.log(`⚽ La Polla Chilena on :${PORT}`));
  // Sync fixtures on boot + every 6h; poll live every 60s.
  // Wrapped so a network hiccup during boot sync never crashes the process.
  if((await getSetting('sync_enabled'))==='true') syncFixtures().catch(e=>console.error('boot sync:', e.message));
  setInterval(async () => {
    try{ if((await getSetting('sync_enabled'))==='true') await syncFixtures(); }
    catch(e){ console.error('interval sync:', e.message); }
  }, 6*60*60*1000);
  setInterval(pollLive, 60*1000);
}).catch(e => { console.error('initDb failed:', e.message); process.exit(1); });

// ── Graceful shutdown ────────────────────────────────────────
// Railway sends SIGTERM to the container on redeploy. Exiting cleanly (code 0)
// rather than being killed prevents false "Deploy Crashed" emails. We close
// WebSockets + HTTP server + DB fast, with a short failsafe.
let _shuttingDown = false;
function shutdown(signal){
  if(_shuttingDown) return;
  _shuttingDown = true;
  console.log(`Received ${signal}, shutting down cleanly…`);
  // Close all WebSocket connections and the WS server
  try{ for(const ws of wsClients.keys()){ try{ ws.terminate(); }catch(e){} } }catch(e){}
  try{ wss.close(); }catch(e){}
  const done = () => { try{ db.close(); }catch(e){} console.log('Bye.'); process.exit(0); };
  try{ server.close(done); }catch(e){ done(); }
  // Failsafe: exit quickly even if a socket refuses to close
  setTimeout(done, 1500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
// Last-resort guards so an unexpected error logs instead of crash-looping
process.on('unhandledRejection', (r) => console.error('unhandledRejection:', r));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e.message));
