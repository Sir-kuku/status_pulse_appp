const $ = (selector, root = document) => root.querySelector(selector);
const E = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const paths = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  monitors: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  incidents: '<path d="m12 3 10 17H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
  alerts: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-9 12a3 3 0 0 0 6 0"/>',
  team: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3"/>',
  settings: '<path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5m10-5a8 8 0 0 0-13-2M5 17a8 8 0 0 0 13 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.monitors}</svg>`;
const names = { overview: 'Overview', monitors: 'Monitors', incidents: 'Incidents', alerts: 'Alerts', team: 'Team', settings: 'Project settings', operations: 'Operations' };
const labels = { operational: 'Operational', degraded: 'Degraded', outage: 'Outage', unknown: 'Awaiting checks', paused: 'Paused', investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved', pending: 'Pending', queued: 'Queued', sent: 'Sent to provider', delivered: 'Delivered', failed: 'Failed', succeeded: 'Succeeded' };
const date = value => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not checked yet';
const badge = status => `<span class="badge ${E(Object.hasOwn(labels, status) ? status : 'unknown')}">${E(labels[status] || status)}</span>`;
const store = { get(key) { try { return sessionStorage.getItem(key); } catch { return null; } }, set(key, value) { try { if (value == null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch { /* In-memory sessions still work when storage is unavailable. */ } } };
const state = { token: store.get('status-pulse-session'), user: null, projects: [], projectId: store.get('status-pulse-project'), page: 'overview', services: [], incidents: [], alerts: [], checks: {}, members: [], generation: 0, authMode: 'register', authOptions: null, inviteToken: store.get('status-pulse-invitation') };
const accountFragments = ['invite', 'oauth_code', 'auth_error', 'verify_email', 'reset_password'];
function readAccountLink() {
  const link = new URLSearchParams(location.hash.slice(1));
  if (accountFragments.some(key => link.has(key))) history.replaceState(null, '', location.pathname + location.search);
  if (link.has('invite')) { state.inviteToken = link.get('invite'); store.set('status-pulse-invitation', state.inviteToken); }
  return link;
}
const simulatedMail = () => state.authOptions?.email?.mode === 'simulation';
const emailAvailable = () => state.authOptions?.email?.enabled === true;
const eyeButton = id => `<button type="button" class="password-toggle" data-password-toggle="${id}" aria-label="Show password" aria-pressed="false" title="Show password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path class="eye-slash" d="m3 3 18 18"/></svg></button>`;
const providerIcon = id => id === 'google' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.41 13.92a6 6 0 0 1 0-3.84V7.49H3.07a10 10 0 0 0 0 9.02l3.34-2.59Z"/><path fill="#EA4335" d="M12 5.96c1.47 0 2.79.5 3.83 1.51l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59C7.2 7.72 9.4 5.96 12 5.96Z"/></svg>' : '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.82.09-.64.35-1.08.64-1.33-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02A9.6 9.6 0 0 1 12 6.82a9.6 9.6 0 0 1 2.5.34c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>';
function authMessage(message) { $('#auth-message').textContent = message; $('#auth-message').hidden = !message; }
function renderAuthOptions() {
  const providers = state.authOptions?.providers || [];
  $('#auth-providers').innerHTML = providers.map(provider => `<a class="button provider-button" href="${E(provider.startUrl)}">${providerIcon(provider.id)}Continue with ${E(provider.name)}</a>`).join('');
  $('#auth-providers').hidden = !providers.length; $('#auth-divider').hidden = !providers.length;
}
let toastTimer;
function toast(message, error = false) { const el = $('#toast'); if ($('#modal').open) $('#modal').append(el); else document.body.append(el); el.textContent = message; el.classList.toggle('error', error); el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, error ? 9000 : 6500); }
function project() { return state.projects.find(item => item._id === state.projectId); }
function owner() { return project()?.myRole === 'owner'; }
function responder() { return ['owner', 'responder'].includes(project()?.myRole); }
function projectPath() { if (!project()) throw new Error('Choose a project first.'); return `/api/projects/${encodeURIComponent(state.projectId)}`; }
async function api(path, method = 'GET', body) {
  const requestToken = state.token;
  const response = await fetch(path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000), cache: 'no-store' });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    if (response.status === 401 && requestToken && requestToken === state.token && !['/api/auth/login', '/api/auth/register', '/api/auth/oauth/exchange'].includes(path)) { showAuth(); authMode('login'); }
    const fields = data?.error?.fields?.map(field => `${field.path}: ${field.message}`).join(' ');
    throw new Error(fields || data?.error?.message || `Request failed (${response.status}).`);
  }
  return data;
}
function showAuth() { state.generation++; state.token = null; state.user = null; state.projects = []; state.services = []; state.incidents = []; state.alerts = []; state.checks = {}; state.members = []; state.page = 'overview'; store.set('status-pulse-session', null); $('#workspace').hidden = true; $('#auth-screen').hidden = false; $('#modal').close(); sidebar(false); }
function authMode(mode) {
  state.authMode = mode;
  const register = mode === 'register';
  $('#auth-title').textContent = register ? 'Let’s get you set up.' : 'Welcome back.';
  $('#auth-description').textContent = register ? 'Create an account to start managing your services.' : 'Sign in to keep an eye on your services.';
  $('#name-field').hidden = !register; $('[name="name"]').required = register;
  $('#password').minLength = register ? 15 : 1; $('#password').autocomplete = register ? 'new-password' : 'current-password';
  $('#password').placeholder = register ? 'At least 15 characters' : 'Enter your password'; $('#password-hint').hidden = !register;
  $('#password').type = 'password'; const reveal = $('[data-password-toggle="password"]'); reveal.setAttribute('aria-pressed', 'false'); reveal.setAttribute('aria-label', 'Show password'); reveal.title = 'Show password';
  $('#forgot-password').hidden = register;
  $('#auth-submit').innerHTML = `${register ? 'Create your account' : 'Sign in to your workspace'} <span>→</span>`;
  for (const value of ['register', 'login']) { $(`#${value}-tab`).classList.toggle('selected', value === mode); $(`#${value}-tab`).setAttribute('aria-pressed', String(value === mode)); }
  $('#auth-error').hidden = true;
}
$('#register-tab').addEventListener('click', () => authMode('register'));
$('#login-tab').addEventListener('click', () => authMode('login'));
$('#forgot-password').addEventListener('click', () => forgotPasswordDialog());
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault(); const submit = $('#auth-submit'); submit.disabled = true; $('#auth-error').hidden = true;
  const data = new FormData(event.currentTarget);
  try {
    const body = { email: data.get('email'), password: data.get('password'), ...(state.authMode === 'register' ? { name: data.get('name') } : {}) };
    const result = await api(`/api/auth/${state.authMode}`, 'POST', body); state.token = result.token; state.user = result.user; store.set('status-pulse-session', state.token); $('#password').value = '';
    await enterWorkspace();
    if (state.authMode === 'register' && emailAvailable() && !simulatedMail() && !state.user.emailVerified) toast('Your workspace is ready. Check your email to verify your address.');
  } catch (error) { $('#auth-error').textContent = error.message; $('#auth-error').hidden = false; }
  finally { submit.disabled = false; }
});
$('#logout').addEventListener('click', async () => { try { await api('/api/auth/logout', 'POST', {}); showAuth(); authMode('login'); } catch (error) { toast(error.message, true); } });
$('#project-select').addEventListener('change', async event => { state.projectId = event.target.value; store.set('status-pulse-project', state.projectId); state.page = 'overview'; await loadData().catch(error => toast(error.message, true)); });
$('#new-project').addEventListener('click', () => projectDialog());
$('#close-modal').addEventListener('click', () => $('#modal').close());
function sidebar(open) { $('#workspace').classList.toggle('sidebar-open', open); $('#sidebar-toggle')?.setAttribute('aria-expanded', String(open)); if ($('#sidebar-backdrop')) $('#sidebar-backdrop').hidden = !open; $('.main-wrap').inert = open && matchMedia('(max-width: 760px)').matches; if (open) $('#project-select').focus(); }
$('#sidebar-toggle')?.addEventListener('click', () => sidebar(!$('#workspace').classList.contains('sidebar-open')));
$('#sidebar-backdrop')?.addEventListener('click', () => sidebar(false));
matchMedia('(max-width: 760px)').addEventListener('change', () => sidebar(false));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('#workspace').classList.contains('sidebar-open')) { sidebar(false); $('#sidebar-toggle')?.focus(); } });
$('#modal').addEventListener('click', event => { if (event.target === $('#modal') && event.clientX) { const rect = $('#modal').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('#modal').close(); } });

