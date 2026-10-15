// ========== 1. HELPERS ==========
const $ = id => document.getElementById(id);                       // short for getElementById
const esc = s => String(s ?? '').replace(/[&<>"]/g,                // makes text safe to show
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => 'Rs ' + Number(n).toLocaleString('en-IN');
const fmtDate = d => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

let token = '';          // login token from the server
let role = '';           // 'student' or 'admin'
let registering = false; // is the form in "create account" mode?
let fees = [];

// ========== 2. EDIT THESE FOR YOUR COLLEGE ==========
const DATES = [
  ['2026-11-01', 'Renewal window opens'],
  ['2026-11-20', 'Last date for renewal forms'],
  ['2026-12-05', 'New admission applications close']
];
const CHECKLISTS = {
  'New admission': ['12th marksheet', 'ID proof (Aadhaar or PAN)', 'Passport-size photos', 'Income certificate', 'Transfer certificate'],
  'Renewal': ['Previous year fee receipt', 'College ID card', 'No-dues form'],
  'Certificate': ['College ID card', 'Latest fee receipt', 'Signed application form']
};

// ========== 3. DARK MODE ==========
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('themebtn').textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  try { localStorage.setItem('theme', theme); } catch {}
}
function toggleTheme() {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}
let savedTheme = null;
try { savedTheme = localStorage.getItem('theme'); } catch {}
setTheme(savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

// ========== 4. TALKING TO THE SERVER ==========
async function api(url, options = {}) {
  const headers = { authorization: 'Bearer ' + token };
  if (options.body && !(options.body instanceof FormData)) headers['content-type'] = 'application/json';
  const res = await fetch('/api' + url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body || {}) });

// ========== 5. PUBLIC BLOCKS (work before login) ==========
async function loadLive() {
  try {
    const s = await (await fetch('/api/public/status')).json();
    document.querySelectorAll('.live').forEach(el => {
      el.innerHTML = `
        <div class="lq"><small>Now serving</small><b>${s.serving ? '#' + s.serving : '-'}</b></div>
        <div><b>${s.waiting}</b> waiting<br>about <b>${s.wait_min}</b> min wait</div>`;
    });
  } catch {}
}
async function loadNotices() {
  try {
    const list = await (await fetch('/api/notices')).json();
    const html = list.map(n => `
      <div class="note"><b>${esc(n.title)}</b><br>${esc(n.text)}
        <small>${new Date(n.createdAt).toLocaleDateString()}</small></div>`).join('')
      || '<p class="mute">No announcements yet.</p>';
    document.querySelectorAll('.notes').forEach(el => el.innerHTML = html);
    return list;
  } catch { return []; }
}
loadLive();
loadNotices();
setInterval(loadLive, 15000);   // refresh the live queue every 15 seconds

// ========== 6. SIGN IN AND TABS ==========
function toggleReg() {
  registering = !registering;
  $('regfields').classList.toggle('hide', !registering);
  $('ltitle').textContent = registering ? 'Create account' : 'Sign in';
  $('swl').textContent = registering ? 'I already have an account' : 'Create an account';
}
async function submitAuth() {
  try {
    $('lerr').textContent = '';
    if (registering) {
      await post('/auth/register', { name: $('name').value, roll_no: $('roll').value, email: $('email').value, password: $('pw').value });
      toggleReg();
      $('lerr').textContent = 'Account created. Sign in now.';
      return;
    }
    const d = await post('/auth/login', { email: $('email').value, password: $('pw').value });
    token = d.token;
    role = d.role;
    $('who').textContent = d.name;
    $('login').classList.add('hide');
    $('app').classList.remove('hide');
    $('logout').classList.remove('hide');
    if (role !== 'admin') $('fab').classList.remove('hide');   // help button for students
    initTabs();
  } catch (e) {
    $('lerr').textContent = e.message;
  }
}
function initTabs() {
  const tabs = role === 'admin'
    ? [['admin', 'Admin desk']]
    : [['home', 'Home'], ['docs', 'Documents'], ['fees', 'Fees'], ['queue', 'Queue'], ['req', 'Requests']];
  $('tabs').innerHTML = tabs.map(([key, label]) => `<button id="b-${key}" onclick="show('${key}')">${label}</button>`).join('');
  $('sdate').value = new Date().toISOString().slice(0, 10);
  $('stime').innerHTML = ['10:00', '11:00', '12:00', '14:00', '15:00'].map(t => `<option>${t}</option>`).join('');
  $('ckt').innerHTML = Object.keys(CHECKLISTS).map(k => `<option>${k}</option>`).join('');
  renderChecklist();
  show(tabs[0][0]);
}
function show(key) {
  document.querySelectorAll('main section').forEach(s => s.classList.add('hide'));
  $('t-' + key).classList.remove('hide');
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.id === 'b-' + key));
  const loaders = { home: loadHome, docs: loadDocs, fees: loadFees, queue: loadQueue, req: loadRequests, admin: loadAdmin };
  loaders[key]?.();
}
function tag(status) {
  const cls = { accepted: 'ok', paid: 'ok', rejected: 'bad', due: 'warn', review: 'warn' }[status] || '';
  return `<span class="tag ${cls}">${esc(status)}</span>`;
}

// ========== 7. HOME TAB ==========
function renderChecklist() {
  $('ckl').innerHTML = CHECKLISTS[$('ckt').value].map(item => `<label><input type="checkbox">${esc(item)}</label>`).join('');
}
async function loadHome() {
  loadLive();
  loadNotices();
  fees = await api('/fees');
  const unpaid = fees.filter(f => f.status === 'due');
  // important dates = your fixed dates + each unpaid fee's due date, sorted
  const dates = [...DATES, ...unpaid.map(f => [f.due_date.slice(0, 10), f.label + ' due'])].sort();
  $('dates').innerHTML = dates.map(([d, text]) => `<div class="date"><b>${fmtDate(d)}</b><span>${esc(text)}</span></div>`).join('');
  const totalDue = unpaid.reduce((sum, f) => sum + Number(f.amount), 0);
  $('homefees').innerHTML = `
    <div class="row"><span>Total due</span><b>${money(totalDue)}</b></div>
    <div class="row"><span>Items pending</span><b>${unpaid.length}</b></div>
    <button class="p" onclick="show('fees')">Open fees</button>`;
}

// ========== 8. DOCUMENTS TAB ==========
async function uploadDoc() {
  const file = $('dfile').files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  form.append('docType', $('dtype').value);
  $('dres').textContent = 'Checking...';
  try {
    const d = await api('/documents', { method: 'POST', body: form });
    $('dres').innerHTML = tag(d.ai.status) + ' ' + esc(d.ai.issues.join(' ') || 'Document looks good.');
    loadDocs();
  } catch (e) {
    $('dres').textContent = e.message;
  }
}
async function loadDocs() {
  const docs = await api('/documents');
  $('dlist').innerHTML = docs.map(d => `
    <div class="row"><span>${esc(d.docType)}<br><small>${esc(d.ai.issues.join(' '))}</small></span>${tag(d.ai.status)}</div>`).join('')
    || '<p class="mute">No documents yet. Upload one.</p>';
}

// ========== 9. FEES TAB ==========
async function loadFees() {
  fees = await api('/fees');
  const total = fees.reduce((sum, f) => sum + Number(f.amount), 0);
  const paid = fees.filter(f => f.status === 'paid').reduce((sum, f) => sum + Number(f.amount), 0);
  $('fsum').innerHTML = `
    <div><small>Total fees</small><b>${money(total)}</b></div>
    <div><small>Paid</small><b>${money(paid)}</b></div>
    <div><small>Remaining</small><b>${money(total - paid)}</b></div>`;
  $('ftab').innerHTML = fees.map(f => `
    <tr>
      <td>${esc(f.label)}</td>
      <td>${fmtDate(f.due_date)}</td>
      <td>${money(f.amount)}</td>
      <td>${tag(f.status)}${f.receipt_no ? '<br><small>' + esc(f.receipt_no) + '</small>' : ''}</td>
      <td>${f.status === 'due' ? `<button class="p" onclick="payFee(${f.id})">Pay now</button>` : ''}</td>
    </tr>`).join('');
  $('ffoot').innerHTML = `<tr><td colspan="2">Total</td><td colspan="3">${money(total)}</td></tr>`;
}
async function payFee(id) {
  await post('/fees/' + id + '/pay');
  loadFees();
}

