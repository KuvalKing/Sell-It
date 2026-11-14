// server.js — Sell It: ONE server that powers TWO panels (seller editor + buyer panel)
// No npm install needed. Requires Node.js 18+.
//   Run locally:   node server.js            (then open http://localhost:4567/editor)
//   Cloud host:    npm start, with PORT and DATA_DIR set by the host (see the deployment steps)
// Only ONE copy should run. Each copy keeps its own data in memory, so a second copy
// would show different data to sellers and buyers.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const VERSION = '2026-11-13-7';                      // must match APP_VERSION in editor.html
const START_PORT = Number(process.env.PORT) || 4567; // 3000 is the default for many other apps
const portFixed = !!process.env.PORT;                // true only if the user chose a port with PORT=...
let PORT = START_PORT;

// On a cloud host, DATA_DIR points at a persistent disk, so the data survives restarts
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'db.json');
const LIVE_WINDOW_MS = 2 * 60 * 1000; // a shop is "live" if its location was updated in the last 2 minutes
const MAX_BODY = 15 * 1024 * 1024;    // room for photos

const CATEGORIES = ['vegetables', 'furniture', 'electronics', 'second_hand', 'other'];
const UNITS = ['kg', 'litre', 'dozen', 'piece', 'each'];
// The password the seller types after the ₹10 Razorpay payment is checked. Change it here.
const UNLOCK_PASSWORD = '@123';

// ---------- storage (simple JSON file) ----------
let db = { vendors: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) { /* first run */ }
db.vendors = db.vendors || [];

// Upgrade records saved by the earlier version (pricePerKg -> price + unit)
for (const v of db.vendors) {
  v.items = v.items || [];
  v.category = CATEGORIES.includes(v.category) ? v.category : 'other';
  for (const i of v.items) {
    if (i.price === undefined) { i.price = i.pricePerKg; delete i.pricePerKg; }
    i.unit = UNITS.includes(i.unit) ? i.unit : 'kg';
    i.description = i.description || '';
  }
}

// Save to disk. Recreates the folder if it was removed while the server was running.
function saveDb() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

const sessions = new Map();  // login token -> seller id
const locations = new Map(); // seller id -> { lat, lng, updatedAt }  (live only, not saved to disk)
const streams = new Set();   // open live-update connections (buyer panels)

// ---------- helpers ----------
const hashPassword = (pw, salt) => crypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('hex');
const clean = (s, max = 60) => String(s ?? '').trim().slice(0, max);
const newToken = (sellerId) => {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, sellerId);
  return token;
};

// Open the seller page in the default browser, so no one has to type the address
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {}); // if it fails, the address is still printed in the terminal
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendPage(res, file) {
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Page not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return reject(new Error('Upload too large')); }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
      catch { reject(new Error('Invalid request data')); }
    });
    req.on('error', reject);
  });
}

// Tell every open buyer panel that something changed
function broadcast() {
  for (const res of streams) res.write('data: update\n\n');
}

function isOpenNow(s) {
  if (!s.isOpen) return false;
  const [h, m] = (s.closingTime || '23:59').split(':').map(Number);
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() < h * 60 + m;
}

// What the seller sees about their own shop
function ownView(s) {
  return {
    id: s.id, name: s.name, phone: s.phone,
    shopEn: s.shopEn, category: s.category,
    closingTime: s.closingTime, isOpen: s.isOpen, open: isOpenNow(s),
    accessPaid: s.accessPaid, items: s.items,
    location: locations.get(s.id) || null,
  };
}

// What buyers see (no phone number, no password, no Hindi names)
function publicView(s) {
  const loc = locations.get(s.id);
  return {
    id: s.id, shopEn: s.shopEn, category: s.category,
    closingTime: s.closingTime, open: isOpenNow(s),
    live: !!loc && Date.now() - loc.updatedAt < LIVE_WINDOW_MS,
    location: loc ? { lat: loc.lat, lng: loc.lng, updatedAt: loc.updatedAt } : null,
    items: s.items
      .filter(i => i.available)
      .map(({ id, nameEn, price, unit, description, photo }) => ({
        id, nameEn, price, unit, description, photo,
      })),
  };
}

