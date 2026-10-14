require('dotenv').config();
const express = require('express'), mysql = require('mysql2/promise'), mongoose = require('mongoose'),
  multer = require('multer'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'),
  fs = require('fs'), path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
const upload = multer({ dest: path.join(__dirname, 'uploads'), limits: { fileSize: 8 * 1024 * 1024 } });
const SECRET = process.env.JWT_SECRET || 'dev-secret';
let db;

// MongoDB: flexible data (AI results differ per document type, chat logs)
const Doc = mongoose.model('Doc', new mongoose.Schema(
  { studentId: Number, docType: String, file: String, mime: String, ai: Object }, { timestamps: true }));
const Chat = mongoose.model('Chat', new mongoose.Schema(
  { studentId: Number, q: String, a: String }, { timestamps: true }));

const auth = role => (req, res, next) => {
  try {
    req.user = jwt.verify((req.headers.authorization || '').slice(7), SECRET);
    if (role && req.user.role !== role) return res.sendStatus(403);
    next();
  } catch { res.sendStatus(401); }
};
const wrap = f => (req, res) => f(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });

async function ask(content, system, max = 700) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.AI_MODEL || 'claude-sonnet-5-5', max_tokens: max, system, messages: [{ role: 'user', content }] })
  });
  const d = await r.json();
  return d.content?.[0]?.text || null;
}

async function verifyDoc(file, docType, student) {
  const buf = fs.readFileSync(file.path);
  if (buf.length < 15000) return { status: 'rejected', issues: ['File is very small. The scan may be cropped or blurry. Re-upload a clearer copy.'], mode: 'basic' };
  const block = file.mimetype === 'application/pdf' ? 'document' : file.mimetype.startsWith('image/') ? 'image' : null;
  if (!block) return { status: 'rejected', issues: ['Upload a PDF, JPG or PNG.'], mode: 'basic' };
  const out = await ask(
    [{ type: block, source: { type: 'base64', media_type: file.mimetype, data: buf.toString('base64') } },
     { type: 'text', text: `Expected document type: ${docType}. Student name on application: ${student.name}.` }],
    'You verify admission documents. Reply ONLY with JSON: {"typeMatches":bool,"readable":bool,"nameMatches":bool,"extracted":{"name":"","dob":"","idNumber":""},"issues":["short fix instructions"]}');
  if (!out) return { status: 'accepted', issues: [], mode: 'demo (no API key, basic checks only)' };
  try {
    const j = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
    const ok = j.typeMatches && j.readable && j.nameMatches !== false;
    j.issues = j.issues || [];
    if (!j.typeMatches) j.issues.push(`This does not look like a ${docType}.`);
    return { status: ok ? 'accepted' : 'rejected', issues: j.issues, extracted: j.extracted, mode: 'ai' };
  } catch { return { status: 'review', issues: ['Needs manual review.'], mode: 'ai' }; }
}

const KB = `Renewal: needs previous year fee receipt, ID card, and no-dues form. Fee deadline: 15th of each month cycle, late fee Rs 50/day. Bonafide certificate ready in 2 working days. Office hours 10am-4pm Mon-Sat. Original documents are verified in person only after online upload is accepted.`;

// ---- Auth
app.post('/api/auth/register', wrap(async (req, res) => {
  const { roll_no, name, email, password } = req.body;
  const [r] = await db.query('INSERT INTO students(roll_no,name,email,password_hash) VALUES(?,?,?,?)',
    [roll_no, name, email, await bcrypt.hash(password, 8)]);
  const due = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
  await db.query('INSERT INTO fees(student_id,label,amount,due_date) VALUES(?,?,?,?),(?,?,?,?),(?,?,?,?)',
    [r.insertId, 'Tuition fee', 45000, due(15), r.insertId, 'Hostel fee', 20000, due(20), r.insertId, 'Exam fee', 2500, due(30)]);
  res.json({ ok: true });
}));
app.post('/api/auth/login', wrap(async (req, res) => {
  const [[u]] = await db.query('SELECT * FROM students WHERE email=?', [req.body.email]);
  if (!u || !await bcrypt.compare(req.body.password, u.password_hash)) return res.status(401).json({ error: 'Wrong email or password' });
  res.json({ token: jwt.sign({ id: u.id, role: u.role, name: u.name }, SECRET, { expiresIn: '1d' }), name: u.name, role: u.role });
}));

// ---- Documents (student in MySQL, document record in Mongo)
app.post('/api/documents', auth(), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a file' });
  const ai = await verifyDoc(req.file, req.body.docType, req.user);
  const d = await Doc.create({ studentId: req.user.id, docType: req.body.docType, file: req.file.filename, mime: req.file.mimetype, ai });
  res.json(d);
}));
app.get('/api/documents', auth(), wrap(async (req, res) => res.json(await Doc.find({ studentId: req.user.id }).sort('-createdAt'))));

// ---- Fees
app.get('/api/fees', auth(), wrap(async (req, res) => {
  const [f] = await db.query('SELECT f.*,p.receipt_no FROM fees f LEFT JOIN payments p ON p.fee_id=f.id WHERE f.student_id=?', [req.user.id]);
  res.json(f);
}));
app.post('/api/fees/:id/pay', auth(), wrap(async (req, res) => { // demo payment: replace with Razorpay test-mode checkout
  const [[f]] = await db.query('SELECT * FROM fees WHERE id=? AND student_id=? AND status="due"', [req.params.id, req.user.id]);
  if (!f) return res.status(404).json({ error: 'Fee not found or already paid' });
  const receipt = 'RCPT-' + Date.now().toString().slice(-8);
  await db.query('UPDATE fees SET status="paid" WHERE id=?', [f.id]);
  await db.query('INSERT INTO payments(fee_id,student_id,amount,receipt_no) VALUES(?,?,?,?)', [f.id, req.user.id, f.amount, receipt]);
  res.json({ receipt });
}));