async function enterWorkspace() {
  $('#auth-screen').hidden = true; $('#workspace').hidden = false;
  $('#account-name').textContent = state.user.name; $('#avatar').textContent = state.user.name.split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase();
  await loadProjects(); void checkHealth();
  if (state.inviteToken) inviteDialog(true, state.inviteToken);
}
async function checkHealth() {
  try { const result = await api('/health/ready'); $('#connection').textContent = result.status === 'ready' ? 'API connected' : 'Connection unavailable'; $('#connection').classList.toggle('offline', result.status !== 'ready'); }
  catch { $('#connection').textContent = 'Connection unavailable'; $('#connection').classList.add('offline'); }
}
async function loadProjects() {
  const token = state.token;
  const projects = await collection('/api/projects', 'projects');
  if (token !== state.token || !state.user) return;
  state.projects = projects;
  if (!project()) state.projectId = state.projects[0]?._id || null;
  store.set('status-pulse-project', state.projectId);
  $('#project-select').innerHTML = state.projects.length ? state.projects.map(item => `<option value="${E(item._id)}" ${item._id === state.projectId ? 'selected' : ''}>${E(item.name)}</option>`).join('') : '<option>No projects yet</option>';
  await loadData();
}
// Fetch each API page so project totals and controls never silently omit record 101.
async function collection(path, key) {
  const items = [];
  for (let offset = 0; offset <= 10000; offset += 100) {
    const data = await api(`${path}?limit=100&offset=${offset}`); items.push(...data[key]);
    if (data[key].length < 100) return items;
  }
  throw new Error('This collection exceeds the dashboard limit. Use the paginated API to review older records.');
}
async function loadData(quiet = false) {
  const generation = ++state.generation;
  if (!quiet) $('#page-content').innerHTML = '<div class="loading">Loading your workspace…</div>';
  if (!project()) { state.services = []; state.incidents = []; state.alerts = []; state.checks = {}; render(); if (state.page === 'operations') await loadOperations(generation); return; }
  try {
    const base = projectPath();
    const [services, incidents, alerts] = await Promise.all([collection(`${base}/services`, 'services'), collection(`${base}/incidents`, 'items'), collection(`${base}/alerts`, 'items')]);
    if (generation !== state.generation || !state.user) return;
    state.services = services; state.incidents = incidents; state.alerts = alerts; state.checks = {};
    if (state.page === 'team' && owner()) state.members = await collection(`${base}/members`, 'members');
    if (generation !== state.generation || !state.user) return;
    render(); $('#last-sync').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    if (state.page === 'operations') await loadOperations(generation);
    if (state.page === 'overview') {
      const checks = await Promise.all(state.services.slice(0, 6).map(async service => [service._id, (await api(`${base}/services/${service._id}/checks?limit=30`)).results]));
      if (generation !== state.generation || !state.user) return;
      state.checks = Object.fromEntries(checks); render();
    }
  } catch (error) {
    if (generation !== state.generation) return;
    if (!quiet) $('#page-content').innerHTML = `<div class="panel empty-state"><h3>We couldn’t load this workspace.</h3><p>${E(error.message)}</p><button class="button" data-action="refresh">Try again</button></div>`;
    else toast(error.message, true);
  }
}
function render() {
  const current = project(); if (['team', 'settings'].includes(state.page) && !owner()) state.page = 'overview';
  const allowed = owner() ? ['overview', 'monitors', 'incidents', 'alerts', 'team', 'settings'] : ['overview', 'monitors', 'incidents', 'alerts'];
  if (state.user?.platformRole === 'admin') allowed.push('operations');
  if (!allowed.includes(state.page)) state.page = 'overview';
  $('#navigation').innerHTML = allowed.map(page => `<button type="button" class="nav-item ${state.page === page ? 'active' : ''}" ${state.page === page ? 'aria-current="page"' : ''} data-action="navigate" data-page="${page}">${icon(page)}${names[page]}${page === 'incidents' && state.incidents.some(item => item.active) ? `<span class="nav-badge">${state.incidents.filter(item => item.active).length}</span>` : ''}</button>`).join('');
  $('#breadcrumb').textContent = names[state.page]; $('#account-role').textContent = current?.myRole || 'Your account';
  const descriptions = { overview: 'A clear view of your services and what needs your attention.', monitors: 'Keep track of the endpoints your users rely on.', incidents: 'Track the response, from investigation to resolution.', alerts: 'Stay on top of incidents and acknowledge the ones you own.', team: 'Give your team the right access to respond.', settings: 'Manage visibility, your project, and your plan.', operations: 'Worker health and delivery failures across the platform.' };
  $('#page-heading').innerHTML = `<div><h1>${names[state.page]}</h1><p>${descriptions[state.page]}</p></div><div class="heading-actions">${current?.publicEnabled ? `<a class="button" href="/status/${encodeURIComponent(current.slug)}" target="_blank" rel="noopener">Public status ↗</a>` : ''}<button class="button" data-action="refresh" aria-label="Refresh workspace">${icon('refresh')} Refresh</button>${owner() && ['overview', 'monitors'].includes(state.page) ? `<button class="button primary" data-action="add-service">${icon('plus')} Add monitor</button>` : ''}${responder() && state.page === 'incidents' ? `<button class="button primary" data-action="add-incident">${icon('plus')} Report incident</button>` : ''}</div>`;
  if (state.page === 'operations') { $('#page-content').innerHTML = '<div class="loading">Loading platform operations…</div>'; return; }
  if (!current) { $('#page-content').innerHTML = `<section class="onboarding"><span class="feature-icon">◎</span><h2>A little setup. A lot more visibility.</h2><p>Create your first project to bring your monitors, incident updates, and public status page together.</p><div class="onboarding-actions"><button class="button primary" data-action="add-project">Create a project →</button><button class="button" data-action="example-project">Create example project</button></div><p class="field-hint">The example creates two real monitors in your account. Results appear after a monitoring worker runs the checks.</p></section>`; return; }
  const views = { overview: overview, monitors: monitors, incidents: incidents, alerts: alerts, team: team, settings: settings };
  $('#page-content').innerHTML = views[state.page]();
  if (state.page === 'monitors') $('#monitor-search').addEventListener('input', event => { const term = event.target.value.toLowerCase(); document.querySelectorAll('[data-monitor-row]').forEach(row => { row.hidden = !row.textContent.toLowerCase().includes(term); }); });
  if (state.page === 'settings') wireSettings();
}
const empty = (title, message, compact = false) => `<div class="empty-state ${compact ? 'compact' : ''}"><span class="empty-icon">◎</span><h3>${E(title)}</h3><p>${E(message)}</p></div>`;
function overall() { const statuses = state.services.filter(item => item.enabled).map(item => item.status); return statuses.includes('outage') ? 'outage' : statuses.includes('degraded') ? 'degraded' : !statuses.length || statuses.includes('unknown') ? 'unknown' : 'operational'; }
function bars(service) { const results = (state.checks[service._id] || []).slice().reverse(); return `<div class="mini-bars" aria-label="${results.length} recent check results">${Array.from({ length: 30 - results.length }, () => '<i class="empty"></i>').join('')}${results.map(item => `<i class="${item.success ? 'pass' : 'fail'}" title="${E(`${date(item.checkedAt)} · ${item.success ? 'Success' : 'Failure'}`)}"></i>`).join('')}</div><div class="bar-caption"><span>${results.length ? 'Recent recorded checks' : 'Waiting for recorded checks'}</span><span>${results.length ? `${results.length} results` : 'No data yet'}</span></div>`; }
function serviceRow(service) { return `<div class="service-row"><span class="service-icon">↗</span><div class="service-main"><button class="service-name" data-action="service-details" data-id="${E(service._id)}">${E(service.name)}</button><div class="service-url">${E(service.url)}</div>${bars(service)}</div>${badge(service.enabled ? service.status : 'paused')}</div>`; }
function overview() {
  const status = overall();
  const titles = { operational: 'Your services are looking healthy.', degraded: 'Some services need attention.', outage: 'An outage needs your attention.', unknown: state.services.length ? 'Your monitors are ready. Awaiting results.' : 'Your workspace is ready to monitor.' };
  const notes = { operational: 'The latest checks meet your configured availability thresholds.', degraded: 'Review slow services and follow their recent check history.', outage: 'Review the affected services and update your incident response.', unknown: state.services.length ? 'A running monitoring worker will record checks and calculate availability.' : 'Add your first endpoint to start building a picture of its reliability.' };
  const stats = [['Monitors', state.services.length, 'Services in this project', 'monitors'], ['Operational', state.services.filter(item => item.enabled && item.status === 'operational').length, 'Based on recorded check results', 'check'], ['Open incidents', state.incidents.filter(item => item.active).length, 'Awaiting a resolution', 'incidents'], ['Unacknowledged', state.alerts.filter(item => !item.acknowledgedAt).length, 'Alerts awaiting acknowledgement', 'alerts']];
  return `<section class="hero-status status-${status}"><span class="status-symbol">${icon(status === 'operational' ? 'check' : 'monitors')}</span><div><h2>${titles[status]}</h2><p>${notes[status]}</p></div><span class="hero-right">${E(project().name)}</span></section><section class="stat-grid">${stats.map(([title, value, note, graphic]) => `<div class="stat-card"><div class="stat-top">${title}${icon(graphic)}</div><strong class="stat-value">${value}</strong><div class="stat-note">${note}</div></div>`).join('')}</section><div class="columns"><section class="panel"><div class="panel-header"><div><h2>Service health</h2><p>Recent checks across your monitored endpoints</p></div><button class="button small" data-action="navigate" data-page="monitors">View all →</button></div>${state.services.length ? state.services.slice(0, 6).map(serviceRow).join('') : `${empty('Your first monitor starts here.', 'Add a public HTTP endpoint and choose how often it should be checked.')}<div class="panel-body"><button class="button primary" data-action="add-service" ${!owner() ? 'disabled' : ''}>Add your first monitor</button></div>`}</section><div><section class="panel"><div class="panel-header"><div><h2>Recent incidents</h2><p>Your team’s latest response activity</p></div><button class="button small" data-action="navigate" data-page="incidents">View all →</button></div>${state.incidents.length ? state.incidents.slice(0, 4).map(incidentRow).join('') : empty('No incidents reported.', 'New incidents and response updates will appear here.', true)}</section><section class="panel"><div class="panel-header"><h2>A shared source of truth</h2><span class="service-icon">◈</span></div><div class="panel-body"><p class="muted">Give your users a clear view of service health and incident updates with a public status page.</p>${project().publicEnabled ? `<a class="button" href="/status/${encodeURIComponent(project().slug)}" target="_blank" rel="noopener">Open public status page ↗</a>` : owner() ? '<button class="button" data-action="navigate" data-page="settings">Set up your status page →</button>' : '<p class="field-hint">The project owner can enable the public status page.</p>'}</div></section></div></div>`;
}
function monitors() {
  return `<section class="panel"><div class="toolbar"><input id="monitor-search" type="search" placeholder="Search monitors…" aria-label="Search monitors"><span class="muted">${state.services.length} monitors</span></div>${state.services.length ? `<div class="table-wrap"><table class="service-table"><thead><tr><th>MONITOR</th><th>STATUS</th><th>INTERVAL</th><th>LAST CHECK</th><th>ACTIONS</th></tr></thead><tbody>${state.services.map(service => `<tr data-monitor-row><td><button class="service-name" data-action="service-details" data-id="${E(service._id)}">${E(service.name)}</button><div class="service-url">${E(service.url)}</div></td><td>${badge(service.enabled ? service.status : 'paused')}</td><td>${service.intervalSeconds}s</td><td class="service-meta">${date(service.lastCheckedAt)}</td><td><div class="actions"><button class="button small" data-action="service-details" data-id="${E(service._id)}">Details</button>${responder() && service.enabled ? `<button class="button small" data-action="queue-check" data-id="${E(service._id)}">Queue check</button>` : ''}${owner() ? `<button class="button small" data-action="edit-service" data-id="${E(service._id)}">Edit</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>` : empty('No monitors yet.', 'Add a monitor to track an HTTP endpoint and see its availability history.')}</section>`;
}
function incidentRow(incident) { const service = state.services.find(item => item._id === incident.serviceId); return `<div class="incident-row"><div class="incident-top">${badge(incident.state)}<span class="service-meta">${date(incident.updatedAt)}</span></div><h3><button class="service-name" data-action="incident-details" data-id="${E(incident._id)}">${E(incident.title)}</button></h3><p>${E(service?.name || 'Archived service')} · ${incident.publicVisible ? 'Public update' : 'Internal incident'}</p></div>`; }
function incidents() { return `<section class="panel"><div class="panel-header"><div><h2>Incident timeline</h2><p>Investigating → Identified → Monitoring → Resolved</p></div><span class="badge">${state.incidents.filter(item => item.active).length} active</span></div>${state.incidents.length ? state.incidents.map(incidentRow).join('') : empty('Nothing to respond to right now.', 'Report an incident when a service needs attention. Your updates will appear here.')}</section>`; }
function alerts() { return `<div class="notice">${simulatedMail() ? 'Development simulation is enabled. Alerts do not send real emails.' : emailAvailable() ? 'Email alerts are sent to verified recipients. Sending and acknowledgement are tracked separately.' : 'Email delivery is not available yet. Alerts remain visible here; the website owner needs to finish email setup.'}</div><section class="panel"><div class="panel-header"><h2>Alert inbox</h2><span class="service-meta">Delivery history</span></div>${state.alerts.length ? state.alerts.map(alert => { const incident = state.incidents.find(item => item._id === alert.incidentId); return `<div class="incident-row"><div class="incident-top"><h3>${E(incident?.title || 'Service alert')}</h3>${badge(alert.deliveryState)}</div><p>${date(alert.createdAt)} · ${alert.attempts || 0} delivery attempts</p><div class="actions"><span class="service-meta">${alert.acknowledgedAt ? `Acknowledged ${date(alert.acknowledgedAt)}` : 'Not acknowledged'}</span>${responder() && !alert.acknowledgedAt ? `<button class="button small" data-action="acknowledge" data-id="${E(alert._id)}">Acknowledge</button>` : ''}${responder() && !['delivered', 'sent'].includes(alert.deliveryState) ? `<button class="button small" data-action="deliver-alert" data-id="${E(alert._id)}">Retry delivery</button>${simulatedMail() ? `<button class="button small" data-action="fail-alert" data-id="${E(alert._id)}">Simulate failure</button>` : ''}` : ''}</div></div>`; }).join('') : empty('Your inbox is clear.', 'Alerts are created when incidents are opened or monitoring detects an outage.')}</section>`; }
function team() { return `<section class="panel"><div class="panel-header"><div><h2>Project members</h2><p>Owners configure. Responders act. Viewers stay informed.</p></div><div class="actions"><button class="button small" data-action="email-activity">Email activity</button><button class="button primary small" data-action="invite">Invite member</button></div></div><div class="table-wrap"><table><thead><tr><th>NAME</th><th>EMAIL</th><th>ROLE</th><th>ACTIONS</th></tr></thead><tbody>${state.members.map(member => `<tr><td>${E(member.name)}</td><td>${E(member.email)}</td><td><span class="badge">${E(member.role)}</span></td><td>${member.role !== 'owner' ? `<button class="button small" data-action="edit-member" data-id="${E(member.userId)}">Manage access</button>` : '<span class="service-meta">Project owner</span>'}</td></tr>`).join('')}</tbody></table></div></section><section class="panel"><div class="panel-header"><h2>Have an invitation?</h2></div><div class="panel-body"><p class="muted">Open your invitation email to join, or enter its code while signed in with the invited address.</p><button class="button" data-action="accept-invite">Enter invitation code</button></div></section>`; }
function settings() { const item = project(); return `<div class="settings-grid"><section class="panel"><div class="panel-header"><h2>Project details</h2></div><form id="settings-form"><label>Project name<input name="name" required maxlength="100" value="${E(item.name)}"></label><label>Public page address<input readonly value="${E(`${location.origin}/status/${item.slug}`)}"></label><label class="checkbox"><input type="checkbox" name="publicEnabled" ${item.publicEnabled ? 'checked' : ''}>Enable this project’s public status page</label><p class="field-hint">Only monitors and incident updates marked public are shown.</p><p class="form-error" role="alert" hidden></p><div class="form-actions"><button class="button primary" type="submit">Save changes</button></div></form></section><section class="panel"><div class="panel-header"><h2>Project plan</h2><span class="badge">Simulation</span></div><div class="panel-body"><h3 class="plan">${item.plan === 'advanced' ? 'Advanced' : 'Free'} <span>plan</span></h3><ul class="plan-list"><li>HTTP endpoint monitoring</li><li>Incidents and response updates</li><li>Public status and subscriptions</li>${item.plan === 'advanced' ? '<li>30-second check intervals</li>' : ''}</ul>${item.plan !== 'advanced' ? '<button class="button" data-action="upgrade">Explore advanced plan →</button>' : ''}<p class="field-hint">Payments are simulated. No money is charged.</p><button class="button small" data-action="payments">Payment history</button></div></section><section class="panel"><div class="panel-header"><h2>Email activity</h2></div><div class="panel-body"><p class="muted">${simulatedMail() ? 'Development email is simulated. Review the test inbox below.' : emailAvailable() ? 'Review invitations, verification messages and service notification progress.' : 'Email delivery is not available yet. Connect an email provider to send invitations and updates.'}</p><button class="button" data-action="email-activity">View email activity</button>${simulatedMail() ? '<button class="button" data-action="inbox">Open simulated inbox</button>' : ''}</div></section><section class="panel"><div class="panel-header"><h2>Project activity</h2></div><div class="panel-body"><p class="muted">See an audit trail of configuration changes and actions taken by your team.</p><button class="button" data-action="audit">View audit trail</button></div></section><section class="panel"><div class="panel-header"><h2>Archive project</h2></div><div class="panel-body"><p class="muted">Stop monitoring and remove public access. Existing records are retained.</p><button class="button danger" data-action="archive-project">Archive this project</button></div></section></div>`; }
function wireSettings() { wireForm('settings-form', async form => { await api(projectPath(), 'PATCH', { name: form.get('name'), publicEnabled: form.has('publicEnabled'), version: project().version }); await loadProjects(); toast('Project settings saved.'); }); }
function modal(title, html) { $('#modal-title').textContent = title; $('#modal-body').innerHTML = html; if (!$('#modal').open) $('#modal').showModal(); }
function formError(form, message) { let error = $('.form-error', form); if (!error) { error = document.createElement('p'); error.className = 'form-error'; error.setAttribute('role', 'alert'); form.append(error); } error.textContent = message; error.hidden = false; }
function wireForm(id, action) { const element = $(`#${id}`); element.addEventListener('submit', async event => { event.preventDefault(); const submit = $('[type="submit"]', element); submit.disabled = true; const error = $('.form-error', element); if (error) error.hidden = true; try { await action(new FormData(element)); } catch (failure) { formError(element, failure.message); } finally { submit.disabled = false; } }); }
const formEnd = text => `<p class="form-error" role="alert" hidden></p><div class="form-actions"><button class="button" type="button" data-action="close">Cancel</button><button class="button primary" type="submit">${text}</button></div>`;
function forgotPasswordDialog() {
  modal('Reset your password', `<p class="muted">Enter your account email and we’ll send a secure link to choose a new password.</p>${emailAvailable() ? '' : '<p class="notice warning">Email delivery is not available yet. The website owner needs to enable it before password recovery can send a message.</p>'}<form id="forgot-form"><label>Email address<input name="email" type="email" autocomplete="email" maxlength="254" value="${E($('#auth-form [name="email"]').value)}" required></label>${formEnd('Send reset link')}</form>`);
  wireForm('forgot-form', async form => { const result = await api('/api/auth/forgot-password', 'POST', { email: form.get('email') }); modal('Check your inbox', `<div class="account-success">${icon('check')}</div><p class="muted">${E(result.message || 'If an account exists for that address, a password reset link will be sent. Check your inbox and spam folder.')}</p>${simulatedMail() ? '<p class="notice">This is a development email simulation. No message reaches a real inbox.</p>' : ''}<button type="button" class="button primary" data-action="close">Back to sign in</button>`); });
}
function resetPasswordDialog(token) {
  modal('Choose a new password', `<p class="muted">Use a long, memorable passphrase that you don’t use anywhere else.</p><form id="reset-form"><label>New password<span class="password-field"><input id="reset-password" name="password" type="password" autocomplete="new-password" minlength="15" maxlength="128" required aria-describedby="reset-hint">${eyeButton('reset-password')}</span></label><p class="field-hint" id="reset-hint">At least 15 characters. After saving, sign in again on your devices.</p>${formEnd('Save new password')}</form>`);
  wireForm('reset-form', async form => { await api('/api/auth/reset-password', 'POST', { token, password: form.get('password') }); showAuth(); authMode('login'); authMessage('Your password has been updated. Sign in with your new password.'); });
}
function accountDialog() {
  const user = state.user;
  const providers = state.authOptions?.providers || [];
  modal('Your account', `<div class="account-profile"><span class="avatar">${E(user.name.split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase())}</span><div><h3>${E(user.name)}</h3><p>${E(user.email)}</p></div></div><section class="account-section"><div class="section-line"><h3>Email address</h3><span class="badge ${user.emailVerified ? 'operational' : 'pending'}">${user.emailVerified ? 'Verified' : 'Not verified'}</span></div><p class="muted">${user.emailVerified ? 'Your email address is confirmed and ready for team invitations.' : 'Confirm that this email belongs to you before inviting teammates.'}</p>${!user.emailVerified ? `<button class="button small" data-action="resend-verification" ${emailAvailable() ? '' : 'disabled'}>Send verification email</button>${!emailAvailable() ? '<p class="field-hint">Email delivery is not available yet. The website owner needs to finish email setup.</p>' : ''}` : ''}</section><section class="account-section"><h3>Connected sign-in methods</h3><p class="muted">Connect a provider with the same verified email address to sign in more easily.</p>${providers.length ? providers.map(provider => { const linked = user.authProviders?.includes(provider.id); return `<div class="provider-row"><span>${providerIcon(provider.id)}${E(provider.name)}</span>${linked ? '<span class="badge operational">Connected</span>' : `<button class="button small" data-action="connect-provider" data-provider="${E(provider.id)}">Connect ${E(provider.name)}</button>`}</div>`; }).join('') : '<p class="field-hint">Additional sign-in providers are not available yet. You can continue using your email and password.</p>'}</section><p class="field-hint">Your color preference is saved on this device. Change it anytime using the theme controls.</p>`);
}
async function emailActivity() {
  const data = await api(`${projectPath()}/email-deliveries?limit=100`);
  modal('Email activity', `<p class="notice">${data.mode === 'simulation' ? 'Development simulation is enabled. These messages are not sent to a real inbox.' : data.mode === 'disabled' ? 'Email delivery is not available yet. The website owner needs to connect an email provider.' : 'Queued messages are waiting to send. Sent to provider means the email service accepted the message; check the recipient’s inbox and spam folder.'}</p>${data.items.length ? data.items.map(item => `<div class="incident-row"><div class="incident-top"><h3>${E(item.subject || item.kind)}</h3>${badge(item.deliveryState)}</div><p>${E(item.to)} · ${date(item.createdAt)} · ${Number(item.attempts || 0)} attempts</p>${item.lastError ? `<p class="form-error">${E(item.lastError)}</p>` : ''}</div>`).join('') : empty('No email activity yet.', 'Invitations, verification messages and service notifications will appear here.', true)}<p class="field-hint">Showing the latest 100 messages.</p>`);
}
function projectDialog() {
  modal('Create a project', `<p class="muted">Group related services and give your team one place to respond.</p><form id="project-form"><label>Project name<input name="name" required maxlength="100" placeholder="e.g. Customer platform"></label><label>Public page slug<input name="slug" required minlength="3" maxlength="60" pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="customer-platform"></label><label class="checkbox"><input name="publicEnabled" type="checkbox" checked>Enable a public status page</label>${formEnd('Create project')}</form>`);
  const name = $('#project-form [name="name"]'), slug = $('#project-form [name="slug"]'); let changed = false; slug.addEventListener('input', () => { changed = true; }); name.addEventListener('input', () => { if (!changed) slug.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); });
  wireForm('project-form', async data => { const result = await api('/api/projects', 'POST', { name: data.get('name'), slug: data.get('slug'), publicEnabled: data.has('publicEnabled') }); state.projectId = result.project._id; state.page = 'overview'; $('#modal').close(); await loadProjects(); toast('Project created. Add your first monitor.'); });
}
async function exampleProject() {
  const result = await api('/api/projects', 'POST', { name: 'Status Pulse Demo', slug: `status-pulse-${Date.now().toString(36)}`, publicEnabled: true });
  state.projectId = result.project._id;
  try {
    for (const service of [{ name: 'Example website', url: 'https://example.com/' }, { name: 'Status Pulse API', url: `${location.origin}/health/ready` }]) {
      // Local URLs are intentionally rejected by the monitor; local demos use another public endpoint.
      if (service.name === 'Status Pulse API' && (!location.hostname.includes('.') || ['localhost', '127.0.0.1'].includes(location.hostname))) { service.name = 'IANA website'; service.url = 'https://www.iana.org/'; }
      await api(`/api/projects/${state.projectId}/services`, 'POST', { ...service, publicVisible: true });
    }
    toast('Example project created. Monitors await checks from your worker.');
  } finally { state.page = 'overview'; await loadProjects(); }
}
function serviceDialog(service) {
  if (!owner()) return toast('Only the project owner can configure monitors.', true);
  modal(service ? 'Edit monitor' : 'Add a monitor', `<p class="muted">Monitor a public HTTP endpoint and define what a healthy response looks like.</p><form id="service-form"><div class="form-grid"><label class="full">Monitor name<input name="name" required maxlength="100" value="${E(service?.name || '')}" placeholder="e.g. Payments API"></label><label class="full">Endpoint URL<input name="url" required type="url" maxlength="2048" value="${E(service?.url || '')}" placeholder="https://example.com/health"></label><label>Method<select name="method"><option ${service?.method !== 'HEAD' ? 'selected' : ''}>GET</option><option ${service?.method === 'HEAD' ? 'selected' : ''}>HEAD</option></select></label><label>Check interval<select name="intervalSeconds">${[...(project().plan === 'advanced' ? [30] : []), 60, 120, 300, 600].map(value => `<option value="${value}" ${(service?.intervalSeconds || 60) === value ? 'selected' : ''}>${value < 60 ? `${value} seconds` : `${value / 60} minute${value > 60 ? 's' : ''}`}</option>`).join('')}</select></label><label>Timeout (milliseconds)<input type="number" name="timeoutMs" min="500" max="10000" required value="${service?.timeoutMs || 5000}"></label><label>Slow response (milliseconds)<input type="number" name="slowThresholdMs" min="1" max="10000" required value="${service?.slowThresholdMs || 1000}"></label><label>Failures before outage<input type="number" name="failureThreshold" min="1" max="10" value="${service?.failureThreshold || 3}" required></label><label>Successes before recovery<input type="number" name="recoveryThreshold" min="1" max="10" value="${service?.recoveryThreshold || 2}" required></label><label>Expected status: minimum<input type="number" name="expectedStatusMin" min="100" max="599" value="${service?.expectedStatusMin || 200}" required></label><label>Expected status: maximum<input type="number" name="expectedStatusMax" min="100" max="599" value="${service?.expectedStatusMax || 299}" required></label></div><label class="checkbox"><input name="enabled" type="checkbox" ${service?.enabled === false ? '' : 'checked'}>Enable monitoring</label><label class="checkbox"><input name="publicVisible" type="checkbox" ${service?.publicVisible === false ? '' : 'checked'}>Show this monitor on the public status page</label>${formEnd(service ? 'Save monitor' : 'Add monitor')}</form>`);
  wireForm('service-form', async data => { const body = { name: data.get('name'), url: data.get('url'), method: data.get('method'), enabled: data.has('enabled'), publicVisible: data.has('publicVisible') }; for (const key of ['intervalSeconds', 'timeoutMs', 'slowThresholdMs', 'failureThreshold', 'recoveryThreshold', 'expectedStatusMin', 'expectedStatusMax']) body[key] = Number(data.get(key)); if (service) body.version = service.configVersion;
    await api(`${projectPath()}/services${service ? `/${service._id}` : ''}`, service ? 'PATCH' : 'POST', body); $('#modal').close(); await loadData(); toast(service ? 'Monitor updated.' : 'Monitor created. Waiting for the worker’s first check.'); });
}
async function serviceDetails(id) {
  const base = `${projectPath()}/services/${encodeURIComponent(id)}`; const currentProject = state.projectId;
  const [record, checks, history] = await Promise.all([api(base), api(`${base}/checks?limit=30`), api(`${base}/history?limit=20`)]);
  if (currentProject !== state.projectId || !state.user) return;
  const service = record.service, results = checks.results; const recent = results[0];
  let chart = empty('No check results yet.', 'Checks are performed by the monitoring worker. Queued checks appear here once processed.', true);
  if (results.length) {
    const points = results.slice().reverse(); const max = Math.max(1, ...points.map(item => item.latencyMs)); const coords = points.map((item, index) => `${points.length === 1 ? 250 : 10 + index / (points.length - 1) * 480},${130 - item.latencyMs / max * 105}`).join(' ');
    chart = `<svg class="chart" viewBox="0 0 500 150" role="img" aria-label="Response times for the latest ${points.length} checks"><path class="chart-grid" d="M0 25h500M0 60h500M0 95h500M0 130h500"/><polyline class="chart-line" points="${coords}"/>${points.length === 1 ? `<circle cx="250" cy="${130 - points[0].latencyMs / max * 105}" r="4" fill="#7254de"/>` : ''}</svg><div class="chart-labels"><span>${date(points[0].checkedAt)}</span><span>Peak ${Math.round(max)} ms</span><span>${date(points.at(-1).checkedAt)}</span></div>`;
  }
  modal(service.name, `<div class="monitor-summary"><p class="muted">${E(service.url)}</p>${badge(service.enabled ? service.status : 'paused')}</div><div class="metric-pair"><div><strong>${recent ? `${Math.round(recent.latencyMs)} ms` : '—'}</strong><span>Latest response time</span></div><div><strong>${recent?.httpStatus ?? '—'}</strong><span>HTTP response code</span></div><div><strong>${service.intervalSeconds}s</strong><span>Check interval</span></div></div>${chart}<div class="form-actions">${responder() && service.enabled ? `<button class="button primary" data-action="queue-check" data-id="${E(id)}">Queue a check</button>` : ''}${responder() ? `<button class="button" data-action="override" data-id="${E(id)}">Manual status override</button>` : ''}</div>${owner() ? `<div class="actions"><button class="button small" data-action="config-history" data-id="${E(id)}">Configuration history</button><button class="button danger small" data-action="archive-service" data-id="${E(id)}">Archive monitor</button></div>` : ''}<h3>Recent check results</h3>${results.length ? `<div class="table-wrap"><table><thead><tr><th>CHECKED</th><th>RESULT</th><th>LATENCY</th></tr></thead><tbody>${results.slice(0, 8).map(result => `<tr><td>${date(result.checkedAt)}</td><td>${E(result.success ? `HTTP ${result.httpStatus}` : result.failureReason || 'Failed')}</td><td>${Math.round(result.latencyMs)} ms</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No recorded results.</p>'}<h3>Status history</h3>${history.history.length ? `<div class="timeline">${history.history.slice(0, 8).map(item => `<div class="timeline-entry"><h4>${E(labels[item.from] || item.from)} → ${E(labels[item.to] || item.to)}</h4><time>${date(item.createdAt)}</time></div>`).join('')}</div>` : '<p class="muted">Status transitions will appear after checks or a manual override.</p>'}`);
}
function incidentDialog() {
  if (!responder()) return toast('A responder or owner can report incidents.', true);
  if (!state.services.length) return toast('Add a monitor before reporting an incident.', true);
  modal('Report an incident', `<p class="muted">Record what’s happening and start a clear response timeline.</p><form id="incident-form"><label>Affected monitor<select name="serviceId">${state.services.map(item => `<option value="${E(item._id)}">${E(item.name)}</option>`).join('')}</select></label><label>Incident title<input name="title" minlength="3" maxlength="200" required placeholder="e.g. Increased response times"></label><label>Initial update<textarea name="message" maxlength="5000" required placeholder="Describe the impact and what your team is investigating."></textarea></label><label class="checkbox"><input type="checkbox" name="publicVisible" checked>Publish to the public status page</label>${formEnd('Open incident')}</form>`);
  wireForm('incident-form', async data => { await api(`${projectPath()}/services/${data.get('serviceId')}/incidents`, 'POST', { title: data.get('title'), message: data.get('message'), publicVisible: data.has('publicVisible') }); $('#modal').close(); await loadData(); toast('Incident opened and an alert created.'); });
}
async function incidentDetails(id) {
  const currentProject = state.projectId; const data = await api(`${projectPath()}/incidents/${encodeURIComponent(id)}?limit=50`); if (currentProject !== state.projectId || !state.user) return; const incident = data.incident; const states = ['investigating', 'identified', 'monitoring', 'resolved']; const options = states.slice(states.indexOf(incident.state), states.indexOf(incident.state) + 2);
  modal(incident.title, `<p class="muted">Opened ${date(incident.createdAt)} · ${incident.publicVisible ? 'Public incident' : 'Internal incident'}</p>${badge(incident.state)}<div class="timeline">${data.updates.slice().reverse().map(update => `<div class="timeline-entry"><h4>${E(labels[update.state])}</h4><time>${date(update.createdAt)} · ${update.publicVisible ? 'Public' : 'Internal'}</time><p>${E(update.message)}</p></div>`).join('')}</div>${incident.active && responder() ? `<form id="update-form"><label>Next status<select name="state">${options.map(value => `<option value="${value}">${labels[value]}</option>`).join('')}</select></label><label>Response update<textarea name="message" maxlength="5000" required placeholder="Share what you’ve learned or the action being taken."></textarea></label><label class="checkbox"><input type="checkbox" name="publicVisible" ${incident.publicVisible ? 'checked' : ''}>Publish this update</label>${formEnd('Post update')}</form>` : '<p class="muted">This timeline is read-only.</p>'}`);
  if ($('#update-form')) wireForm('update-form', async form => { await api(`${projectPath()}/incidents/${id}/updates`, 'POST', { version: incident.version, state: form.get('state'), message: form.get('message'), publicVisible: form.has('publicVisible') }); await loadData(true); await incidentDetails(id); toast('Incident update published.'); });
}
function overrideDialog(id) {
  const service = state.services.find(item => item._id === id); if (!service || !responder()) return;
  modal('Manual status override', `<p class="muted">Set a temporary display status for ${E(service.name)}. Recorded monitoring results are preserved.</p><form id="override-form"><label>Display status<select name="status"><option value="degraded">Degraded</option><option value="outage">Outage</option><option value="operational">Operational</option><option value="unknown">Unknown</option></select></label><label>Reason<textarea name="reason" minlength="5" maxlength="500" required placeholder="Why is an override needed?"></textarea></label><label>Expires in<select name="minutes"><option value="15">15 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option></select></label>${formEnd('Apply override')}</form>${service.override ? `<button class="button danger" data-action="clear-override" data-id="${E(id)}">Clear existing override</button>` : ''}`);
  wireForm('override-form', async form => { await api(`${projectPath()}/services/${id}/override`, 'PUT', { status: form.get('status'), reason: form.get('reason'), expiresAt: new Date(Date.now() + Number(form.get('minutes')) * 60000).toISOString() }); $('#modal').close(); await loadData(); toast('Temporary status override applied.'); });
}
function inviteDialog(accept = false, token = '') {
  const description = accept ? 'Your invitation is ready. Sign in with the invited email address, then confirm to join the project.' : simulatedMail() ? 'Development simulation is enabled. Share the resulting code directly with your teammate; no real email is sent.' : 'We’ll email your teammate a secure invitation to join this project.';
  modal(accept ? 'Accept an invitation' : 'Invite a team member', `<p class="muted">${description}</p>${!accept && !emailAvailable() ? '<p class="notice warning">Email delivery is not available yet. The website owner needs to connect an email provider before invitations can be sent.</p>' : ''}${!accept && emailAvailable() && !simulatedMail() && !state.user.emailVerified ? '<p class="notice warning">Please verify your own email first. <button type="button" class="text-button" data-action="account">Open your account settings</button></p>' : ''}<form id="invite-form">${accept ? `<label>Invitation code<input name="token" required minlength="20" maxlength="200" autocomplete="off" value="${E(token)}"></label>` : '<label>Email address<input name="email" type="email" autocomplete="email" maxlength="254" required></label><label>Project role<select name="role"><option value="responder">Responder — manage incident response</option><option value="viewer">Viewer — view services and incidents</option></select></label>'}${formEnd(accept ? 'Join project' : simulatedMail() ? 'Create invitation' : 'Send invitation')}</form>`);
  wireForm('invite-form', async form => {
    const result = await api(accept ? '/api/invitations/accept' : `${projectPath()}/invitations`, 'POST', Object.fromEntries(form));
    if (accept) { state.inviteToken = null; store.set('status-pulse-invitation', null); $('#modal').close(); await loadProjects(); toast('You joined the project.'); }
    else if (result.simulatedEmail) modal('Invitation created', `<p class="notice">Development simulation: no real email was sent.</p><p class="muted">Share this code with ${E(form.get('email'))}. They must sign in with that email to accept it.</p><p class="token-box">${E(result.simulatedEmail.token)}</p><p class="field-hint">Expires ${date(result.invitation.expiresAt)}.</p>`);
    else modal('Invitation queued', `<div class="account-success">${icon('check')}</div><p class="muted">An invitation for <strong>${E(form.get('email'))}</strong> is queued for email delivery. They can open the link and sign in or create an account with that address.</p><p class="field-hint">Expires ${date(result.invitation.expiresAt)}. Check Email activity for sending progress.</p><button type="button" class="button" data-action="email-activity">View email activity</button>`);
  });
}
async function inbox() { const data = await api(`${projectPath()}/simulated-mail?limit=100`); modal('Simulated inbox', `<p class="notice">No real email is sent. Verification here demonstrates the subscription workflow.</p>${data.items.length ? data.items.map(item => `<div class="incident-row"><h3>${E(item.kind)}</h3><p>${E(item.recipient)} · ${date(item.createdAt)}</p><p class="token-box">${E(item.token)}</p>${item.kind === 'subscription-verification' ? `<button class="button small" data-action="verify-subscription" data-token="${E(item.token)}">Complete simulated verification</button>` : ''}</div>`).join('') : empty('No messages yet.', 'Pending subscription verification and project invitations appear here.', true)}`); }
async function audit() { const data = await api(`${projectPath()}/audit?limit=100`); modal('Project audit trail', `<div class="timeline">${data.events.map(event => `<div class="timeline-entry"><h4>${E(event.action.replaceAll('.', ' · '))}</h4><time>${date(event.createdAt)}</time></div>`).join('') || '<p class="muted">No activity yet.</p>'}</div>`); }

function archiveDialog(kind, id) {
  const item = kind === 'project' ? project() : state.services.find(service => service._id === id);
  if (!item || !owner()) return;
  const path = kind === 'project' ? projectPath() : `${projectPath()}/services/${id}`;
  modal(`Archive ${kind === 'project' ? 'project' : 'monitor'}`, `<p class="muted">Archiving <strong>${E(item.name)}</strong> stops its checks and removes it from public pages. Its history is retained. There is no restore action in this version.</p><form id="archive-form"><label>Type ARCHIVE to confirm<input name="confirmation" required pattern="ARCHIVE" autocomplete="off" placeholder="ARCHIVE"></label>${formEnd('Archive')}</form>`);
  wireForm('archive-form', async () => { await api(path, 'DELETE'); $('#modal').close(); await loadProjects(); toast('Archived. Historical records are retained.'); });
}
function memberDialog(id) {
  const member = state.members.find(item => item.userId === id); if (!member || member.role === 'owner' || !owner()) return;
  const base = `${projectPath()}/members/${id}`;
  modal('Manage member access', `<p class="muted">Update access for ${E(member.name)} (${E(member.email)}).</p><form id="member-form"><label>Access<select name="role"><option value="responder" ${member.role === 'responder' ? 'selected' : ''}>Responder</option><option value="viewer" ${member.role === 'viewer' ? 'selected' : ''}>Viewer</option><option value="remove">Remove from this project</option></select></label>${formEnd('Save access')}</form>`);
  wireForm('member-form', async form => { const role = form.get('role'); await api(base, role === 'remove' ? 'DELETE' : 'PATCH', role === 'remove' ? undefined : { role }); $('#modal').close(); await loadData(); toast(role === 'remove' ? 'Member removed from the project.' : 'Member role updated.'); });
}
async function configHistory(id) {
  const data = await api(`${projectPath()}/services/${id}/config-versions?limit=50`);
  modal('Configuration history', `<p class="muted">The latest 50 saved versions. Changes remain available for review.</p><div class="timeline">${data.versions.map(item => `<div class="timeline-entry"><h4>Version ${item.version} · ${E(item.config.name)}</h4><time>${date(item.createdAt)}</time><p>${E(item.config.method)} ${E(item.config.url)}<br>Every ${item.config.intervalSeconds}s · timeout ${item.config.timeoutMs}ms<br>${item.config.enabled ? 'Enabled' : 'Paused'} · ${item.config.publicVisible ? 'Public' : 'Private'}</p></div>`).join('')}</div>`);
}
function paymentDialog(existingKey) {
  const key = existingKey || `dashboard-${crypto.randomUUID()}`, base = projectPath();
  modal('Advanced monitoring', `<p class="muted">The advanced plan unlocks 30-second checks. This is a payment simulation; no card details are needed and no money is charged.</p><form id="payment-form"><label>Simulated result<select name="outcome"><option value="success">Successful payment</option><option value="failure">Failed payment</option></select></label><p class="field-hint">A failed payment keeps the current plan. Retrying from payment history reuses the original request key.</p>${formEnd('Run simulation')}</form>`);
  wireForm('payment-form', async form => { const result = await api(`${base}/payments/simulate`, 'POST', { idempotencyKey: key, plan: 'advanced', simulateFailure: form.get('outcome') === 'failure' }); $('#modal').close(); await loadProjects(); toast(result.payment.state === 'succeeded' ? 'Advanced plan active. No money was charged.' : 'Simulated payment failed. Your plan is unchanged; retry from payment history.'); });
}
async function payments() {
  const data = await api(`${projectPath()}/payments?limit=100`);
  modal('Payment history', `<p class="notice">Simulation only. No money has been charged. Showing the latest 100 payments.</p>${data.items.map(item => `<div class="incident-row"><div class="incident-top"><h3>Advanced monitoring</h3>${badge(item.state)}</div><p>${date(item.updatedAt)} · ${item.attempts} attempts</p>${item.state === 'failed' ? `<button class="button small" data-action="retry-payment" data-key="${E(item.idempotencyKey)}">Retry this payment</button>` : ''}</div>`).join('') || empty('No payments yet.', 'Your plan changes will appear here.', true)}`);
}
async function loadOperations(generation) {
  try {
    const [data, audit] = await Promise.all([api('/api/admin/operations?limit=50'), api('/api/admin/audit?limit=50')]);
    if (generation !== state.generation || state.page !== 'operations' || !state.user) return;
    $('#page-content').innerHTML = `<section class="stat-grid"><div class="stat-card"><div class="stat-top">Workers reporting</div><strong class="stat-value">${data.workers.length}</strong><p class="stat-note">${data.workers.filter(worker => worker.healthy).length} healthy heartbeats</p></div><div class="stat-card"><div class="stat-top">Failed checks</div><strong class="stat-value">${data.failedChecks}</strong><p class="stat-note">Exhausted worker attempts</p></div><div class="stat-card"><div class="stat-top">Failed alerts</div><strong class="stat-value">${data.failedAlerts}</strong><p class="stat-note">Delivery needs attention</p></div></section><section class="panel"><div class="panel-header"><h2>Worker health</h2></div>${data.workers.map(worker => `<div class="incident-row"><div class="incident-top"><h3>${E(worker._id)}</h3>${badge(worker.healthy ? 'operational' : 'unknown')}</div><p>Last seen ${date(worker.lastSeenAt)}</p></div>`).join('') || empty('No worker heartbeat yet.', 'Start the independent monitoring worker to process checks.')}</section><div class="columns"><section class="panel"><div class="panel-header"><h2>Operational events</h2><span class="service-meta">Latest 50</span></div>${data.events.map(item => `<div class="incident-row"><h3>${E(item.type || item.event || item.kind || 'Worker event')}</h3><p>${E(item.reason || '')} · ${date(item.createdAt)}</p></div>`).join('') || empty('No operational failures recorded.', 'Worker failures are recorded here.', true)}</section><section class="panel"><div class="panel-header"><h2>Platform audit</h2><span class="service-meta">Latest 50</span></div>${audit.items.map(item => `<div class="incident-row"><h3>${E(item.action.replaceAll('.', ' · '))}</h3><p>${date(item.createdAt)}</p></div>`).join('') || empty('No events yet.', 'Actions will appear here.', true)}</section></div>`;
  } catch (error) { if (generation === state.generation) $('#page-content').innerHTML = `<div class="notice form-error">${E(error.message)}</div>`; }
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const action = button.dataset.action, id = button.dataset.id; button.disabled = true;
  try {
    if (action === 'close') $('#modal').close();
    if (action === 'account') accountDialog();
    if (action === 'email-activity') await emailActivity();
    if (action === 'resend-verification') { const result = await api('/api/auth/verification/resend', 'POST', {}); toast(result.message || (simulatedMail() ? 'Verification queued in the development email inbox.' : 'Verification email queued. Check your inbox and spam folder.')); }
    if (action === 'connect-provider') { const result = await api(`/api/auth/oauth/${encodeURIComponent(button.dataset.provider)}/link`, 'POST', {}); location.assign(result.url); }
    if (action === 'navigate') { sidebar(false); state.page = button.dataset.page; await loadData(); $('#main').focus({ preventScroll: true }); }
    if (action === 'refresh') { await loadProjects(); void checkHealth(); }
    if (action === 'add-project') projectDialog();
    if (action === 'example-project') await exampleProject();
    if (action === 'add-service') serviceDialog();
    if (action === 'edit-service') serviceDialog(state.services.find(item => item._id === id));
    if (action === 'service-details') await serviceDetails(id);
    if (action === 'queue-check') { await api(`${projectPath()}/services/${id}/checks`, 'POST', {}); toast('Check queued. A monitoring worker must process it before results appear.'); await loadData(true); }
    if (action === 'add-incident') incidentDialog();
    if (action === 'incident-details') await incidentDetails(id);
    if (action === 'override') overrideDialog(id);
    if (action === 'clear-override') { await api(`${projectPath()}/services/${id}/override`, 'DELETE'); $('#modal').close(); await loadData(); toast('Manual override cleared.'); }
    if (action === 'acknowledge') { await api(`${projectPath()}/alerts/${id}/acknowledge`, 'POST', {}); await loadData(); toast('Alert acknowledged.'); }
    if (action === 'deliver-alert') { await api(`${projectPath()}/alerts/${id}/retry`, 'POST', { simulateFailure: false }); await loadData(); toast(simulatedMail() ? 'Simulated delivery completed. No real email was sent.' : 'Alert delivery retried. Check its sending status.'); }
    if (action === 'invite') inviteDialog();
    if (action === 'accept-invite') inviteDialog(true, state.inviteToken || '');
    if (action === 'upgrade') paymentDialog();
    if (action === 'retry-payment') paymentDialog(button.dataset.key);
    if (action === 'payments') await payments();
    if (action === 'edit-member') memberDialog(id);
    if (action === 'archive-service') archiveDialog('service', id);
    if (action === 'archive-project') archiveDialog('project');
    if (action === 'config-history') await configHistory(id);
    if (action === 'fail-alert') { await api(`${projectPath()}/alerts/${id}/retry`, 'POST', { simulateFailure: true }); await loadData(); toast('Delivery failure recorded. You can retry the alert.'); }
    if (action === 'inbox') await inbox();
    if (action === 'audit') await audit();
    if (action === 'verify-subscription') { await api('/api/public/subscriptions/verify', 'POST', { token: button.dataset.token }); await inbox(); toast('Simulated subscription verification completed.'); }
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});

setInterval(() => { if (state.user && !document.hidden && !$('#modal').open && state.page === 'overview') void loadData(true); }, 30000);
async function initializeAccount(accountLink = readAccountLink()) {
  state.authOptions = await window.StatusPulsePreferences?.options || null;
  renderAuthOptions();
  if (state.inviteToken) authMessage('You have a project invitation. Sign in or create an account with the email address that received it.');
  if (accountLink.has('auth_error')) {
    const errors = {
      account_exists: 'An account already uses that email. Sign in with your password, then connect the provider from Your account.',
      cancelled: 'Sign-in was cancelled. You can try again or use your email and password.',
      email_mismatch: 'Use the provider account with the same email address as your Status Pulse account.',
      identity_in_use: 'That provider is already connected to another account.',
      email_unverified: 'Your provider needs a verified email address before it can be connected.',
      link_session_expired: 'Your session expired. Sign in again, then connect your provider from Your account.',
      invalid_state: 'That sign-in request expired. Please start again.',
    };
    authMode('login'); authMessage(errors[accountLink.get('auth_error')] || 'Sign-in could not be completed. Please try again or use your email and password.');
  }
  try {
    if (accountLink.has('oauth_code')) {
      const result = await api('/api/auth/oauth/exchange', 'POST', { code: accountLink.get('oauth_code') });
      state.token = result.token; state.user = result.user; store.set('status-pulse-session', state.token);
      await enterWorkspace();
    } else if (state.token) { const result = await api('/api/auth/me'); state.user = result.user; await enterWorkspace(); }
  } catch (error) { showAuth(); authMode('login'); authMessage(error.message || 'Please sign in to continue.'); }
  if (accountLink.has('verify_email')) {
    try {
      await api('/api/auth/verify-email', 'POST', { token: accountLink.get('verify_email') });
      if (state.user) { const result = await api('/api/auth/me'); state.user = result.user; toast('Your email address is verified.'); }
      else { authMode('login'); authMessage('Your email address is verified. Sign in to continue.'); }
    } catch (error) { if (state.user) toast(error.message, true); else authMessage(error.message); }
  }
  if (accountLink.has('reset_password')) resetPasswordDialog(accountLink.get('reset_password'));
}
void initializeAccount();
addEventListener('hashchange', () => {
  const link = new URLSearchParams(location.hash.slice(1));
  if (accountFragments.some(key => link.has(key))) void initializeAccount();
});
