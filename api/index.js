const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');

const app = express();
const IS_PROD = process.env.VERCEL === '1';

// ===== БД (Turso / libSQL) =====
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

const all = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const get = async (sql, args = []) => (await db.execute({ sql, args })).rows[0];
const run = (sql, args = []) => db.execute({ sql, args });

const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const DEFAULT_SERVICES = [
  ['phone', 'Ремонт телефона', 500, 'Замена экрана, батареи, разъёмов, ПО', '📱'],
  ['laptop', 'Ремонт ноутбука', 1000, 'Чистка, замена матрицы, клавиатуры, ремонт БП', '💻'],
  ['tablet', 'Ремонт планшета', 700, 'Замена тачскрина, дисплея, АКБ', '📲'],
  ['pc', 'Ремонт ПК', 800, 'Диагностика, апгрейд, сборка, чистка', '🖥️'],
  ['tv', 'Ремонт телевизора', 1200, 'Замена матрицы, подсветки, плат', '📺'],
  ['appliance', 'Бытовая техника', 900, 'Стиралки, холодильники, микроволновки', '🔧']
];

const DEFAULT_SETTINGS = {
  site_name: 'STARWebSite',
  phone: '+7 (999) 123-45-67',
  address: 'г. Москва, ул. Примерная, д. 1',
  email: 'info@starwebsite.ru',
  about: 'Профессиональный ремонт техники любой сложности. Гарантия на все работы.',
  completed_orders: '1247'
};

let initPromise = null;
function ensureDb() {
  if (!initPromise) {
    initPromise = (async () => {
      await db.execute({ sql: `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user'
      )` });
      
      await db.execute({ sql: `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)` });
      
      await db.execute({ sql: `CREATE TABLE IF NOT EXISTS services (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        price REAL DEFAULT 0,
        description TEXT,
        icon TEXT
      )` });
      
      await db.execute({ sql: `CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        service TEXT,
        name TEXT,
        phone TEXT,
        comment TEXT,
        status TEXT DEFAULT 'new',
        created_at TEXT DEFAULT (datetime('now'))
      )` });

      const cnt = Number((await get('SELECT COUNT(*) AS c FROM services')).c);
      if (cnt === 0) {
        for (const s of DEFAULT_SERVICES) {
          await run('INSERT INTO services (slug,title,price,description,icon) VALUES (?,?,?,?,?)', s);
        }
      }

      for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        await run('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)', [k, v]);
      }
    })().catch(e => { initPromise = null; throw e; });
  }
  return initPromise;
}

let cache = { at: 0, data: null };
async function getSettings() {
  if (cache.data && Date.now() - cache.at < 10000) return cache.data;
  const rows = await all('SELECT key,value FROM settings');
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  cache = { at: Date.now(), data: obj };
  return obj;
}
const bustSettings = () => { cache = { at: 0, data: null }; };

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));
app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieSession({
  name: 'star_sess',
  keys: [process.env.SESSION_SECRET || 'dev_secret_change_me'],
  maxAge: 30 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: IS_PROD
}));

app.use(h(async (req, res, next) => {
  await ensureDb();
  res.locals.user = req.session.user || null;
  res.locals.settings = await getSettings();
  next();
}));

const requireAdmin = h(async (req, res, next) => {
  const s = req.session.user;
  if (!s) return res.redirect('/login');
  const u = await get('SELECT id,username,role FROM users WHERE id=?', [s.id]);
  if (!u || u.role !== 'admin') return res.status(403).send('Доступ запрещён');
  req.session.user = { id: Number(u.id), username: u.username, role: u.role };
  next();
});

app.get('/', h(async (req, res) => {
  const services = await all('SELECT * FROM services ORDER BY id');
  res.render('index', { services });
}));

app.get('/service/:slug', h(async (req, res) => {
  const service = await get('SELECT * FROM services WHERE slug=?', [req.params.slug]);
  if (!service) return res.status(404).send('Услуга не найдена');
  res.render('service', { service });
}));

app.get('/login', (req, res) => res.render('login', { error: null }));
app.get('/register', (req, res) => res.render('register', { error: null }));