// ========== 10. QUEUE TAB ==========
async function bookToken() {
  try {
    $('qerr').textContent = '';
    await post('/tokens', { purpose: $('purpose').value, slot_date: $('sdate').value, slot_time: $('stime').value });
    loadQueue();
  } catch (e) {
    $('qerr').textContent = e.message;
  }
}
async function loadQueue() {
  const active = (await api('/tokens/mine')).filter(t => ['waiting', 'serving'].includes(t.status));
  if (!active.length) return;
  $('mytokens').innerHTML = active.map(t => `
    <div class="ticket">
      <b>#${t.token_no}</b>
      <div style="text-align:right">${esc(t.purpose)}<br>
        ${t.status === 'serving' ? 'Your turn. Go to the counter.' : `${t.ahead} ahead, about ${t.wait_min} min`}<br>
        Now serving: ${t.now_serving || '-'}</div>
    </div>`).join('');
}

// ========== 11. REQUESTS TAB ==========
const STEPS = ['submitted', 'verified', 'approved', 'ready'];
async function newRequest() {
  await post('/requests', { type: $('rtype').value });
  loadRequests();
}
async function loadRequests() {
  const list = await api('/requests');
  $('rlist').innerHTML = list.map(r => `
    <div style="padding:8px 0"><b>${esc(r.type.replace('_', ' '))}</b> · ${esc(r.status)}
      <div class="steps">${STEPS.map((s, i) => `<i class="${i <= STEPS.indexOf(r.status) ? 'on' : ''}"></i>`).join('')}</div>
    </div>`).join('') || '<p class="mute">No requests yet.</p>';
}

// ========== 12. HELP CHAT ==========
async function sendChat() {
  const q = $('q').value;
  if (!q) return;
  $('q').value = '';
  $('chatlog').innerHTML += `<div class="msg"><b>You:</b> ${esc(q)}</div>`;
  try {
    const d = await post('/chat', { q });
    $('chatlog').innerHTML += `<div class="msg"><b>Assistant:</b> ${esc(d.a)}</div>`;
  } catch (e) {
    $('chatlog').innerHTML += `<div class="msg err">${esc(e.message)}</div>`;
  }
  $('chatlog').scrollTop = 1e6;
}

// ========== 13. ADMIN DESK ==========
async function loadAdmin() {
  const [stats, queue, reqs] = await Promise.all([api('/admin/stats'), api('/admin/queue'), api('/admin/requests')]);
  $('stats').innerHTML = `<h2>Overview</h2>
    Waiting today: <b>${stats.waiting}</b> · Open requests: <b>${stats.pending}</b> · Avg processing: <b>${stats.avg_min} min</b><br>
    Rejected documents: ${stats.rejections.map(x => esc(x._id) + ' (' + x.n + ')').join(', ') || 'none'}`;
  $('aq').innerHTML = queue.map(t => `
    <div class="row"><span>#${t.token_no} ${esc(t.name)}<br><small>${esc(t.purpose)}</small></span>${tag(t.status)}</div>`).join('')
    || '<p class="mute">Queue is empty.</p>';
  $('ar').innerHTML = reqs.map(r => `
    <div class="row"><span>${esc(r.name)} · ${esc(r.type)}</span>
      <span>${esc(r.status)} <button class="p" onclick="advance(${r.id})">Advance</button></span></div>`).join('')
    || '<p class="mute">No open requests.</p>';
  const notes = await loadNotices();
  $('anotes').innerHTML = notes.map(n => `
    <div class="row"><span>${esc(n.title)}</span><button class="p" onclick="deleteNotice('${n._id}')">Delete</button></div>`).join('');
}
async function callNext()     { await post('/admin/queue/next'); loadAdmin(); }
async function advance(id)    { await post('/admin/requests/' + id + '/advance'); loadAdmin(); }
async function postNotice() {
  if (!$('ntitle').value) return;
  await post('/admin/notices', { title: $('ntitle').value, text: $('ntext').value });
  $('ntitle').value = '';
  $('ntext').value = '';
  loadAdmin();
}
async function deleteNotice(id) {
  await api('/admin/notices/' + id, { method: 'DELETE' });
  loadAdmin();
}