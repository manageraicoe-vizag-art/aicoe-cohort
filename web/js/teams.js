// Mixed team formation, run in the admin's browser. Same idea as the toolkit's team_formation.py:
// spread strong coders, cover the skills each team needs, mix branches and years, keep friends apart,
// and make sure the person who looks after the API key is comfortable with GitHub.

export const ROLES = ['Infra and testing', 'Retrieval', 'Data', 'Context and prompt', 'Demo and docs'];
export const KEY_ROLE = ROLES[0];

export const TEAM_NAMES = [
  // Indian rivers
  'Godavari', 'Krishna', 'Kaveri', 'Narmada', 'Ganga', 'Yamuna', 'Brahmaputra', 'Mahanadi', 'Tapti', 'Sabarmati',
  'Pennar', 'Tungabhadra', 'Sharavathi', 'Periyar', 'Vaigai', 'Chenab', 'Jhelum', 'Beas', 'Sutlej', 'Teesta',
  'Damodar', 'Chambal', 'Betwa', 'Gandak', 'Kosi', 'Ghaghara', 'Indravati', 'Sileru', 'Nagavali', 'Vamsadhara',
  'Sarada', 'Gosthani', 'Musi', 'Manjira', 'Bhima', 'Ghataprabha', 'Malaprabha', 'Kabini', 'Hemavati', 'Bhavani',
  // ISRO missions and satellites
  'Aryabhata', 'Bhaskara', 'Rohini', 'Chandrayaan', 'Mangalyaan', 'Aditya', 'Astrosat', 'Gaganyaan', 'Cartosat', 'Oceansat',
  'Resourcesat', 'Kalpana', 'Bhuvan', 'Insat', 'Gsat', 'Navic', 'Risat', 'Megha', 'Saral', 'Scatsat',
].map((n) => `Team ${n}`);

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const strength = (s) => s.coding * 2 + s.data + s.ui + s.writing + s.presenting + s.github_comfort;
const hasGit = (s) => Boolean(s.github);

