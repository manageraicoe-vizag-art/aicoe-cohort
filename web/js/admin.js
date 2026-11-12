import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { callFn, esc } from './api.js';
import { KEY_ROLE, makeTeams, pickNames, refreshTeam } from './teams.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const STUDENT_COLS = 'id, reference, college_id, name, student_id, email, phone, year, branch, github, coding, data, ui, writing, presenting, github_comfort, knows, consent_share_phone, consent_startups, status, payment_mode, payment_ref, payment_proof_path, payment_submitted_at, rejected_reason, verified_by, verified_at, team_id, team_role, created_at';
const STATUS = { registered: 'Not paid yet', payment_submitted: 'To check', confirmed: 'Confirmed', rejected: 'Rejected', withdrawn: 'Withdrawn' };
const SKILLS = [['coding', 'Code'], ['data', 'Data'], ['ui', 'UI'], ['writing', 'Write'], ['presenting', 'Present'], ['github_comfort', 'Git']];

const state = { me: null, colleges: [], students: [], teams: [], settings: null, college: '', tab: 'overview', draft: null, draftDirty: false, draftSaved: false, started: false };

// ------------------------------------------------------------ helpers
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3500);
}
async function token() { return (await sb.auth.getSession()).data.session?.access_token; }
async function staffCall(body) { return callFn('staff', body, await token()); }
const collegeName = (id) => state.colleges.find((c) => c.id === id)?.name ?? id;
const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const statusLabel = (s, payer) => (s === 'payment_submitted' && payer === 'college' ? 'To confirm' : STATUS[s] ?? s);
const isAdmin = () => state.me?.role === 'admin';

/** A dialog with buttons; resolves with the chosen button's value, or null. */
function dialog(title, bodyHtml, buttons = [{ label: 'Close', value: null, ghost: true }]) {
  const d = $('#dlg');
  $('#dlgTitle').textContent = title;
  $('#dlgBody').innerHTML = bodyHtml;
  $('#dlgFoot').innerHTML = '';
  return new Promise((resolve) => {
    const done = (v) => { d.close(); resolve(v); };
    for (const b of buttons) {
      const el = document.createElement('button');
      el.type = 'button'; el.textContent = b.label;
      if (b.ghost) el.className = 'ghost'; if (b.danger) el.className = 'danger';
      el.addEventListener('click', () => (b.onClick ? b.onClick(done) : done(b.value)));
      $('#dlgFoot').appendChild(el);
    }
    $('#dlgClose').onclick = () => done(null);
    d.onclose = () => resolve(null);
    d.showModal();
  });
}
async function confirmAction(title, text, label = 'Confirm', danger = false) {
  return (await dialog(title, `<p>${text}</p>`, [{ label: 'Cancel', value: false, ghost: true }, { label, value: true, danger }])) === true;
}
async function run(btn, fn) {
  if (btn) btn.disabled = true;
  try { await fn(); } catch (e) { toast(e.message); } finally { if (btn) btn.disabled = false; }
}

// ------------------------------------------------------------ sign-in
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#loginEmail').value.trim().toLowerCase();
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
  $('#loginMsg').textContent = error ? error.message : `Check ${email} for a sign-in link. You can close this tab.`;
});
$('#signOut').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });

async function onSession(session) {
  if (!session) { $('#login').hidden = false; $('#app').hidden = true; $('#who').hidden = true; return; }
  if (state.started) return;
  const email = session.user.email.toLowerCase();
  const { data: me } = await sb.from('staff').select('*').eq('email', email).maybeSingle();
  if (!me) {
    $('#login').hidden = false;
    $('#loginMsg').textContent = `${email} is not on the staff list. Ask an RTIH admin to add you.`;
    await sb.auth.signOut();
    return;
  }
  state.started = true;
  state.me = me;
  state.college = me.role === 'coordinator' ? me.college_id : '';
  $('#login').hidden = true; $('#app').hidden = false; $('#who').hidden = false;
  $('#meLabel').textContent = `${email} · ${me.role === 'admin' ? 'RTIH admin' : 'Coordinator'}`;
  buildTabs();
  await loadAll();
}
sb.auth.onAuthStateChange((_e, session) => { setTimeout(() => onSession(session), 0); });

// ------------------------------------------------------------ data
async function fetchAll(table, cols, order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).order(order, { ascending: false }).range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
async function loadAll() {
  try {
    const [cols, studs, teams, settings] = await Promise.all([
      sb.from('colleges').select('*').order('name'),
      fetchAll('students', STUDENT_COLS, 'created_at'),
      sb.from('teams').select('*').order('number'),
      sb.from('settings').select('*').eq('id', 1).single(),
    ]);
    state.colleges = cols.data ?? []; state.students = studs; state.teams = teams.data ?? []; state.settings = settings.data;
  } catch (e) { toast(e.message); }
  const pick = $('#collegePick');
  const opts = (isAdmin() ? [['', 'All colleges']] : []).concat(state.colleges.filter((c) => isAdmin() || c.id === state.me.college_id).map((c) => [c.id, c.name]));
  pick.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  pick.value = state.college; pick.disabled = !isAdmin();
  $('#staffCollege').innerHTML = state.colleges.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  render();
}
$('#collegePick').addEventListener('change', (e) => { state.college = e.target.value; state.draft = null; render(); });

// ------------------------------------------------------------ tabs
function buildTabs() {
  const tabs = [['overview', 'Overview'], ['students', 'Students']];
  if (isAdmin()) tabs.push(['teams', 'Teams and keys'], ['colleges', 'Colleges'], ['staff', 'Staff']);
  tabs.push(['emails', 'Emails']);
  if (isAdmin()) tabs.push(['settings', 'Settings']);
  $('#tabs').innerHTML = tabs.map(([k, l]) => `<button type="button" role="tab" data-t="${k}">${l}</button>`).join('');
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.t; render(); }));
}
function render() {
  $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.t === state.tab)));
  $$('[data-tab]').forEach((p) => { p.hidden = p.dataset.tab !== state.tab; });
  ({ overview: renderOverview, students: renderStudents, teams: renderTeams, colleges: renderColleges, staff: renderStaff, emails: renderEmails, settings: renderSettings })[state.tab]();
}
const inScope = (s) => !state.college || s.college_id === state.college;

// ------------------------------------------------------------ overview
function renderOverview() {
  const fee = state.settings?.fee_inr ?? 250;
  const cols = state.colleges.filter((c) => !state.college || c.id === state.college);
  const rows = cols.map((c) => {
    const ss = state.students.filter((s) => s.college_id === c.id);
    const n = (st) => ss.filter((s) => s.status === st).length;
    const confirmed = n('confirmed');
    const teams = Math.floor(confirmed / 4);
    return { c, total: ss.filter((s) => s.status !== 'withdrawn').length, unpaid: n('registered'), check: n('payment_submitted'), confirmed, rejected: n('rejected'),
      amount: c.payer === 'students' ? confirmed * fee : 0, teams, credit: teams * 10 };
  });
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  $('#stats').innerHTML = [['Registered', sum('total')], ['To check', sum('check')], ['Confirmed', sum('confirmed')], ['Teams possible', sum('teams')]]
    .map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  $('#overviewTable').innerHTML = `<thead><tr><th>College</th><th>Who pays</th><th class="num">Registered</th><th class="num">Not paid yet</th><th class="num">To check</th><th class="num">Confirmed</th><th class="num">Rejected</th><th class="num">Collected (₹)</th><th class="num">Teams of 4</th><th class="num">Credit to buy ($)</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td>${esc(r.c.name)}${r.c.active ? '' : ' <span class="badge">inactive</span>'}</td><td>${r.c.payer === 'college' ? 'College' : 'Students'}</td><td class="num">${r.total}</td><td class="num">${r.unpaid}</td><td class="num">${r.check}</td><td class="num">${r.confirmed}</td><td class="num">${r.rejected}</td><td class="num">${r.amount.toLocaleString('en-IN')}</td><td class="num">${r.teams}</td><td class="num">${r.credit}</td></tr>`).join('') + '</tbody>';
}

// ------------------------------------------------------------ students
function filteredStudents() {
  const st = $('#fStatus').value, q = $('#fSearch').value.trim().toLowerCase();
  return state.students.filter((s) => inScope(s) && (!st || s.status === st) &&
    (!q || [s.name, s.email, s.student_id, s.reference, s.payment_ref, s.phone].some((v) => String(v ?? '').toLowerCase().includes(q))));
}
function renderStudents() {
  const list = filteredStudents();
  const shown = list.slice(0, 500);
  const payer = (s) => state.colleges.find((c) => c.id === s.college_id)?.payer;
  $('#studentTable').innerHTML = `<thead><tr><th>Ref</th><th>Name</th>${state.college ? '' : '<th>College</th>'}<th>Student ID</th><th>Year · branch</th><th>Status</th><th>Payment</th><th>Team</th><th></th></tr></thead><tbody>` +
    shown.map((s) => `<tr><td>${esc(s.reference)}</td><td>${esc(s.name)}<br><span class="hint">${esc(s.email)}</span></td>${state.college ? '' : `<td>${esc(collegeName(s.college_id))}</td>`}
      <td>${esc(s.student_id)}</td><td>${esc(s.year)} · ${esc(s.branch)}</td><td><span class="badge ${s.status}">${esc(statusLabel(s.status, payer(s)))}</span></td>
      <td>${s.payment_mode ? `${esc(s.payment_mode)}${s.payment_ref ? ` · ${esc(s.payment_ref)}` : ''}` : '<span class="hint">none</span>'}</td>
      <td>${esc(state.teams.find((t) => t.id === s.team_id)?.name ?? '')}</td>
      <td><button class="small ghost" data-open="${s.id}">Open</button></td></tr>`).join('') + '</tbody>';
  $('#studentCount').textContent = `${list.length} students${list.length > 500 ? ' (first 500 shown; search to narrow)' : ''}.`;
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => openStudent(b.dataset.open)));
}
$('#fStatus').addEventListener('change', renderStudents);
$('#fSearch').addEventListener('input', () => { clearTimeout(renderStudents.t); renderStudents.t = setTimeout(renderStudents, 200); });

async function openStudent(id) {
  const s = state.students.find((x) => x.id === id);
  const col = state.colleges.find((c) => c.id === s.college_id);
  const team = state.teams.find((t) => t.id === s.team_id);
  const body = `<dl class="kv">
    <dt>Reference</dt><dd>${esc(s.reference)} <span class="badge ${s.status}">${esc(statusLabel(s.status, col?.payer))}</span></dd>
    <dt>College</dt><dd>${esc(col?.name)}</dd><dt>Student ID</dt><dd>${esc(s.student_id)}</dd>
    <dt>Email</dt><dd>${esc(s.email)}</dd><dt>Mobile</dt><dd>+91 ${esc(s.phone)}</dd>
    <dt>Year · branch</dt><dd>${esc(s.year)} · ${esc(s.branch)}</dd><dt>GitHub</dt><dd>${esc(s.github ?? 'not yet')}</dd>
    <dt>Skills</dt><dd>${SKILLS.map(([k, l]) => `${l} ${s[k]}`).join(' · ')}</dd>
    <dt>Knows</dt><dd>${esc(s.knows ?? '')}</dd>
    <dt>Consents</dt><dd>Phone to team: ${s.consent_share_phone ? 'yes' : 'no'} · Startups: ${s.consent_startups ? 'yes' : 'no'}</dd>
    <dt>Registered</dt><dd>${fmtDate(s.created_at)}</dd>
    <dt>Payment</dt><dd>${col?.payer === 'college' ? 'Paid by the college' : s.payment_mode ? `${esc(s.payment_mode)}${s.payment_ref ? `, ref ${esc(s.payment_ref)}` : ''}, ${fmtDate(s.payment_submitted_at)}` : 'Not submitted'}</dd>
    ${s.payment_proof_path ? `<dt>Proof</dt><dd><button class="small ghost" id="proofBtn">Open payment proof</button><a id="proofLink" target="_blank" rel="noopener" hidden>Open file</a></dd>` : ''}
    ${s.rejected_reason ? `<dt>Rejected because</dt><dd>${esc(s.rejected_reason)}</dd>` : ''}
    ${s.verified_by ? `<dt>Checked by</dt><dd>${esc(s.verified_by)}, ${fmtDate(s.verified_at)}</dd>` : ''}
    <dt>Team</dt><dd>${esc(team ? `${team.name} (${s.team_role ?? ''})` : 'none')}</dd>
  </dl>
  <label class="f" style="margin-top:14px" id="reasonWrap" hidden>Reason the student will see <textarea id="reason" maxlength="300" placeholder="e.g. We could not find a payment ending 482913 in our statement."></textarea></label>`;
  const canVerify = ['registered', 'payment_submitted', 'rejected'].includes(s.status);
  const buttons = [{ label: 'Close', value: null, ghost: true },
    { label: 'Resend email', ghost: true, onClick: (done) => run(null, async () => { const r = await staffCall({ action: 'resend', student_id: s.id }); toast(`Email ${r.email}`); done(null); }) }];
  if (s.status !== 'withdrawn' && !(team && team.status === 'published')) {
    buttons.push({ label: 'Withdraw', ghost: true, onClick: async (done) => {
      done(null);
      if (await confirmAction('Withdraw student', `${esc(s.name)} will be removed from teams and lists. This can't be undone here.`, 'Withdraw', true)) {
        await run(null, async () => { await staffCall({ action: 'withdraw', student_id: s.id }); toast('Withdrawn'); await loadAll(); });
      }
    } });
  }
  if (canVerify && s.status !== 'rejected' && col?.payer !== 'college') {
    buttons.push({ label: 'Reject', danger: true, onClick: (done) => {
      const w = $('#reasonWrap');
      if (w.hidden) { w.hidden = false; $('#reason').focus(); return; }
      run(null, async () => { await staffCall({ action: 'verify', student_id: s.id, approve: false, reason: $('#reason').value, seen_submitted_at: s.payment_submitted_at }); toast('Rejected; the student has been emailed'); done(null); await loadAll(); });
    } });
  }
  if (canVerify) {
    buttons.push({ label: col?.payer === 'college' ? 'Confirm place' : 'Confirm payment', onClick: (done) => run(null, async () => {
      await staffCall({ action: 'verify', student_id: s.id, approve: true, seen_submitted_at: s.payment_submitted_at }); toast('Confirmed; the student has been emailed'); done(null); await loadAll();
    }) });
  }
  const p = dialog(`${s.name}`, body, buttons);
  const pb = $('#proofBtn');
  if (pb) pb.addEventListener('click', () => run(pb, async () => {
    const { data, error } = await sb.storage.from('payment-proofs').createSignedUrl(s.payment_proof_path, 300);
    if (error) throw error;
    const a = $('#proofLink'); a.href = data.signedUrl; a.hidden = false; pb.hidden = true; a.click();
  }));
  await p;
}

$('#exportCsv').addEventListener('click', () => {
  const cols = ['registered_at', 'reference', 'college', 'name', 'student_id', 'email', 'phone', 'year', 'branch', 'github', 'coding', 'data', 'ui', 'writing', 'presenting', 'github_comfort', 'knows', 'consent_share_phone', 'consent_startups', 'status', 'paid', 'payment_mode', 'payment_ref', 'team', 'team_role'];
  const rows = filteredStudents().map((s) => ({ ...s, registered_at: s.created_at, college: collegeName(s.college_id), paid: s.status === 'confirmed' ? 'yes' : 'no',
    consent_share_phone: s.consent_share_phone ? 'yes' : 'no', consent_startups: s.consent_startups ? 'yes' : 'no', team: state.teams.find((t) => t.id === s.team_id)?.name ?? '' }));
  const cell = (v) => { const t = String(v ?? '').replace(/^[=+\-@]/, "'$&"); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = `students-${state.college || 'all'}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
});

// ------------------------------------------------------------ teams
function collegeTeams() { return state.teams.filter((t) => t.college_id === state.college); }
function eligible() {
  const published = new Set(collegeTeams().filter((t) => t.status === 'published').map((t) => t.id));
  return state.students.filter((s) => s.college_id === state.college && s.status === 'confirmed' && !published.has(s.team_id));
}
function draftFromSaved() {
  const drafts = collegeTeams().filter((t) => t.status === 'draft');
  if (!drafts.length) return null;
  const pool = eligible();
  return drafts.map((t) => refreshTeam(pool.filter((s) => s.team_id === t.id), pool)).map((r, i) => ({ ...r, number: drafts[i].number, name: drafts[i].name }));
}
function renderTeams() {
  const need = !state.college;
  $('#teamsNeedCollege').hidden = !need; $('#teamsPanel').hidden = need;
  if (need) return;
  const pool = eligible();
  const pub = collegeTeams().filter((t) => t.status === 'published');
  if (!state.draft) { state.draft = draftFromSaved(); state.draftSaved = Boolean(state.draft); state.draftDirty = false; }
  $('#teamsInfo').textContent = `${pool.length} confirmed students not yet in a published team · ${pub.length} published teams` +
    (state.draft ? ` · ${state.draft.length} draft teams${state.draftDirty ? ' (unsaved changes)' : state.draftSaved ? ' (saved)' : ''}` : '');
  $('#reshuffle').disabled = !state.draft;
  $('#saveTeams').disabled = !state.draft || (state.draftSaved && !state.draftDirty);
  $('#publishTeams').disabled = !state.draft || !state.draftSaved || state.draftDirty;
  renderDraft();
  renderKeys();
}
function renderDraft() {
  const box = $('#draftTeams');
  if (!state.draft) { box.innerHTML = '<p class="hint">No draft teams. Generate teams from the confirmed students.</p>'; return; }
  const names = state.draft.map((t) => t.name);
  box.innerHTML = state.draft.map((t, ti) => `<div class="team"><div class="row" style="justify-content:space-between"><strong>${esc(t.name)}</strong><span class="hint">${t.members.length} members</span></div><ul>` +
    t.members.map((m) => `<li><span><strong>${esc(m.name)}</strong> · ${esc(m.role)}</span>
      <select class="small" data-move="${m.id}" data-from="${ti}" aria-label="Move ${esc(m.name)}" style="min-height:30px;padding:2px 6px;width:auto;font-size:12px">
        <option value="">Move to</option>${names.map((n, i) => (i === ti ? '' : `<option value="${i}">${esc(n)}</option>`)).join('')}</select>
      <small>${esc(m.branch)}, ${esc(m.year)} · ${SKILLS.map(([k, l]) => `${l} ${m[k]}`).join(' ')}${m.github ? '' : ' · no GitHub'}</small></li>`).join('') +
    `</ul>${t.warnings.length ? `<div class="w">${t.warnings.map(esc).join('; ')}</div>` : ''}</div>`).join('');
  $$('[data-move]').forEach((sel) => sel.addEventListener('change', () => {
    if (sel.value === '') return;
    const from = Number(sel.dataset.from), to = Number(sel.value);
    const m = state.draft[from].members.find((x) => x.id === sel.dataset.move);
    const pool = eligible();
    const fromMembers = state.draft[from].members.filter((x) => x.id !== m.id);
    const toMembers = [...state.draft[to].members, m];
    state.draft[from] = { ...state.draft[from], ...refreshTeam(fromMembers, pool) };
    state.draft[to] = { ...state.draft[to], ...refreshTeam(toMembers, pool) };
    state.draft = state.draft.filter((t) => t.members.length);
    state.draftDirty = true;
    renderTeams();
  }));
}
function generate() {
  const pool = eligible();
  if (pool.length < 2) { toast('At least 2 confirmed students are needed.'); return; }
  const seed = Math.floor(Math.random() * 1e9);
  const { teams } = makeTeams(pool, { seed });
  const draftIds = new Set(collegeTeams().filter((t) => t.status === 'draft').map((t) => t.name));
  const used = state.teams.map((t) => t.name).filter((n) => !draftIds.has(n));
  const names = pickNames(teams.length, used);
  const start = Math.max(0, ...collegeTeams().filter((t) => t.status === 'published').map((t) => t.number));
  state.draft = teams.map((t, i) => ({ ...t, number: start + i + 1, name: names[i] }));
  state.draftDirty = true; state.draftSaved = false;
  renderTeams();
}
$('#genTeams').addEventListener('click', generate);
$('#reshuffle').addEventListener('click', generate);
$('#saveTeams').addEventListener('click', (e) => run(e.target, async () => {
  const teams = state.draft.map((t) => ({ number: t.number, name: t.name, members: t.members.map((m) => ({ student: m.id, role: m.role })) }));
  const r = await staffCall({ action: 'save_teams', college_id: state.college, teams });
  toast(`${r.teams} draft teams saved`);
  state.draft = null; await loadAll();
}));
$('#publishTeams').addEventListener('click', async (e) => {
  const n = state.draft.length, m = state.draft.reduce((a, t) => a + t.members.length, 0);
  if (!(await confirmAction('Publish teams', `This emails ${m} students in ${n} teams at ${esc(collegeName(state.college))} their team, teammates and role. Teams can't be changed after this.`, 'Publish and email'))) return;
  run(e.target, async () => {
    const r = await staffCall({ action: 'publish_teams', college_id: state.college });
    toast(`${r.teams} teams published, ${r.emails_sent} emails sent${r.emails_failed ? `, ${r.emails_failed} failed: use Resend team emails` : ''}`);
    state.draft = null; await loadAll();
  });
});
function renderKeys() {
  const pub = collegeTeams().filter((t) => t.status === 'published');
  $('#keyTable').innerHTML = `<thead><tr><th>Team</th><th>Key holder</th><th>Key</th><th>Emailed</th><th>Set or replace key</th></tr></thead><tbody>` +
    (pub.length ? pub.map((t) => {
      const ms = state.students.filter((s) => s.team_id === t.id);
      const holder = ms.find((s) => s.team_role === KEY_ROLE) ?? ms[0];
      return `<tr><td>${esc(t.name)}<br><span class="hint">${ms.length} members</span></td><td>${esc(holder?.name ?? '')}<br><span class="hint">${esc(holder?.email ?? '')}</span></td>
        <td>${t.key_last4 ? `…${esc(t.key_last4)}` : '<span class="hint">none</span>'}</td><td>${t.key_sent_at ? fmtDate(t.key_sent_at) : '<span class="hint">no</span>'}</td>
        <td><div class="row"><label class="sr" for="k-${t.id}">Key for ${esc(t.name)}</label><input type="password" id="k-${t.id}" placeholder="sk-..." autocomplete="off" style="width:220px">
        <button class="small" data-key="${t.id}">Save</button></div></td></tr>`;
    }).join('') : '<tr><td colspan="5" class="hint">No published teams yet.</td></tr>') + '</tbody>';
  $$('[data-key]').forEach((b) => b.addEventListener('click', () => run(b, async () => {
    const input = $(`#k-${b.dataset.key}`);
    const r = await staffCall({ action: 'set_key', team_id: b.dataset.key, key: input.value.trim() });
    input.value = ''; toast(`Key …${r.last4} saved`); await loadAll();
  })));
}
$('#resendTeams').addEventListener('click', (e) => run(e.target, async () => {
  const r = await staffCall({ action: 'resend_team_emails', college_id: state.college });
  toast(`${r.emails_sent} team emails sent${r.emails_failed ? `, ${r.emails_failed} failed` : ''}`);
}));
$('#sendKeys').addEventListener('click', async (e) => {
  if (!(await confirmAction('Email keys', 'Each published team whose key is saved and not yet emailed gets one email, to its key holder only.', 'Send'))) return;
  run(e.target, async () => {
    const r = await staffCall({ action: 'send_keys', college_id: state.college });
    toast(`${r.sent} keys emailed${r.failed.length ? `; failed: ${r.failed.join(', ')}` : ''}${r.teams_without_key ? `; ${r.teams_without_key} teams have no key yet` : ''}`);
    await loadAll();
  });
});
$('#deleteKeys').addEventListener('click', async (e) => {
  if (!(await confirmAction('Delete keys', `Delete every stored key for ${esc(collegeName(state.college))}? Do this after the cohort ends, and also revoke the keys in OpenAI.`, 'Delete keys', true))) return;
  run(e.target, async () => { const r = await staffCall({ action: 'delete_keys', college_id: state.college }); toast(`${r.deleted} keys deleted`); await loadAll(); });
});

// ------------------------------------------------------------ colleges
const COLLEGE_FIELDS = [
  ['id', 'Short id', 'lowercase, e.g. gvp'], ['name', 'College name'], ['payer', 'Who pays'], ['payee_name', 'Name on the account'],
  ['upi_id', 'UPI ID'], ['qr_image_url', 'Bank-issued QR image link', 'optional; without it the page draws a QR from the UPI ID'],
  ['bank_account_name', 'Bank account name'], ['bank_name', 'Bank and branch'], ['bank_account_number', 'Account number'], ['bank_ifsc', 'IFSC'],
  ['cash_at', 'Cash counter', 'where and when; leave empty if no cash'], ['seat_limit', 'Seat limit', 'optional'],
];
function renderColleges() {
  $('#collegeTable').innerHTML = `<thead><tr><th>College</th><th>Who pays</th><th>UPI</th><th>Bank</th><th>Cash</th><th class="num">Seats</th><th></th></tr></thead><tbody>` +
    state.colleges.map((c) => `<tr><td>${esc(c.name)}<br><span class="hint">${esc(c.id)}${c.active ? '' : ' · inactive'}</span></td><td>${c.payer === 'college' ? 'College' : 'Students'}</td>
      <td>${esc(c.upi_id ?? '')}</td><td>${esc(c.bank_account_number ? `${c.bank_name ?? ''} ${c.bank_account_number}` : '')}</td><td>${esc(c.cash_at ?? '')}</td>
      <td class="num">${c.seat_limit ?? ''}</td><td><button class="small ghost" data-edit="${esc(c.id)}">Edit</button></td></tr>`).join('') + '</tbody>';
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => editCollege(state.colleges.find((c) => c.id === b.dataset.edit))));
}
$('#addCollege').addEventListener('click', () => editCollege(null));
function editCollege(c) {
  const v = (k) => esc(c?.[k] ?? '');
  const body = `<form id="colForm" class="grid">${COLLEGE_FIELDS.map(([k, l, h]) => k === 'payer'
    ? `<label class="f">${l}<select name="payer"><option value="students"${c?.payer !== 'college' ? ' selected' : ''}>Students pay the college</option><option value="college"${c?.payer === 'college' ? ' selected' : ''}>College pays for its students</option></select></label>`
    : `<label class="f">${l}${h ? ` <small>${h}</small>` : ''}<input type="${k === 'seat_limit' ? 'number' : 'text'}" name="${k}" value="${v(k)}"${k === 'id' && c ? ' readonly' : ''}></label>`).join('')}
    <label class="check full"><input type="checkbox" name="active"${c?.active === false ? '' : ' checked'}> Shown on the registration page</label></form>`;
  dialog(c ? `Edit ${c.name}` : 'Add college', body, [{ label: 'Cancel', value: null, ghost: true }, { label: 'Save', onClick: (done) => run(null, async () => {
    const f = new FormData($('#colForm'));
    const college = Object.fromEntries(f.entries()); college.active = f.get('active') === 'on';
    await staffCall({ action: 'save_college', college }); toast('College saved'); done(null); await loadAll();
  }) }]);
}

// ------------------------------------------------------------ staff
async function renderStaff() {
  const { data } = await sb.from('staff').select('*').order('role').order('email');
  $('#staffTable').innerHTML = `<thead><tr><th>Email</th><th>Name</th><th>Role</th><th>College</th><th></th></tr></thead><tbody>` +
    (data ?? []).map((s) => `<tr><td>${esc(s.email)}</td><td>${esc(s.name ?? '')}</td><td>${s.role === 'admin' ? 'RTIH admin' : 'Coordinator'}</td><td>${esc(s.college_id ? collegeName(s.college_id) : 'All')}</td>
      <td>${s.email === state.me.email ? '' : `<button class="small ghost" data-rm="${esc(s.email)}">Remove</button>`}</td></tr>`).join('') + '</tbody>';
  $$('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
    if (await confirmAction('Remove staff', `Remove ${esc(b.dataset.rm)}? They lose access at once.`, 'Remove', true)) {
      run(b, async () => { await staffCall({ action: 'remove_staff', email: b.dataset.rm }); toast('Removed'); renderStaff(); });
    }
  }));
}
$('#staffForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  run(e.submitter, async () => { await staffCall({ action: 'add_staff', ...f }); toast('Staff added'); e.target.reset(); renderStaff(); });
});

// ------------------------------------------------------------ emails
async function renderEmails() {
  let q = sb.from('email_log').select('*').order('created_at', { ascending: false }).limit(300);
  if (state.college) q = q.eq('college_id', state.college);
  const { data } = await q;
  $('#emailTable').innerHTML = `<thead><tr><th>When</th><th>To</th><th>Email</th><th>Status</th></tr></thead><tbody>` +
    (data ?? []).map((m) => `<tr><td>${fmtDate(m.created_at)}</td><td>${esc(m.to_email)}</td><td>${esc(m.kind)}</td>
      <td><span class="badge ${m.status === 'sent' ? 'confirmed' : m.status === 'failed' ? 'rejected' : 'registered'}">${esc(m.status)}</span>${m.error ? `<br><span class="hint">${esc(m.error)}</span>` : ''}</td></tr>`).join('') + '</tbody>';
}

// ------------------------------------------------------------ settings
function renderSettings() {
  const f = $('#settingsForm'), s = state.settings ?? {};
  for (const el of f.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = Boolean(s[el.name]); else el.value = s[el.name] ?? '';
  }
}
$('#settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const settings = Object.fromEntries(fd.entries()); settings.registration_open = fd.get('registration_open') === 'on';
  run(e.submitter, async () => { await staffCall({ action: 'save_settings', settings }); toast('Settings saved'); await loadAll(); });
});
