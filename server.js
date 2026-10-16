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
  if (process.env.GEMINI_API_KEY) {
    const parts = typeof content === 'string' ? [{ text: content }] : content.map(b =>
      b.type === 'text' ? { text: b.text } : { inline_data: { mime_type: b.source.media_type, data: b.source.data } });
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }] })
    });
    const d = await r.json();
    if (!r.ok) console.error('Gemini error:', JSON.stringify(d.error || d));
    return d.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || null;
  }
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
  const block = file.mimetype === 'application/pdf' ? 'document' : file.mimetype.startsWith('image/') ? 'image' : null;
  if (!block) return { status: 'rejected', issues: ['Upload a PDF, JPG or PNG.'], mode: 'basic' };
  if (buf.length < 15000) return { status: 'rejected', issues: ['The file is too small or low quality. Upload a clear, full-page scan or photo.'], mode: 'basic' };

  // Fail closed: if no AI key is set, nothing is auto-accepted
  if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY)
    return { status: 'review', issues: ['Automatic checking is not set up, so this was sent for manual review.'], mode: 'no-ai' };

  const system = 'You are a strict admission document verifier for an Indian college. Reply ONLY with JSON: ' +
    '{"typeMatches":bool,"readable":bool,"nameOnDocument":"","nameMatches":bool,"isScreenshotOrScreenPhoto":bool,"appearsEdited":bool,' +
    '"confidence":"high|medium|low","extracted":{"name":"","rollNumber":"","board":"","year":""},"issues":["short fix instructions"]}. ' +
    'Be strict. typeMatches is true only if the image clearly is the expected document type. A random photo, selfie, blank paper, ' +
    'screenshot, or a different document must give typeMatches false. nameMatches is true only if the name on the document is the same ' +
    'person as the registered name (ignore case, word order and initials). Never guess values you cannot read.';

  let out = null;
  try {
    out = await ask(
      [{ type: block, source: { type: 'base64', media_type: file.mimetype, data: buf.toString('base64') } },
       { type: 'text', text: `Expected document type: ${docType}. Registered student name: ${student.name}.` }],
      system, 900);
  } catch (e) { console.error('AI check error:', e.message); }
  if (!out) return { status: 'review', issues: ['The automatic check was unavailable, so this was sent for manual review.'], mode: 'ai-unavailable' };

  try {
    const j = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
    const problems = [];
    if (!j.typeMatches) problems.push(`This does not look like a ${docType}.`);
    if (!j.readable) problems.push('The document is blurry or cut off. Upload a clear, full-page copy.');
    if (!j.nameOnDocument || j.nameMatches !== true) problems.push(`The name on the document does not match your registered name (${student.name}).`);
    if (j.isScreenshotOrScreenPhoto) problems.push('Screenshots and photos of a screen are not accepted. Upload a scan or photo of the paper document.');
    if (j.appearsEdited) problems.push('The document appears to be edited or altered.');
    if (j.confidence === 'low') problems.push('The check was not confident. Upload a clearer copy.');
    const issues = problems.length ? [...new Set([...problems, ...(Array.isArray(j.issues) ? j.issues : [])])] : [];
    return { status: problems.length ? 'rejected' : 'accepted', issues, extracted: j.extracted, mode: 'ai' };
  } catch { return { status: 'review', issues: ['Needs manual review.'], mode: 'ai' }; }
}

// ---- Answers (edit these to match your college). The AI uses them as its only source of truth,
// and they also work as a built-in fallback when the AI is not available.
const FAQ = [
  { k: ['admission', 'admit', 'join', 'apply', 'enroll'], a: 'For new admission bring your 12th marksheet, ID proof (Aadhaar or PAN), 4 passport-size photos, income certificate (only if you want a fee concession) and your transfer certificate. Upload them in the Documents tab first, then book a token only for original document verification.' },
  { k: ['renewal', 'renew'], a: 'For renewal you need your previous year fee receipt, your college ID card and the no-dues form. Submit a Renewal request in the Requests tab and follow its progress there.' },
  { k: ['bonafide', 'certificate', 'nodues', 'no-dues', 'dues'], a: 'Bonafide and no-dues certificates are requested from the Requests tab. A bonafide certificate is ready in about 2 working days. Bring your college ID card and latest fee receipt when you collect it.' },
  { k: ['fee', 'fees', 'pay', 'payment', 'receipt', 'deadline', 'late', 'due'], a: 'Open the Fees tab to see every fee, its due date and your total. Click Pay now to pay online and get a receipt number. Fees are due by the 15th of each cycle and a late fee of Rs 50 per day applies after that.' },
  { k: ['token', 'queue', 'visit', 'slot', 'wait', 'book', 'counter'], a: 'Book a visit in the Queue tab. Choose a purpose, date and time and you get a token. The live board shows who is being served and how many people are ahead of you, and each person ahead adds about 5 minutes of waiting.' },
  { k: ['upload', 'reject', 'rejected', 'blurry', 'verify', 'verification', 'original'], a: 'Upload clear, full-page photos or scans in the Documents tab. If a document is rejected you will see the reason, such as a blurry image or a name that does not match, and you can upload a corrected copy. Original documents are verified in person only after the online upload is accepted.' },
  { k: ['hours', 'time', 'timing', 'open', 'contact', 'phone', 'email', 'where', 'location', 'office'], a: 'The admission office is open 10 am to 4 pm, Monday to Saturday, in the Admission Office, Main Building. Email: admission@yourcollege.edu.' }
];
const KB = FAQ.map(f => f.a).join('\n');
const FALLBACK = 'I can help with admission documents, renewals, certificates, fees, tokens and office hours. Ask about one of these, or contact the admission office.';
function faqAnswer(q) {
  const words = String(q).toLowerCase().match(/[a-z-]+/g) || [];
  let best = null, bestScore = 0;
  for (const f of FAQ) {
    const score = f.k.filter(k => words.some(w => w.startsWith(k))).length;
    if (score > bestScore) { best = f; bestScore = score; }
  }
  return best ? best.a : FALLBACK;
}

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
  const [[f]] = await db.query('SELECT * FROM fees WHERE id=? AND student_id=? AND status=\'due\'', [req.params.id, req.user.id]);
  if (!f) return res.status(404).json({ error: 'Fee not found or already paid' });
  const receipt = 'RCPT-' + Date.now().toString().slice(-8);
  await db.query('UPDATE fees SET status=\'paid\' WHERE id=?', [f.id]);
  await db.query('INSERT INTO payments(fee_id,student_id,amount,receipt_no) VALUES(?,?,?,?)', [f.id, req.user.id, f.amount, receipt]);
  res.json({ receipt });
}));

