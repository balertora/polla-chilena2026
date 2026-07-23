// ─────────────────────────────────────────────────────────────
// La Polla Chilena — Primera División predictor server
// Node + Express + SQLite + WebSocket
// Fixture/result sync: TheSportsDB (free). Live scores: ESPN public JSON.
// Full manual admin fallback for everything.
// ─────────────────────────────────────────────────────────────
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'polla.db');

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
// 5 exact, 3 correct result, 0 wrong. -1 per missed started game
// (only games kicking off after the user registered). +1 per fecha win.
function gamePoints(pred, fx){
  if(fx.status!=='finished' || fx.home_score==null) return null;
  if(!pred || pred.home_score==null || pred.away_score==null) return null;
  if(pred.home_score===fx.home_score && pred.away_score===fx.away_score) return 5;
  const o = (h,a)=> h>a?'H':a>h?'A':'D';
  return o(pred.home_score,pred.away_score)===o(fx.home_score,fx.away_score) ? 3 : 0;
}
async function computeTotals(){
  const users = await dbAll(`SELECT * FROM users`);
  const fixtures = await dbAll(`SELECT * FROM fixtures`);
  const preds = await dbAll(`SELECT * FROM predictions`);
  const predMap = {}; // user_id -> fixture_id -> pred
  for(const p of preds){ (predMap[p.user_id]||(predMap[p.user_id]={}))[p.fixture_id]=p; }
  const now = Date.now();
  const started = fx => fx.kickoff && new Date(fx.kickoff).getTime() <= now;

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
      const pts = gamePoints(p, fx);
      if(pts!=null) sum += pts;
      // Missed: game started, no prediction, game kicked off after user joined
      const missed = started(fx) && (!p || p.home_score==null)
        && fx.kickoff && new Date(fx.kickoff).getTime() > uCreated
        && fx.status!=='postponed';
      if(missed) sum -= 1;
      if(fx.round!=null && roundComplete[fx.round]){
        if(!roundScores[fx.round]) roundScores[fx.round]={};
        const cur = roundScores[fx.round][u.id]||0;
        roundScores[fx.round][u.id] = cur + (pts!=null?pts:0) - (missed?1:0);
      }
    }
    totals[u.id]=sum;
  }
  // Fecha winners: +1 to top scorer(s) of each complete round
  for(const r of Object.keys(roundScores)){
    const scores = roundScores[r];
    const max = Math.max(...Object.values(scores));
    for(const [uid, s] of Object.entries(scores)){
      if(s===max) totals[uid] = (totals[uid]||0) + 1;
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

// Admin: reset a user's password -> returns fresh recovery code for them
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

app.put('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  const allowed = ['tsdb_league_id','tsdb_season','espn_slug','sync_enabled'];
  for(const [k,v] of Object.entries(req.body||{})){
    if(allowed.includes(k)) await setSetting(k, v);
  }
  scheduleBroadcast();
  res.json({ok:true});
});

app.post('/api/admin/sync', requireAuth, requireAdmin, async (req, res) => {
  const result = await syncFixtures();
  scheduleBroadcast();
  res.json(result);
});

// Debug: show what the API returns + what's stored (admin only)
app.get('/api/admin/debug', requireAuth, requireAdmin, async (req, res) => {
  try{
    const leagueId = await getSetting('tsdb_league_id');
    const season = await getSetting('tsdb_season');
    const url = `https://www.thesportsdb.com/api/v1/json/123/eventsseason.php?id=${leagueId}&s=${encodeURIComponent(season)}`;
    let apiSample = null, apiErr = null, apiCount = 0;
    try{
      const data = await fetchJson(url);
      const events = data?.events || [];
      apiCount = events.length;
      apiSample = events.slice(0,3).map(ev => ({
        idEvent: ev.idEvent, round: ev.intRound, timestamp: ev.strTimestamp,
        date: ev.dateEvent, time: ev.strTime, home: ev.strHomeTeam, away: ev.strAwayTeam,
        hs: ev.intHomeScore, as: ev.intAwayScore,
      }));
    }catch(e){ apiErr = e.message; }
    const stored = await dbAll(`SELECT id, round, kickoff, home, away, home_score, away_score, status FROM fixtures ORDER BY kickoff LIMIT 5`);
    const storedCount = await dbGet(`SELECT COUNT(*) AS c FROM fixtures`);
    res.json({ url, apiCount, apiErr, apiSample, storedCount: storedCount.c, storedSample: stored });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── Fixture sync: TheSportsDB (free key '123') ───────────────
async function fetchJson(url){
  const r = await fetch(url, { headers: { 'User-Agent': 'polla-chilena/1.0' } });
  if(!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

async function syncFixtures(){
  try{
    const leagueId = await getSetting('tsdb_league_id');
    const season = await getSetting('tsdb_season');
    const url = `https://www.thesportsdb.com/api/v1/json/123/eventsseason.php?id=${leagueId}&s=${encodeURIComponent(season)}`;
    const data = await fetchJson(url);
    const events = data?.events || [];
    if(!events.length) return { ok:false, error:'La API no devolvió partidos — revisa league ID y temporada', count:0 };
    let upserts = 0;
    for(const ev of events){
      const id = 'tsdb-' + ev.idEvent;
      const kickoff = ev.strTimestamp ? new Date(ev.strTimestamp + (ev.strTimestamp.endsWith('Z')?'':'Z')).toISOString()
                    : ev.dateEvent ? new Date(ev.dateEvent + 'T' + (ev.strTime||'17:00:00') + 'Z').toISOString() : null;
      const round = ev.intRound!=null && ev.intRound!=='' ? parseInt(ev.intRound,10) : null;
      const finished = ev.intHomeScore!=null && ev.intHomeScore!=='' && ev.intAwayScore!=null && ev.intAwayScore!=='';
      const existing = await dbGet(`SELECT * FROM fixtures WHERE id=?`,[id]);
      if(!existing){
        await dbRun(`INSERT INTO fixtures (id, round, kickoff, home, away, home_score, away_score, status, result_source, updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [id, round, kickoff, ev.strHomeTeam, ev.strAwayTeam,
           finished?parseInt(ev.intHomeScore,10):null, finished?parseInt(ev.intAwayScore,10):null,
           finished?'finished':'scheduled', finished?'tsdb':null, new Date().toISOString()]);
        upserts++;
      } else {
        // Update schedule info always; update result only if admin hasn't set it manually
        const keepAdminResult = existing.result_source==='admin';
        await dbRun(`UPDATE fixtures SET round=?, kickoff=?, home=?, away=?,
                       home_score=?, away_score=?, status=?, result_source=?, updated_at=?
                     WHERE id=?`,
          [ round, kickoff, ev.strHomeTeam, ev.strAwayTeam,
            keepAdminResult ? existing.home_score : (finished?parseInt(ev.intHomeScore,10):existing.home_score),
            keepAdminResult ? existing.away_score : (finished?parseInt(ev.intAwayScore,10):existing.away_score),
            keepAdminResult ? existing.status : (finished?'finished':existing.status==='finished'?'finished':'scheduled'),
            keepAdminResult ? 'admin' : (finished?'tsdb':existing.result_source),
            new Date().toISOString(), id ]);
        upserts++;
      }
    }
    await setSetting('last_sync', new Date().toISOString());
    return { ok:true, count:upserts };
  }catch(e){
    console.error('syncFixtures:', e.message);
    return { ok:false, error:e.message, count:0 };
  }
}

// ── Live scores: ESPN public scoreboard ──────────────────────
let _liveScores = {}; // fixtureId -> { hs, as, clock, state }

function normName(s){
  return String(s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')   // strip accents
    .replace(/\b(club|deportes|deportivo|cd|cf|sc|fc|de|la|el|los|las|universidad|u\.)\b/g,'')
    .replace(/[^a-z0-9]/g,'');
}
function namesMatch(a, b){
  const na=normName(a), nb=normName(b);
  if(!na||!nb) return false;
  return na===nb || na.includes(nb) || nb.includes(na);
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
    const d = new Date();
    const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
    const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${ymd}`);
    const events = data?.events || [];
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
  const fixtures = await dbAll(`SELECT * FROM fixtures ORDER BY kickoff`);
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
  const settings = {
    tsdb_league_id: await getSetting('tsdb_league_id'),
    tsdb_season: await getSetting('tsdb_season'),
    espn_slug: await getSetting('espn_slug'),
    sync_enabled: await getSetting('sync_enabled'),
    last_sync: await getSetting('last_sync'),
  };
  return {
    users: users.map(u=>({ name:u.name, isAdmin:!!u.is_admin, baseline:u.baseline, createdAt:u.created_at })),
    fixtures, myPreds, otherPreds, live:_liveScores, settings, serverTime: new Date().toISOString(),
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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'client.html')));

initDb().then(async () => {
  server.listen(PORT, () => console.log(`⚽ La Polla Chilena on :${PORT}`));
  // Sync fixtures on boot + every 6h; poll live every 60s
  if((await getSetting('sync_enabled'))==='true') syncFixtures();
  setInterval(async () => { if((await getSetting('sync_enabled'))==='true') syncFixtures(); }, 6*60*60*1000);
  setInterval(pollLive, 60*1000);
});
