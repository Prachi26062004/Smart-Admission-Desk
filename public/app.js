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

// ===== PAYMENTS (Razorpay): paste this ONCE at the very bottom of the script =====
(function () {
  const money = n => 'Rs ' + Number(n).toLocaleString('en-IN');
  const dateOf = d => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const byId = x => document.getElementById(x);
  let row = null;   // the fee being paid

  // The pop-up and its styles are created here, so no HTML or CSS edits are needed
  const style = document.createElement('style');
  style.textContent = `
    .pay-ov{position:fixed;inset:0;background:#000a;display:none;align-items:center;justify-content:center;padding:16px;z-index:50}
    .pay-ov.show{display:flex}
    .pay-box{background:var(--card,#fff);color:var(--ink,#10242B);border:1px solid var(--line,#C9D6DB);border-radius:12px;padding:22px;width:100%;max-width:420px}
    .pay-box h2{margin:0 0 10px;font-size:18px}
    .pay-row{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--line,#C9D6DB)}
    .pay-note{color:var(--mute,#587079);font-size:14px}
    .pay-btns{display:flex;gap:10px;margin-top:12px}
    .pay-btns button{font:inherit;border-radius:6px;padding:10px 16px;cursor:pointer;border:1px solid var(--line,#C9D6DB);background:transparent;color:inherit}
    .pay-btns button.go{background:var(--btn,#0B6E6E);color:#fff;border:0}
    .pay-btns button:disabled{opacity:.6;cursor:wait}
    .pay-ok{width:56px;height:56px;border-radius:50%;background:var(--okbg,#CBEBDD);color:var(--oktx,#0F5A38);display:flex;align-items:center;justify-content:center;font-size:30px;margin:0 auto 10px}
    .pay-err{color:#E0584B;margin:8px 0 0}
    @media print{body *{visibility:hidden}.pay-box,.pay-box *{visibility:visible}.pay-box{position:absolute;left:0;top:0;width:100%;max-width:none;border:0}.pay-btns{display:none}}`;
  document.head.appendChild(style);
  const overlay = document.createElement('div');
  overlay.className = 'pay-ov';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = '<div class="pay-box"></div>';
  document.body.appendChild(overlay);
  const box = overlay.firstChild;

  function loadRazorpay() {
    return new Promise((ok, fail) => {
      if (window.Razorpay) return ok();
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = ok;
      s.onerror = () => fail(new Error('Could not load the payment window. Check your internet connection.'));
      document.head.appendChild(s);
    });
  }

  function openPay(id) {
    row = fees.find(f => Number(f.id) === Number(id));
    if (!row) return;
    box.innerHTML = `
      <h2>Confirm payment</h2>
      <div class="pay-row"><span>${esc(row.label)}<br><small>Due ${dateOf(row.due_date)}</small></span><b>${money(row.amount)}</b></div>
      <p class="pay-note">You will pay securely through Razorpay using UPI, card or net banking.</p>
      <div class="pay-btns"><button class="go" id="pay-go">Pay ${money(row.amount)}</button><button id="pay-cancel">Cancel</button></div>
      <p class="pay-err" id="pay-err"></p>`;
    byId('pay-go').onclick = startPay;
    byId('pay-cancel').onclick = closePay;
    overlay.classList.add('show');
  }

  function closePay() {
    overlay.classList.remove('show');
    if (typeof loadFees === 'function') loadFees();
  }

  function showReceipt(paymentId) {
    box.innerHTML = `
      <div class="pay-ok">&#10003;</div>
      <h2 style="text-align:center">Payment successful</h2>
      <div class="pay-row"><span>Payment ID</span><b>${esc(paymentId)}</b></div>
      <div class="pay-row"><span>Student</span><b>${esc(byId('who').textContent)}</b></div>
      <div class="pay-row"><span>Fee</span><b>${esc(row.label)}</b></div>
      <div class="pay-row"><span>Amount</span><b>${money(row.amount)}</b></div>
      <div class="pay-row"><span>Date</span><b>${new Date().toLocaleString()}</b></div>
      <div class="pay-btns"><button class="go" id="pay-print">Print or save as PDF</button><button id="pay-done">Done</button></div>`;
    byId('pay-print').onclick = () => window.print();
    byId('pay-done').onclick = closePay;
  }

  function showFailure(paymentId) {
    box.innerHTML = `
      <h2>We could not confirm your payment</h2>
      <p>If money was deducted, do not pay again. Contact the admission office with this payment ID: <b>${esc(paymentId)}</b></p>
      <div class="pay-btns"><button id="pay-done">Close</button></div>`;
    byId('pay-done').onclick = closePay;
  }

  async function startPay() {
    const go = byId('pay-go'), err = byId('pay-err');
    const reset = () => { go.disabled = false; go.textContent = 'Pay ' + money(row.amount); };
    go.disabled = true;
    go.textContent = 'Opening secure checkout...';
    err.textContent = '';
    try {
      await loadRazorpay();
      const o = await post('/fees/' + row.id + '/order');            // 1. server creates the order
      const rzp = new Razorpay({                                      // 2. Razorpay's own payment window
        key: o.key, amount: o.amount, currency: 'INR', order_id: o.order_id,
        name: 'Smart Admission Desk', description: row.label,
        prefill: { name: byId('who').textContent },
        theme: { color: '#0B6E6E' },
        handler: async resp => {                                      // 3. paid: the server verifies it
          try {
            const r = await post('/fees/' + row.id + '/verify', resp);
            showReceipt(r.receipt);
          } catch (e) { showFailure(resp.razorpay_payment_id); }
        },
        modal: { ondismiss: reset }
      });
      rzp.on('payment.failed', r => { err.textContent = (r.error && r.error.description) || 'Payment failed. Please try again.'; reset(); });
      rzp.open();
    } catch (e) {
      err.textContent = e.message;
      reset();
    }
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('show')) closePay();
  });

  // Make the existing "Pay now" buttons use the new pop-up (works whatever the old function was called)
  window.openPay = openPay;
  window.payFee = openPay;
  window.pay = openPay;
})();