export function knowsPairs(students) {
  const byEmail = new Map(students.map((s) => [s.email.toLowerCase(), s.id]));
  const pairs = new Set();
  for (const s of students) {
    for (const e of (s.knows || '').split(/[,\s;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      const other = byEmail.get(e);
      if (other && other !== s.id) pairs.add([s.id, other].sort().join('|'));
    }
  }
  return pairs;
}

function teamCost(team, pairs, mean) {
  if (!team.length) return 0;
  let c = 0;
  const max = (k) => Math.max(...team.map((s) => s[k]));
  if (max('coding') < 3) c += 6;
  if (max('coding') < 2) c += 6;
  if (max('presenting') < 3) c += 3;
  if (max('data') < 2) c += 3;
  if (!team.some(hasGit)) c += 6;
  const branches = {}, years = new Set();
  for (const s of team) { branches[s.branch] = (branches[s.branch] || 0) + 1; years.add(s.year); }
  for (const n of Object.values(branches)) if (n > 1) c += 1.5 * (n - 1);
  if (team.length > 2 && years.size === 1) c += 1;
  for (let i = 0; i < team.length; i++) for (let j = i + 1; j < team.length; j++) {
    if (pairs.has([team[i].id, team[j].id].sort().join('|'))) c += 20;
  }
  const d = team.reduce((a, s) => a + strength(s), 0) / team.length - mean;
  return c + d * d * 0.3;
}

function permutations(xs) {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

const roleScore = {
  'Infra and testing': (s) => s.github_comfort * 2 + s.coding + (hasGit(s) ? 0 : -10),
  Retrieval: (s) => s.coding * 2 + s.data,
  Data: (s) => s.data * 2 + s.writing,
  'Context and prompt': (s) => s.writing + s.ui + s.presenting,
  'Demo and docs': (s) => s.presenting * 2 + s.writing,
};

export function assignRoles(team) {
  const roles = ROLES.slice(0, Math.min(team.length, ROLES.length));
  while (roles.length < team.length) roles.push('Member');
  let best = null, bestScore = -Infinity;
  for (const p of permutations(roles)) {
    const sc = p.reduce((a, r, i) => a + (roleScore[r] ? roleScore[r](team[i]) : 0), 0);
    if (sc > bestScore) { bestScore = sc; best = p; }
  }
  return team.map((s, i) => ({ ...s, role: best[i] }));
}

export function teamWarnings(team, pairs) {
  const w = [];
  if (!team.some((s) => s.coding >= 3)) w.push('no confident coder');
  if (!team.some(hasGit)) w.push('nobody has GitHub yet');
  const holder = team.find((s) => s.role === KEY_ROLE);
  if (holder && !hasGit(holder)) w.push('key holder has no GitHub');
  for (let i = 0; i < team.length; i++) for (let j = i + 1; j < team.length; j++) {
    if (pairs.has([team[i].id, team[j].id].sort().join('|'))) w.push(`${team[i].name} and ${team[j].name} know each other`);
  }
  if (team.length > 2 && new Set(team.map((s) => s.branch)).size === 1) w.push('all from one branch');
  return w;
}

/** students: [{id, name, email, branch, year, github, knows, coding, data, ui, writing, presenting, github_comfort}] */
export function makeTeams(students, { seed = 1, size = 4, iterations = 20000 } = {}) {
  const n = students.length;
  if (!n) return { teams: [], cost: 0 };
  const rand = rng(seed);
  const pairs = knowsPairs(students);
  const k = Math.max(1, Math.floor(n / size));
  const mean = students.reduce((a, s) => a + strength(s), 0) / n;

  // shuffle (so equal students are ordered differently per seed), then snake draft by strength
  const pool = students.map((s) => ({ s, r: rand() })).sort((a, b) => strength(b.s) - strength(a.s) || a.r - b.r).map((x) => x.s);
  const teams = Array.from({ length: k }, () => []);
  pool.forEach((s, i) => {
    const round = Math.floor(i / k), pos = i % k;
    teams[round % 2 === 0 ? pos : k - 1 - pos].push(s);
  });

  // improve by swapping members between teams (simulated annealing)
  let costs = teams.map((t) => teamCost(t, pairs, mean));
  let temp = 2;
  for (let it = 0; it < iterations && k > 1; it++) {
    const a = Math.floor(rand() * k);
    let b = Math.floor(rand() * (k - 1)); if (b >= a) b++;
    const i = Math.floor(rand() * teams[a].length), j = Math.floor(rand() * teams[b].length);
    const ta = teams[a].slice(), tb = teams[b].slice();
    [ta[i], tb[j]] = [tb[j], ta[i]];
    const ca = teamCost(ta, pairs, mean), cb = teamCost(tb, pairs, mean);
    const delta = ca + cb - costs[a] - costs[b];
    if (delta <= 0 || rand() < Math.exp(-delta / temp)) { teams[a] = ta; teams[b] = tb; costs[a] = ca; costs[b] = cb; }
    temp = Math.max(0.01, temp * 0.9996);
  }

  const out = teams.map((t) => {
    const withRoles = assignRoles(t);
    return { members: withRoles, warnings: teamWarnings(withRoles, pairs) };
  });
  return { teams: out, cost: costs.reduce((a, c) => a + c, 0) };
}

/** Pick unused names in list order, then numbered fallbacks. */
export function pickNames(count, used) {
  const taken = new Set(used);
  const names = [];
  for (const n of TEAM_NAMES) { if (names.length === count) break; if (!taken.has(n)) { names.push(n); taken.add(n); } }
  let i = 1;
  while (names.length < count) { const n = `Team ${i++}`; if (!taken.has(n)) { names.push(n); taken.add(n); } }
  return names;
}

/** After a manual move: recompute roles and warnings for one team. */
export function refreshTeam(members, allStudents) {
  const withRoles = assignRoles(members.map(({ role, ...m }) => m));
  return { members: withRoles, warnings: teamWarnings(withRoles, knowsPairs(allStudents)) };
}