// Validate an item sent by the seller panel
function toItem(b) {
  const nameEn = clean(b.nameEn);
  const price = Number(b.price);
  if (!nameEn || !(price > 0)) return null;
  return {
    nameEn,
    nameHi: clean(b.nameHi),
    price,
    unit: UNITS.includes(b.unit) ? b.unit : 'each',
    description: clean(b.description, 200),
    available: b.available === undefined ? true : !!b.available,
    photo: typeof b.photo === 'string' && b.photo.startsWith('data:image/') ? b.photo : '',
  };
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  // Let the pages call this API even when they are opened from a preview or file (file://)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const { pathname: p } = new URL(req.url, 'http://localhost');
  const m = req.method;

  try {
    // Pages
    if (m === 'GET' && (p === '/' || p === '/client')) return sendPage(res, 'client.html');
    if (m === 'GET' && p === '/editor') return sendPage(res, 'editor.html');
    if (m === 'GET' && p === '/reset') return sendPage(res, 'reset.html');

    // Live updates pushed to buyer panels
    if (m === 'GET' && p === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      streams.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); streams.delete(res); });
      return;
    }

    // Owner reset: clears every account while the server keeps running. Needs the owner password.
    if (m === 'POST' && p === '/api/owner/reset') {
      const b = await readJson(req);
      if (String(b.password || '').trim() !== UNLOCK_PASSWORD) {
        return send(res, 401, { error: 'Wrong owner password' });
      }
      const removed = db.vendors.length;
      db.vendors = [];
      sessions.clear();
      locations.clear();
      saveDb();
      broadcast();
      return send(res, 200, { ok: true, removed });
    }

    // Lets the seller page confirm it is talking to the current Sell It server
    if (m === 'GET' && p === '/api/health') {
      return send(res, 200, { app: 'Sell It', version: VERSION });
    }

    // Buyer panel: all shops that have paid the access fee
    if (m === 'GET' && p === '/api/shops') {
      return send(res, 200, db.vendors.filter(s => s.accessPaid).map(publicView));
    }

    // Seller: create account
    if (m === 'POST' && p === '/api/signup') {
      const b = await readJson(req);
      const name = clean(b.name);
      const phone = clean(b.phone, 10);
      const shopEn = clean(b.shopEn);
      const password = String(b.password || '');
      const category = CATEGORIES.includes(b.category) ? b.category : 'other';
      if (!name || !/^\d{10}$/.test(phone) || !shopEn || password.length < 4) {
        return send(res, 400, { error: 'Name, 10-digit phone, shop name and a 4+ character password are required.' });
      }
      const existing = db.vendors.find(x => x.phone === phone);
      if (existing) {
        // Already registered: if the password is right, just sign in
        if (hashPassword(password, existing.salt) === existing.passHash) {
          return send(res, 200, { token: newToken(existing.id), vendor: ownView(existing) });
        }
        return send(res, 409, { error: 'This phone number already has an account. Enter its password on the Login tab.' });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const seller = {
        id: crypto.randomUUID(),
        name, phone, salt,
        passHash: hashPassword(password, salt),
        shopEn, category,
        closingTime: '20:00',
        isOpen: true,
        accessPaid: false,
        items: [],
      };
      db.vendors.push(seller);
      try { saveDb(); } catch (err) { db.vendors.pop(); throw err; } // undo if it could not be saved
      return send(res, 201, { token: newToken(seller.id), vendor: ownView(seller) });
    }

    // Seller: login
    if (m === 'POST' && p === '/api/login') {
      const b = await readJson(req);
      const s = db.vendors.find(x => x.phone === clean(b.phone, 10));
      if (!s || hashPassword(String(b.password || ''), s.salt) !== s.passHash) {
        return send(res, 401, { error: 'Wrong phone number or password.' });
      }
      return send(res, 200, { token: newToken(s.id), vendor: ownView(s) });
    }

    // ----- everything below needs a logged-in seller -----
    if (p.startsWith('/api/')) {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      const s = db.vendors.find(x => x.id === sessions.get(token));
      if (!s) return send(res, 401, { error: 'Please log in.' });

      if (m === 'GET' && p === '/api/me') return send(res, 200, ownView(s));

      // Access fee: the seller pays ₹10 on Razorpay, then enters the password the owner gives them.
      // Only the right password opens the app. The check happens here on the server.
      if (m === 'POST' && p === '/api/unlock') {
        const b = await readJson(req);
        if (String(b.password || '').trim() !== UNLOCK_PASSWORD) {
          return send(res, 401, { error: 'Password incorrect' });
        }
        s.accessPaid = true;
        saveDb();
        broadcast();
        return send(res, 200, ownView(s));
      }

      if (!s.accessPaid) return send(res, 402, { error: 'Pay the ₹10 access fee and enter the password first.' });

      // Shop details, category, closing time, open/closed
      if (m === 'PUT' && p === '/api/shop') {
        const b = await readJson(req);
        if (b.shopEn !== undefined) s.shopEn = clean(b.shopEn) || s.shopEn;
        if (b.category !== undefined && CATEGORIES.includes(b.category)) s.category = b.category;
        if (b.closingTime !== undefined && /^\d{2}:\d{2}$/.test(b.closingTime)) s.closingTime = b.closingTime;
        if (b.isOpen !== undefined) s.isOpen = !!b.isOpen;
        saveDb();
        broadcast();
        return send(res, 200, ownView(s));
      }

      // Add an item
      if (m === 'POST' && p === '/api/items') {
        const item = toItem(await readJson(req));
        if (!item) return send(res, 400, { error: 'Item name and a price above 0 are required.' });
        s.items.push({ id: crypto.randomUUID(), ...item });
        saveDb();
        broadcast();
        return send(res, 201, ownView(s));
      }

      // Edit or delete one item
      const itemMatch = p.match(/^\/api\/items\/([\w-]+)$/);
      if (itemMatch) {
        const item = s.items.find(i => i.id === itemMatch[1]);
        if (!item) return send(res, 404, { error: 'Item not found.' });

        if (m === 'PUT') {
          const updated = toItem({ ...item, ...(await readJson(req)) });
          if (!updated) return send(res, 400, { error: 'Item name and a price above 0 are required.' });
          Object.assign(item, updated);
        } else if (m === 'DELETE') {
          s.items = s.items.filter(i => i !== item);
        }
        saveDb();
        broadcast();
        return send(res, 200, ownView(s));
      }

      // Live location from the seller panel (sent every few seconds while sharing)
      if (m === 'POST' && p === '/api/location') {
        const b = await readJson(req);
        if (b.stop) {
          locations.delete(s.id);
        } else {
          const lat = Number(b.lat);
          const lng = Number(b.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return send(res, 400, { error: 'Invalid location.' });
          }
          locations.set(s.id, { lat, lng, updatedAt: Date.now() });
        }
        broadcast();
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: 'Not found.' });
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    send(res, 500, { error: 'Something went wrong on the server. Please try again.' });
  }
});