// ---- Virtual queue
app.post('/api/tokens', auth(), wrap(async (req, res) => {
  const { purpose, slot_date, slot_time } = req.body;
  const [[{ c }]] = await db.query('SELECT COUNT(*) c FROM tokens WHERE slot_date=? AND slot_time=? AND status<>\'cancelled\'', [slot_date, slot_time]);
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
  let a = null;
  try {
    a = await ask(req.body.q, `You are the admission office assistant. Answer briefly and clearly using ONLY the information below. If the answer is not there, say to contact the admission office.\n${KB}`, 400);
  } catch (e) { console.error('Chat AI error:', e.message); }
  if (!a) a = faqAnswer(req.body.q);   // built-in answers when the AI is unavailable
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
  const [q] = await db.query('SELECT t.*,s.name FROM tokens t JOIN students s ON s.id=t.student_id WHERE slot_date=CURDATE() AND status IN(\'waiting\',\'serving\') ORDER BY t.id');
  res.json(q);
}));
app.post('/api/admin/queue/next', auth('admin'), wrap(async (req, res) => {
  await db.query('UPDATE tokens SET status=\'done\' WHERE slot_date=CURDATE() AND status=\'serving\'');
  await db.query('UPDATE tokens SET status=\'serving\' WHERE slot_date=CURDATE() AND status=\'waiting\' ORDER BY id LIMIT 1');
  res.json({ ok: true });
}));
app.get('/api/admin/requests', auth('admin'), wrap(async (req, res) => {
  const [r] = await db.query('SELECT r.*,s.name FROM requests r JOIN students s ON s.id=r.student_id WHERE status<>\'ready\' ORDER BY r.id');
  res.json(r);
}));
app.post('/api/admin/requests/:id/advance', auth('admin'), wrap(async (req, res) => {
  await db.query(`UPDATE requests SET status=ELT(FIELD(status,'submitted','verified','approved','ready')+1,'submitted','verified','approved','ready','ready') WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
}));

// ---- Notices and public live status
const Notice = mongoose.model('Notice', new mongoose.Schema(
  { title: String, text: String }, { timestamps: true }));

// Public: current token being served and how many are waiting
app.get('/api/public/status', wrap(async (req, res) => {
  const [[s]] = await db.query(
    "SELECT (SELECT token_no FROM tokens WHERE slot_date=CURDATE() AND status='serving' LIMIT 1) serving, " +
    "(SELECT COUNT(*) FROM tokens WHERE slot_date=CURDATE() AND status='waiting') waiting");
  res.json({ serving: s.serving, waiting: s.waiting, wait_min: s.waiting * 5 });
}));

// Public: latest announcements
app.get('/api/notices', wrap(async (req, res) =>
  res.json(await Notice.find().sort('-createdAt').limit(6))));

// Admin only: post and delete announcements
app.post('/api/admin/notices', auth('admin'), wrap(async (req, res) => {
  await Notice.create({ title: req.body.title, text: req.body.text });
  res.json({ ok: true });
}));
app.delete('/api/admin/notices/:id', auth('admin'), wrap(async (req, res) => {
  await Notice.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
}));
app.get('/api/health', (req, res) => res.json({
  gemini_key_set: !!process.env.GEMINI_API_KEY,
  anthropic_key_set: !!process.env.ANTHROPIC_API_KEY,
  gemini_model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
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
    db.pool.on('connection', c => c.query("SET SESSION sql_mode = REPLACE(REPLACE(@@sql_mode,'ANSI_QUOTES,',''),',ANSI_QUOTES','')"));
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/admission_desk');
  const [[a]] = await db.query('SELECT id FROM students WHERE role=\'admin\' LIMIT 1');
  if (!a) await db.query('INSERT INTO students(roll_no,name,email,password_hash,role) VALUES(\'ADMIN\',\'Admission Office\',\'admin@college.edu\',?,\'admin\')', [await bcrypt.hash('muskan26', 8)]);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Running on http://localhost:' + port));
})().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });