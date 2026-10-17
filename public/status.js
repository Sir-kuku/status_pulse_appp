const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const slug = encodeURIComponent(decodeURIComponent(location.pathname.split('/').filter(Boolean).at(-1)));
const base = `/api/public/projects/${slug}`;
const labels = { operational: 'Operational', degraded: 'Degraded', outage: 'Outage', unknown: 'Awaiting checks', investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved' };
const date = value => value ? new Date(value).toLocaleString() : 'Awaiting first check';
const badge = status => `<span class="badge ${Object.hasOwn(labels, status) ? status : 'unknown'}">${escape(labels[status] || status)}</span>`;
async function request(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Please try again.');
  return data;
}
let offset = 0, selected = new Set(), refreshing = false;
function message(text, error = false) { $('#public-message').textContent = text; $('#public-message').className = error ? 'notice form-error' : 'notice'; $('#public-message').hidden = false; }
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [data, incidents] = await Promise.all([request(`${base}?limit=20&offset=${offset}`), request(`${base}/incidents?limit=20`)]);
    $('#public-title').textContent = data.project.name;
    const titles = { operational: 'All systems operational', degraded: 'Some services are degraded', outage: 'We’re responding to an outage', unknown: 'Waiting for monitoring results' };
    $('#public-status').innerHTML = `<span class="status-symbol" aria-hidden="true">${data.project.status === 'operational' ? '✓' : '◎'}</span><div><p class="eyebrow">LIVE SERVICE STATUS</p><h2>${titles[data.project.status]}</h2><p>We’ll share service changes and incident updates here.</p></div>${badge(data.project.status)}`;
    $('#public-status').className = `hero-status public-hero status-${data.project.status}`;
    $('#public-services').innerHTML = data.services.map(service => `<div class="public-service"><div><strong>${escape(service.name)}</strong><p class="service-meta">Last checked ${escape(date(service.lastCheckedAt))}</p></div><div class="actions">${badge(service.status)}<button class="button small" data-history="${escape(service._id)}">History<span class="sr-only"> for ${escape(service.name)}</span></button></div></div>`).join('') || '<div class="empty-state"><h3>No public services yet</h3><p>This team hasn’t published any monitors.</p></div>';
    $('#public-pagination').innerHTML = `<span>${data.total ? offset + 1 : 0}–${Math.min(offset + 20, data.total)} of ${data.total} services</span><div class="actions"><button class="button small" data-page="-1" ${offset === 0 ? 'disabled' : ''}>Previous</button><button class="button small" data-page="1" ${offset + 20 >= data.total || offset >= 10000 ? 'disabled' : ''}>Next</button></div>`;
    $('#subscription-services').innerHTML = data.services.map(service => `<label class="checkbox"><input type="checkbox" name="serviceIds" value="${escape(service._id)}" ${selected.has(service._id) ? 'checked' : ''}>${escape(service.name)}</label>`).join('') || '<p class="muted">Subscriptions are available once a service is published.</p>';
    $('#selection-count').textContent = `${selected.size} services selected (up to 50). Use the service pages above to select more.`;
    $('#public-incidents').innerHTML = incidents.items.map(incident => `<div class="incident-row"><div class="incident-top">${badge(incident.state)}<time class="service-meta">${escape(date(incident.updatedAt))}</time></div><h3><button class="service-name" data-incident="${escape(incident._id)}">${escape(incident.title)}</button></h3></div>`).join('') || '<div class="empty-state compact"><h3>No published incidents</h3><p>Updates from the team will appear here.</p></div>';
    $('#public-updated').textContent = `Updated ${new Date().toLocaleTimeString()} · Refreshes every 30 seconds`;
    $('#public-error').hidden = true;
  } catch (error) { $('#public-error').textContent = `Status could not be refreshed. ${error.message}`; $('#public-error').hidden = false; }
  finally { refreshing = false; }
}
$('#subscription-services').addEventListener('change', event => {
  if (event.target.checked && selected.size >= 50) { event.target.checked = false; return message('Choose up to 50 services.', true); }
  if (event.target.checked) selected.add(event.target.value); else selected.delete(event.target.value);
  $('#selection-count').textContent = `${selected.size} services selected (up to 50).`;
});
$('#subscribe-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('button[type="submit"]'); button.disabled = true;
  try {
    if (!selected.size) throw new Error('Choose at least one service to follow.');
    const result = await request(`${base}/subscriptions`, { email: new FormData(event.currentTarget).get('email'), serviceIds: [...selected] });
    message('Subscription requested. This project uses a simulated inbox; no email was sent. Ask the project owner for your verification code.');
    if (result.simulatedEmail) { $('#verify-form [name="token"]').value = result.simulatedEmail.verificationToken; message('Subscription requested. Your development verification code is filled in below. Complete simulated verification to activate it.'); }
    $('#verify-form').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
  } catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
});
$('#verify-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
  try { await request('/api/public/subscriptions/verify', { token: new FormData(event.currentTarget).get('token') }); event.target.reset(); message('Subscription activated through simulation. Real mailbox ownership has not been verified.'); }
  catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
});
$('#close-modal').addEventListener('click', () => $('#modal').close());
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-incident], [data-history], [data-page], [data-refresh]'); if (!button || button.disabled) return;
  button.disabled = true;
  try {
    if (button.hasAttribute('data-refresh')) return await refresh();
    if (button.dataset.page) { offset = Math.max(0, offset + Number(button.dataset.page) * 20); return await refresh(); }
    const history = button.dataset.history;
    const data = await request(history ? `${base}/services/${history}/history?limit=50` : `${base}/incidents/${button.dataset.incident}?limit=50`);
    $('#modal-title').textContent = history ? `${data.service.name} · Status history` : data.incident.title;
    $('#modal-body').innerHTML = `<div class="timeline">${(history ? data.items : data.updates).map(item => `<div class="timeline-entry"><h4>${history ? `${escape(labels[item.from])} → ${escape(labels[item.to])}` : escape(labels[item.state])}</h4><time>${escape(date(item.createdAt))}</time>${history ? '' : `<p>${escape(item.message)}</p>`}</div>`).join('') || '<p class="muted">No published updates yet.</p>'}</div><p class="field-hint">Showing the latest 50 records. Times are in your local timezone.</p>`;
    $('#modal').showModal();
  } catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
});
void refresh();
setInterval(() => { if (!document.hidden && !$('#modal').open && !$('#subscribe-form').contains(document.activeElement)) void refresh(); }, 30000);