// ---------- starting ----------
// Stop the server, but keep the window open until Enter is pressed, so the message can be read.
function finish(code) {
  if (process.stdin.isTTY) {
    console.log('\nPress Enter to close this window.');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(code));
  } else {
    process.exit(code);
  }
}

// Something already holds this port. Find out what it is before doing anything.
function checkWhoHoldsPort() {
  const req = http.get(`http://localhost:${PORT}/api/health`, (r) => {
    let body = '';
    r.on('data', (c) => { body += c; });
    r.on('end', () => {
      let info = null;
      try { info = JSON.parse(body); } catch (_) { /* not a Sell It server */ }
      if (info && info.app === 'Sell It' && info.version === VERSION) {
        console.log(`Sell It v${VERSION} is already running at http://localhost:${PORT}/editor`);
        console.log('Use that window. Do not start a second copy: each copy keeps its own data.');
        finish(0);
      }
      if (info && info.app === 'Sell It') {
        console.error(`An OLDER Sell It (version ${info.version || 'unknown'}) is running on port ${PORT}.`);
        console.error('Stop it first: open a new Command Prompt and run  taskkill /F /IM node.exe');
        console.error('Then run node server.js again.');
        finish(1);
      }
      moveToNextPort();
    });
  });
  req.setTimeout(3000, () => req.destroy());
  req.on('error', () => moveToNextPort());
}

// The port belongs to some other program. Use the next free one, unless the user fixed a port.
function moveToNextPort() {
  if (!portFixed && PORT < START_PORT + 20) {
    console.log(`Port ${PORT} is used by another program. Trying port ${PORT + 1}...`);
    PORT += 1;
    server.listen(PORT);
    return;
  }
  console.error(`Port ${PORT} is already used by another program, so Sell It did NOT start.`);
  console.error('Close that program, or start Sell It on another port, for example:');
  console.error('  Windows (cmd):         set PORT=4600 && node server.js');
  console.error('  Windows (PowerShell):  $env:PORT=4600; node server.js');
  finish(1);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') return checkWhoHoldsPort();
  throw err;
});

server.on('listening', () => {
  console.log(`Sell It v${VERSION} is running`);
  console.log(`  Seller panel: /editor    Buyer panel: /client    (port ${PORT})`);
  if (!process.env.NO_BROWSER && !process.env.PORT) openBrowser(`http://localhost:${PORT}/editor`);
});

server.listen(PORT);