app.post('/register', h(async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  if (username.length < 3 || password.length < 4) {
    return res.render('register', { error: 'Логин от 3 символов, пароль от 4' });
  }
  if (await get('SELECT id FROM users WHERE username=?', [username])) {
    return res.render('register', { error: 'Такой логин уже занят' });
  }
  const hash = await bcrypt.hash(password, 10);
  const isFirst = Number((await get('SELECT COUNT(*) AS c FROM users')).c) === 0;
  const role = isFirst ? 'admin' : 'user';
  const r = await run('INSERT INTO users (username,password,role) VALUES (?,?,?)', [username, hash, role]);
  req.session.user = { id: Number(r.lastInsertRowid), username, role };
  res.redirect('/');
}));

app.post('/login', h(async (req, res) => {
  const username = (req.body.username || '').trim();
  const u = await get('SELECT * FROM users WHERE username=?', [username]);
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password))) {
    return res.render('login', { error: 'Неверный логин или пароль' });
  }
  req.session.user = { id: Number(u.id), username: u.username, role: u.role };
  res.redirect('/');
}));

app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

app.post('/order', h(async (req, res) => {
  const { service, name, phone, comment } = req.body;
  if (!name || !phone) return res.status(400).json({ ok: false, error: 'Имя и телефон обязательны' });
  await run('INSERT INTO orders (user_id,service,name,phone,comment) VALUES (?,?,?,?,?)',
    [req.session.user?.id || null, service, name, phone, comment || '']);
  res.json({ ok: true });
}));

app.get('/admin', requireAdmin, h(async (req, res) => {
  const services = await all('SELECT * FROM services ORDER BY id');
  const orders = await all('SELECT * FROM orders ORDER BY id DESC LIMIT 50');
  res.render('admin', { services, orders });
}));

app.post('/admin/settings', requireAdmin, h(async (req, res) => {
  const allowed = Object.keys(DEFAULT_SETTINGS);
  const entries = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (entries.length) {
    for (const [k, v] of entries) {
      await run(`INSERT INTO settings (key,value) VALUES (?,?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [k, String(v)]);
    }
  }
  bustSettings();
  res.redirect('/admin');
}));

app.post('/admin/service', requireAdmin, h(async (req, res) => {
  const { id, slug, title, price, description, icon } = req.body;
  const args = [slug, title, parseFloat(price) || 0, description || '', icon || '🔧'];
  if (id) {
    await run('UPDATE services SET slug=?,title=?,price=?,description=?,icon=? WHERE id=?', [...args, id]);
  } else {
    await run('INSERT INTO services (slug,title,price,description,icon) VALUES (?,?,?,?,?)', args);
  }
  res.redirect('/admin');
}));

app.post('/admin/service/delete/:id', requireAdmin, h(async (req, res) => {
  await run('DELETE FROM services WHERE id=?', [req.params.id]);
  res.redirect('/admin');
}));

app.get('/admin/users', requireAdmin, h(async (req, res) => {
  const users = await all('SELECT id,username,role FROM users ORDER BY id');
  res.render('admin-users', { users });
}));

app.post('/admin/user/update', requireAdmin, h(async (req, res) => {
  const { id, username, password, role } = req.body;
  const safeRole = role === 'admin' ? 'admin' : 'user';

  if (safeRole !== 'admin') {
    const admins = Number((await get("SELECT COUNT(*) AS c FROM users WHERE role='admin'")).c);
    const target = await get('SELECT role FROM users WHERE id=?', [id]);
    if (target?.role === 'admin' && admins <= 1) {
      return res.status(400).send('Нельзя убрать последнего админа');
    }
  }

  if (password && password.length >= 4) {
    const hash = await bcrypt.hash(password, 10);
    await run('UPDATE users SET username=?,password=?,role=? WHERE id=?', [username, hash, safeRole, id]);
  } else {
    await run('UPDATE users SET username=?,role=? WHERE id=?', [username, safeRole, id]);
  }

  if (req.session.user.id === Number(id)) {
    req.session.user = { id: Number(id), username, role: safeRole };
  }
  res.redirect('/admin/users');
}));

app.post('/admin/order/status/:id/:status', requireAdmin, h(async (req, res) => {
  const st = ['new', 'progress', 'done'].includes(req.params.status) ? req.params.status : 'new';
  await run('UPDATE orders SET status=? WHERE id=?', [st, req.params.id]);
  res.redirect('/admin');
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Ошибка сервера: ' + err.message);
});

module.exports = app;

if (!IS_PROD) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
}
