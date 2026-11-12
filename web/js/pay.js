import { callFn, configured, esc, fileToBase64 } from './api.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const params = new URLSearchParams(location.search);
const token = params.get('t') || '';
const TAB_MODE = { upi: 'UPI', qr: 'UPI', bank: 'Bank transfer', cash: 'Cash' };
let info = null, tab = null;

function fatal(msg) { $('#loading').hidden = true; $('#fatal').textContent = msg; $('#fatal').hidden = false; }

async function load() {
  if (!configured) return fatal('Demo: the site is not connected to Supabase yet (edit js/config.js).');
  if (!token) return fatal('Open this page from the payment link in your email.');
  try { info = await callFn('payment', { action: 'get', token }); } catch (e) { return fatal(e.message); }
  $('#loading').hidden = true; $('#page').hidden = false;
  $('#newBanner').hidden = params.get('new') !== '1';
  $('#contact').textContent = info.contact;
  $('#who').textContent = info.student.name;
  $('#refTop').textContent = info.student.reference;
  showStatus();
}

function showStatus() {
  const st = info.student, col = info.college;
  const box = $('#statusBox');
  $('#again').hidden = true; $('#payCard').hidden = true;
  if (st.status === 'confirmed') { box.innerHTML = '<div class="okbox">Your place is confirmed. We will email you your team after registration closes.</div>'; return; }
  if (st.status === 'withdrawn') { box.innerHTML = `<div class="errbox">This registration was withdrawn. Contact ${esc(info.contact)}.</div>`; return; }
  if (col.payer === 'college') { box.innerHTML = `<div class="note">${esc(col.name)} pays the fee for its students, so there is nothing to pay. Your college will confirm your place.</div>`; return; }
  if (st.status === 'payment_submitted') {
    box.innerHTML = `<div class="okbox">Registration complete. We have your payment details (${esc(st.payment_mode)}${st.payment_ref ? `, ${esc(st.payment_ref)}` : ''}). ${esc(col.name)} will check them and we'll email you when your place is confirmed.</div>`;
    $('#again').hidden = false;
    return;
  }
  if (st.status === 'rejected') box.innerHTML = `<div class="errbox">Your college could not confirm your last payment details: ${esc(st.rejected_reason)}. Please check and submit again.</div>`;
  else box.innerHTML = info.deadline ? `<div class="note">Last step: pay ₹${info.fee_inr} to your college before ${new Date(info.deadline + 'T00:00:00').toLocaleDateString('en-IN', { dateStyle: 'long' })}.</div>` : '';
  showForm();
}
$('#again').addEventListener('click', () => { $('#again').hidden = true; showForm(); });

function upiLink(c) {
  const p = new URLSearchParams({ pa: c.upi_id, pn: c.payee_name || c.name, am: String(info.fee_inr), cu: 'INR', tn: `AIBC ${info.student.reference}` });
  return 'upi://pay?' + p.toString().replace(/\+/g, '%20');
}