// ---- Virtual queue
app.post('/api/tokens', auth(), wrap(async (req, res) => {
  const { purpose, slot_date, slot_time } = req.body;
  const [[{ c }]] = await db.query('SELECT COUNT(*) c FROM tokens WHERE slot_date=? AND slot_time=? AND status<>"cancelled"', [slot_date, slot_time]);
  if (c >= 5) return res.status(409).json({ error: 'This slot is full. Pick another time.' });
  const [[{ n }]] = await db.query('SELECT COUNT(*)+1 n FROM tokens WHERE slot_date=?', [slot_date]);
  await db.query('INSERT INTO tokens(student_id,purpose,slot_date,slot_time,token_no) VALUES(?,?,?,?,?)', [req.user.id, purpose, slot_date, slot_time, n]);
  res.json({ token_no: n });
}));
app.get('/api/tokens/mine', auth(), wrap(async (req, res) => {
  const [t] = await db.query(`SELECT t.*,
    (SELECT COUNT(*) FROM tokens x WHERE x.slot_date=t.slot_date AND x.status='waiting' AND x.id<t.id) ahead,
    (SELECT token_no FROM tokens x WHERE x.slot_date=t.slot_date AND x.status='serving' LIMIT 1) now_serving
    FROM tokens t WHERE student_id=? ORDER BY id DESC LIMIT 5`, [req.user.id]);
  res.json(t.map(x => ({ ...x, wait_min: x.ahead * 5 })));
}));

// ---- Renewals / certificates
app.post('/api/requests', auth(), wrap(async (req, res) => {
  await db.query('INSERT INTO requests(student_id,type) VALUES(?,?)', [req.user.id, req.body.type]); res.json({ ok: true });
}));
app.get('/api/requests', auth(), wrap(async (req, res) => {
  const [r] = await db.query('SELECT * FROM requests WHERE student_id=? ORDER BY id DESC', [req.user.id]); res.json(r);
}));

// ---- AI assistant
app.post('/api/chat', auth(), wrap(async (req, res) => {
  const a = await ask(req.body.q, `You are the admission office assistant. Answer briefly using ONLY this info; if unknown, say to contact the office.\n${KB}`, 300)
    || 'Demo mode: add ANTHROPIC_API_KEY to get live answers. Meanwhile: ' + KB.split('. ')[0] + '.';
  await Chat.create({ studentId: req.user.id, q: req.body.q, a });
  res.json({ a });
}));

// ---- Admin
app.get('/api/admin/stats', auth('admin'), wrap(async (req, res) => {
  const [[s]] = await db.query(`SELECT
    (SELECT COUNT(*) FROM requests WHERE status<>'ready') pending,
    (SELECT COUNT(*) FROM tokens WHERE slot_date=CURDATE() AND status='waiting') waiting,
    (SELECT IFNULL(ROUND(AVG(TIMESTAMPDIFF(MINUTE,created_at,updated_at))),0) FROM requests WHERE status='ready') avg_min`);
  const rej = await Doc.aggregate([{ $match: { 'ai.status': 'rejected' } }, { $group: { _id: '$docType', n: { $sum: 1 } } }, { $sort: { n: -1 } }]);
  res.json({ ...s, rejections: rej });
}));
app.get('/api/admin/queue', auth('admin'), wrap(async (req, res) => {
  const [q] = await db.query('SELECT t.*,s.name FROM tokens t JOIN students s ON s.id=t.student_id WHERE slot_date=CURDATE() AND status IN("waiting","serving") ORDER BY t.id');
  res.json(q);
}));
app.post('/api/admin/queue/next', auth('admin'), wrap(async (req, res) => {
  await db.query('UPDATE tokens SET status="done" WHERE slot_date=CURDATE() AND status="serving"');
  await db.query('UPDATE tokens SET status="serving" WHERE slot_date=CURDATE() AND status="waiting" ORDER BY id LIMIT 1');
  res.json({ ok: true });
}));
app.get('/api/admin/requests', auth('admin'), wrap(async (req, res) => {
  const [r] = await db.query('SELECT r.*,s.name FROM requests r JOIN students s ON s.id=r.student_id WHERE status<>"ready" ORDER BY r.id');
  res.json(r);
}));
app.post('/api/admin/requests/:id/advance', auth('admin'), wrap(async (req, res) => {
  await db.query(`UPDATE requests SET status=ELT(FIELD(status,'submitted','verified','approved','ready')+1,'submitted','verified','approved','ready','ready') WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
}));

// ---- Start: connect MySQL and MongoDB, create admin if missing, then listen
(async () => {
    db = await mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    port: +(process.env.MYSQL_PORT || 3306),
    ssl: process.env.MYSQL_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DB || 'admission_desk',
    dateStrings: true
  });
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/admission_desk');
  const [[a]] = await db.query('SELECT id FROM students WHERE role="admin" LIMIT 1');
  if (!a) await db.query('INSERT INTO students(roll_no,name,email,password_hash,role) VALUES("ADMIN","Admission Office","admin@college.edu",?,"admin")', [await bcrypt.hash('muskan26', 8)]);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Running on http://localhost:' + port));
})().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });