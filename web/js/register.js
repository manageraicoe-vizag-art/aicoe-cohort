import { callFn, configured, esc, readPublic } from './api.js';
import { TURNSTILE_SITE_KEY } from './config.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const form = $('#form');
const YEARS = ['1st year', '2nd year', '3rd year', '4th year', '5th year', 'PG'];
const BRANCHES = ['CSE', 'CSE (AI and ML)', 'AI and DS', 'IT', 'ECE', 'EEE', 'Mechanical', 'Civil', 'Chemical', 'MBA', 'MCA', 'Other'];
const RATINGS = [['coding', 'Coding (Python or any language)'], ['data', 'Working with data (Excel, CSV, cleaning)'], ['ui', 'Design and user interfaces'],
  ['writing', 'Writing and documentation'], ['presenting', 'Presenting and explaining'], ['github_comfort', 'Git and GitHub']];
let step = 1, colleges = [], widget = null;

// ---- page data
YEARS.forEach((y) => $('#year').add(new Option(y, y)));
BRANCHES.forEach((b) => $('#branch').add(new Option(b, b)));
$('#ratings').innerHTML = RATINGS.map(([k, l]) => `<fieldset class="rate"><legend>${l}</legend><div class="seg" role="radiogroup" aria-label="${l}">` +
  [1, 2, 3].map((v) => `<input type="radio" id="${k}${v}" name="${k}" value="${v}"><label for="${k}${v}">${v}</label>`).join('') + '</div></fieldset>').join('');
$('#branch').addEventListener('change', (e) => { $('#branchOtherWrap').hidden = e.target.value !== 'Other'; });

if (configured) {
  try {
    const [s] = await readPublic('settings?select=registration_open,deadline,contact&id=eq.1');
    colleges = await readPublic('colleges?select=id,name,payer&active=eq.true&order=name');
    colleges.forEach((c) => $('#college').add(new Option(c.name, c.id)));
    if (s) $('#contact').textContent = s.contact;
    const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    if (s && (!s.registration_open || (s.deadline && today > s.deadline))) { $('#closed').hidden = false; form.hidden = true; $('.steps').hidden = true; }
  } catch (e) { $('#closed').textContent = e.message; $('#closed').hidden = false; }
} else {
  $('#closed').textContent = 'Demo: the site is not connected to Supabase yet (edit js/config.js).';
  $('#closed').hidden = false;
}

// ---- validation
const v = (n) => { const el = form.elements[n]; return el && typeof el.value === 'string' ? el.value.trim() : ''; };
function setErr(name, msg) {
  const el = $(`.err[data-for="${name}"]`); if (el) el.textContent = msg || '';
  const input = form.elements[name]; if (input && input.classList) input.classList.toggle('invalid', Boolean(msg));
  return !msg;
}
function validate(s) {
  let ok = true;
  const need = (n, m) => { ok = setErr(n, v(n) ? '' : m) && ok; };
  if (s === 1) {
    need('college_id', 'Choose your college.'); need('name', 'Enter your full name.'); need('student_id', 'Enter your college student ID.');
    need('year', 'Choose your year.'); need('branch', 'Choose your branch.');
    if (v('branch') === 'Other') need('branch_other', 'Enter your branch.');
    form.phone.value = v('phone').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
    ok = setErr('phone', /^[6-9]\d{9}$/.test(v('phone')) ? '' : 'Enter a 10-digit Indian mobile number.') && ok;
    ok = setErr('email', /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v('email')) ? '' : 'Enter a valid email address.') && ok;
    const gh = v('github').replace(/^@/, '');
    ok = setErr('github', !gh || /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(gh) ? '' : 'That is not a valid GitHub username.') && ok;
  }
  if (s === 2) ok = setErr('ratings', RATINGS.every(([k]) => form.querySelector(`input[name="${k}"]:checked`)) ? '' : 'Rate yourself on every line.') && ok;
  if (s === 3) ok = setErr('consent_data', form.consent_data.checked ? '' : 'Please agree so we can process your registration.') && ok;
  if (!ok) $(`[data-step="${s}"] .invalid, [data-step="${s}"] .err:not(:empty)`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return ok;
}
const rating = (k) => form.querySelector(`input[name="${k}"]:checked`)?.value ?? '';
const branch = () => (v('branch') === 'Other' ? v('branch_other') : v('branch'));

// ---- steps
function go(s) {
  step = s;
  $$('[data-step]').forEach((sec) => { sec.hidden = Number(sec.dataset.step) !== s; });
  $$('.steps div').forEach((d) => { const n = Number(d.dataset.s); d.className = n === s ? 'on' : n < s ? 'done' : ''; });
  $('#stepLive').textContent = `Step ${s} of 3`;
  if (s === 3) { review(); captcha(); }
  const h = $(`[data-step="${s}"] h2`); h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$$('[data-next]').forEach((b) => b.addEventListener('click', () => { if (validate(step)) go(step + 1); }));
$$('[data-back]').forEach((b) => b.addEventListener('click', () => go(step - 1)));
form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && step < 3) { e.preventDefault(); $(`[data-step="${step}"] [data-next]`).click(); } });

function review() {
  const c = colleges.find((x) => x.id === v('college_id'));
  const rows = [['College', c?.name], ['Name', v('name')], ['Student ID', v('student_id').toUpperCase()], ['Mobile', '+91 ' + v('phone')], ['Email', v('email').toLowerCase()],
    ['Year · branch', `${v('year')} · ${branch()}`], ['GitHub', v('github') || 'Not yet'], ['Skills', RATINGS.map(([k, l]) => `${l.split(' (')[0]} ${rating(k)}`).join(', ')],
    ['Payment', c?.payer === 'college' ? 'Your college pays your fee' : 'Next step: pay your college']];
  $('#review').innerHTML = rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('');
}

function captcha() {
  if (!TURNSTILE_SITE_KEY || widget !== null) return;
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.onload = () => { widget = window.turnstile.render('#captcha', { sitekey: TURNSTILE_SITE_KEY }); };
  document.head.appendChild(s);
  widget = 'loading';
}

// ---- submit
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  for (const s of [1, 2, 3]) if (!validate(s)) { if (s !== step) go(s); validate(s); return; }
  const btn = $('#submitBtn'), errBox = $('#submitErr');
  const data = {
    college_id: v('college_id'), name: v('name'), student_id: v('student_id'), email: v('email'), phone: v('phone'), year: v('year'), branch: branch(),
    github: v('github'), knows: v('knows'), consent_share_phone: form.consent_share_phone.checked, consent_startups: form.consent_startups.checked,
    consent_data: form.consent_data.checked,
    captcha: TURNSTILE_SITE_KEY && window.turnstile && typeof widget === 'string' && widget !== 'loading' ? window.turnstile.getResponse(widget) : '',
  };
  RATINGS.forEach(([k]) => { data[k] = Number(rating(k)); });
  btn.disabled = true; btn.textContent = 'Submitting...'; errBox.hidden = true;
  try {
    const r = await callFn('register', data);
    if (r.pay_token) { location.href = `pay.html?t=${encodeURIComponent(r.pay_token)}&new=1`; return; }
    form.hidden = true; $('.steps').hidden = true;
    $('#refNo').textContent = r.reference;
    $('#doneText').textContent = 'Your college pays your fee, so there is nothing to pay. Your college will confirm your place, and we will email you when it does.';
    $('#done').hidden = false; $('#done').focus();
  } catch (err) {
    errBox.textContent = err.message; errBox.hidden = false;
    btn.disabled = false; btn.textContent = 'Register and continue to payment';
    if (widget && widget !== 'loading' && window.turnstile) window.turnstile.reset(widget);
  }
});

go(1);