function showForm() {
  const c = info.college;
  $('#payCard').hidden = false;
  $('#payee').textContent = c.payee_name || c.name;
  $('#amount').textContent = '₹' + info.fee_inr;
  $('#payNote').textContent = `AIBC ${info.student.reference}`;
  const tabs = [];
  if (c.upi_id) tabs.push(['upi', 'UPI app']);
  if (c.qr_image_url || c.upi_id) tabs.push(['qr', 'QR code']);
  if (c.bank_account_number) tabs.push(['bank', 'Bank transfer']);
  if (c.cash_at) tabs.push(['cash', 'Cash']);
  if (!tabs.length) { $('#payCard').hidden = true; $('#statusBox').innerHTML = `<div class="errbox">Payment details for ${esc(c.name)} are not set up yet. Contact ${esc(info.contact)}.</div>`; return; }
  $('#tabs').innerHTML = tabs.map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-controls="pane-${k}">${l}</button>`).join('');
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  const modes = [...new Set(tabs.map(([k]) => TAB_MODE[k]))];
  $('#mode').innerHTML = '<option value="">Select</option>' + modes.map((m) => `<option>${m}</option>`).join('');
  if (c.upi_id) { $('#upiId').textContent = c.upi_id; $('#upiName').textContent = c.payee_name || c.name; $('#upiLink').href = upiLink(c); }
  const qr = $('#qrBox'); qr.innerHTML = '';
  if (c.qr_image_url) { const img = new Image(); img.src = c.qr_image_url; img.alt = `Payment QR code for ${c.name}`; qr.appendChild(img); }
  else if (c.upi_id && window.QRCode) new window.QRCode(qr, { text: upiLink(c), width: 200, height: 200, correctLevel: window.QRCode.CorrectLevel.M });
  $('#bkName').textContent = c.bank_account_name ?? ''; $('#bkBank').textContent = c.bank_name ?? '';
  $('#bkAcc').textContent = c.bank_account_number ?? ''; $('#bkIfsc').textContent = c.bank_ifsc ?? '';
  $('#cashAt').textContent = c.cash_at ?? '';
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  showTab(mobile && c.upi_id ? 'upi' : (tabs.find((t) => t[0] === 'qr') ?? tabs[0])[0]);
  $('#payCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showTab(k) {
  tab = k;
  $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === k)));
  ['upi', 'qr', 'bank', 'cash'].forEach((p) => { $('#pane-' + p).hidden = p !== k; });
  $('#mode').value = TAB_MODE[k];
  setRefField();
}
function setRefField() {
  const mode = $('#mode').value, ref = $('#ref');
  const cfg = {
    UPI: ['Last 6 digits of the UTR', 'GPay: "UPI transaction ID" · PhonePe: "UTR" · Paytm: "UPI Ref. No."', 'numeric', 6, 'Payment screenshot'],
    'Bank transfer': ['Last 6 characters of the bank reference', 'The UTR or reference on your transfer receipt', 'text', 6, 'Payment screenshot'],
    Cash: ['Receipt number (optional)', 'If you have already paid', 'text', 20, 'Photo of the receipt (optional)'],
  }[mode] || ['Last 6 digits of the UTR', '', 'numeric', 6, 'Payment screenshot'];
  $('#refLabel').textContent = cfg[0]; $('#refHint').textContent = cfg[1]; ref.inputMode = cfg[2]; ref.maxLength = cfg[3]; $('#fileLabel').textContent = cfg[4];
  $('#noteWrap').hidden = mode === 'Cash';
  setErr('ref', ''); setErr('file', '');
}
$('#mode').addEventListener('change', () => {
  const mode = $('#mode').value;
  const options = Object.keys(TAB_MODE).filter((k) => TAB_MODE[k] === mode && $(`#tabs [data-tab="${k}"]`));
  if (options.includes(tab)) setRefField(); else if (options.length) showTab(options[0]); else setRefField();
});
$$('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#' + b.dataset.copy).textContent); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); } catch { b.textContent = 'Select and copy'; }
}));

function setErr(name, msg) {
  const el = $(`.err[data-for="${name}"]`); if (el) el.textContent = msg || '';
  const input = $('#form').elements[name]; if (input && input.classList) input.classList.toggle('invalid', Boolean(msg));
  return !msg;
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, mode = f.mode.value, ref = f.ref.value.replace(/\s/g, '').toUpperCase(), file = f.file.files[0];
  f.ref.value = ref;
  let ok = setErr('mode', mode ? '' : 'Choose how you are paying.');
  let rm = '';
  if (mode === 'UPI' && !/^\d{6}$/.test(ref)) rm = 'Enter the last 6 digits of the UTR.';
  if (mode === 'Bank transfer' && !/^[A-Z0-9]{6}$/.test(ref)) rm = 'Enter the last 6 characters of the bank reference.';
  if (mode === 'Cash' && ref && !/^[A-Z0-9\-/]{1,20}$/.test(ref)) rm = 'Use only letters and numbers from your receipt.';
  ok = setErr('ref', rm) && ok;
  let fm = '';
  if (!file && mode !== 'Cash') fm = 'Upload a screenshot of your payment.';
  else if (file && file.size > 2 * 1024 * 1024) fm = 'The file is over 2 MB. Crop it or take a smaller screenshot.';
  else if (file && !['image/jpeg', 'image/png', 'application/pdf'].includes(file.type)) fm = 'Use a JPG, PNG or PDF file.';
  ok = setErr('file', fm) && ok;
  if (!ok) return;
  const btn = $('#submitBtn'), err = $('#submitErr');
  btn.disabled = true; btn.textContent = 'Submitting...'; err.hidden = true;
  try {
    const body = { action: 'submit', token, mode, ref };
    if (file) body.file = { type: file.type, base64: await fileToBase64(file) };
    await callFn('payment', body);
    info.student = { ...info.student, status: 'payment_submitted', payment_mode: mode, payment_ref: ref };
    showStatus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (x) {
    err.textContent = x.message; err.hidden = false;
  } finally { btn.disabled = false; btn.textContent = 'Submit payment details'; }
});

load();
