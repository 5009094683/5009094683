/** The simulator's own screen: what each channel shows, and a way to act as a guest on any of them. */
export const UI_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OTA simulator</title>
<style>
  :root { --line:#e2e5ea; --ink:#16202c; --soft:#5b6675; --bg:#f5f6f8; --card:#fff; --brand:#1d5fd3; --bad:#c2372f; --ok:#1f8a4c; --warn:#b26a00; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--ink); background:var(--bg); }
  header { display:flex; gap:16px; align-items:center; padding:12px 20px; background:var(--card); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:2; }
  header h1 { font-size:16px; margin:0; }
  header .note { color:var(--soft); font-size:12px; }
  main { padding:16px 20px 48px; display:grid; gap:16px; grid-template-columns:minmax(0,1fr); max-width:1400px; margin:0 auto; }
  @media (min-width:1100px) { main { grid-template-columns:minmax(0,2fr) minmax(320px,1fr); } .wide { grid-column:1 / -1; } }
  section { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px 16px; min-width:0; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--soft); margin:0 0 10px; }
  h3 { font-size:14px; margin:14px 0 6px; }
  h3:first-of-type { margin-top:0; }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
  th, td { padding:4px 6px; text-align:center; border-bottom:1px solid var(--line); white-space:nowrap; }
  th:first-child, td:first-child { text-align:left; position:sticky; left:0; background:var(--card); }
  thead th { font-weight:600; font-size:12px; color:var(--soft); }
  td.zero { background:#fdecea; color:var(--bad); font-weight:600; }
  td.none { color:#b3bac4; }
  tr.master td { font-weight:600; background:#f0f4fb; }
  tr.master td:first-child { background:#f0f4fb; }
  tr.off td { color:#b3bac4; }
  label { display:block; font-size:12px; color:var(--soft); margin:8px 0 3px; }
  input, select, button { font:inherit; }
  input, select { width:100%; padding:6px 8px; border:1px solid #c9ced6; border-radius:6px; background:#fff; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  button { padding:6px 12px; border-radius:6px; border:1px solid #c9ced6; background:#fff; cursor:pointer; }
  button.primary { background:var(--brand); border-color:var(--brand); color:#fff; font-weight:600; }
  button:disabled { opacity:.5; cursor:default; }
  .actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; align-items:center; }
  .check { display:flex; gap:6px; align-items:center; font-size:13px; color:var(--ink); margin:10px 0 0; }
  .check input { width:auto; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; font-weight:600; background:#eef1f5; color:var(--soft); }
  .pill.ok { background:#e5f5eb; color:var(--ok); } .pill.bad { background:#fdecea; color:var(--bad); } .pill.warn { background:#fff3dc; color:var(--warn); }
  .booking { border-top:1px solid var(--line); padding:8px 0; display:flex; gap:10px; justify-content:space-between; align-items:flex-start; }
  .booking:first-child { border-top:0; }
  .booking small, .muted { color:var(--soft); font-size:12px; }
  .msg { margin-top:10px; font-size:13px; min-height:18px; }
  .msg.bad { color:var(--bad); } .msg.ok { color:var(--ok); }
  .log { font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; max-height:260px; overflow:auto; }
  .log div { white-space:nowrap; }
  .empty { color:var(--soft); padding:8px 0; }
</style>
</head>
<body>
<header>
  <h1>OTA simulator</h1>
  <select id="property" style="width:auto;min-width:220px" aria-label="Property"></select>
  <span id="status"></span>
  <span class="note">Stands in for the channel manager and the booking sites. Nothing here is real.</span>
</header>
<main>
  <section class="wide">
    <h2>What each site shows as bookable</h2>
    <div id="grid" class="scroll"><p class="empty">Waiting for the PMS to set up a property…</p></div>
  </section>

  <section>
    <h2>Bookings made on the sites</h2>
    <div id="bookings"><p class="empty">None yet.</p></div>
  </section>

  <section>
    <h2>Book as a guest</h2>
    <div class="row">
      <div><label for="channel">Site</label><select id="channel"></select></div>
      <div><label for="roomType">Room</label><select id="roomType"></select></div>
    </div>
    <div class="row">
      <div><label for="checkIn">Check-in</label><input id="checkIn" type="date"></div>
      <div><label for="nights">Nights</label><input id="nights" type="number" min="1" max="30" value="2"></div>
    </div>
    <label for="guest">Guest name</label><input id="guest" value="Priya Nair">
    <label class="check"><input id="force" type="checkbox"> Sell even if the site shows no room (two sites selling the last room at once)</label>
    <div class="actions"><button class="primary" id="book">Book</button></div>
    <div id="bookMsg" class="msg"></div>

    <h2 style="margin-top:18px">Break things</h2>
    <div class="actions">
      <button id="outage">Channel manager down for 30 s</button>
      <button id="failNext">Fail the next 3 requests</button>
      <button id="drop">Stop sending webhooks</button>
      <button id="redeliver">Re-announce waiting bookings</button>
    </div>
    <div id="faultMsg" class="msg muted"></div>
  </section>

  <section class="wide">
    <h2>Requests received from the PMS</h2>
    <div id="requests" class="log"><div class="empty">None yet.</div></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
let state = null;
let propertyId = new URLSearchParams(location.search).get('propertyId') || '';

const api = async (path, body) => {
  const res = await fetch('/sim' + path, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
  return data;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const dayLabel = (d) => { const x = new Date(d + 'T00:00:00Z'); return x.toLocaleDateString('en-GB', { day:'numeric', month:'short', timeZone:'UTC' }); };
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

function fillSelect(el, options, keep) {
  const current = keep ?? el.value;
  el.innerHTML = options.map((o) => '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>').join('');
  if (options.some((o) => o.value === current)) el.value = current;
}

function render() {
  const p = state.property;
  fillSelect($('property'), state.properties.map((x) => ({ value: x.id, label: x.title })), propertyId);
  const f = state.faults;
  const pills = [];
  pills.push('<span class="pill ' + (state.unacknowledged ? 'warn' : 'ok') + '">' + state.unacknowledged + ' not yet acknowledged</span>');
  if (f.outageSecondsLeft > 0) pills.push('<span class="pill bad">down for ' + f.outageSecondsLeft + ' s</span>');
  if (f.failNext > 0) pills.push('<span class="pill bad">failing next ' + f.failNext + '</span>');
  if (f.dropWebhooks) pills.push('<span class="pill bad">webhooks off</span>');
  if (!state.webhooks.some((w) => w.isActive)) pills.push('<span class="pill warn">no webhook registered</span>');
  $('status').innerHTML = pills.join(' ');
  $('drop').textContent = f.dropWebhooks ? 'Send webhooks again' : 'Stop sending webhooks';

  if (!p) return;
  propertyId = p.id;
  if (!$('checkIn').value) $('checkIn').value = addDays(p.dates[0], 3);
  fillSelect($('channel'), p.channels.filter((c) => c.active).map((c) => ({ value: c.code, label: c.title })));
  fillSelect($('roomType'), p.roomTypes.map((r) => ({ value: r.id, label: r.title })));

  let html = '';
  if (p.roomTypes.length === 0) html = '<p class="empty">This property has no rooms yet. Set it up from the PMS (Channels, then "Set up in channel manager").</p>';
  for (const room of p.roomTypes) {
    html += '<h3>' + esc(room.title) + ' <span class="muted">(' + room.countOfRooms + ' in total)</span></h3><table><thead><tr><th></th>' +
      p.dates.map((d) => '<th>' + dayLabel(d) + '</th>').join('') + '</tr></thead><tbody>';
    html += '<tr class="master"><td>Channel manager</td>' + room.availability.map((v) => '<td class="' + (v <= 0 ? 'zero' : '') + '">' + v + '</td>').join('') + '</tr>';
    for (const c of p.channels) {
      const view = c.view[room.id] || [];
      html += '<tr class="' + (c.active ? '' : 'off') + '"><td>' + esc(c.title) + (c.active ? '' : ' (off)') + '</td>' +
        p.dates.map((_, i) => { const v = view[i]; return v === null || v === undefined ? '<td class="none">–</td>' : '<td class="' + (v <= 0 ? 'zero' : '') + '">' + v + '</td>'; }).join('') + '</tr>';
    }
    const plan = room.ratePlans[0];
    if (plan) html += '<tr><td class="muted">' + esc(plan.title) + '</td>' + plan.days.map((d) => '<td class="muted">' + (d.stopSell ? 'closed' : Math.round(d.rate / 100)) + '</td>').join('') + '</tr>';
    html += '</tbody></table>';
  }
  $('grid').innerHTML = html;

  $('bookings').innerHTML = p.bookings.length === 0 ? '<p class="empty">None yet.</p>' : p.bookings.map((b) => {
    const room = b.rooms.find((r) => !r.isCancelled) || b.rooms[0];
    const title = (p.roomTypes.find((r) => r.id === room.roomTypeId) || {}).title || 'Unmapped room';
    const pending = b.revisions.filter((r) => !r.acknowledged).length;
    return '<div class="booking"><div><strong>' + esc(b.channelTitle) + ' ' + esc(b.code) + '</strong> ' +
      '<span class="pill ' + (b.status === 'cancelled' ? 'bad' : 'ok') + '">' + b.status + '</span> ' +
      '<span class="pill ' + (pending ? 'warn' : 'ok') + '">' + (pending ? pending + ' waiting for the PMS' : 'received by the PMS') + '</span><br>' +
      '<small>' + esc(b.guest) + ' · ' + esc(title) + ' · ' + dayLabel(room.checkIn) + ' to ' + dayLabel(room.checkOut) + '</small></div>' +
      (b.status === 'cancelled' ? '' : '<div style="display:flex;gap:6px"><button data-extend="' + b.id + '" data-out="' + room.checkOut + '">+1 night</button><button data-cancel="' + b.id + '">Cancel</button></div>') + '</div>';
  }).join('');

  $('requests').innerHTML = state.requests.length === 0 ? '<div class="empty">None yet.</div>' : state.requests.map((r) =>
    '<div>' + r.at.slice(11, 19) + '  ' + r.status + '  ' + r.method.padEnd(5) + ' ' + esc(r.path) + (r.values ? '  (' + r.values + ' values)' : '') + '</div>').join('');
}

async function refresh() {
  try {
    state = await api('/state' + (propertyId ? '?propertyId=' + encodeURIComponent(propertyId) : ''));
    render();
  } catch (e) { /* the simulator is restarting */ }
}

$('property').addEventListener('change', (e) => { propertyId = e.target.value; refresh(); });
$('book').addEventListener('click', async () => {
  const msg = $('bookMsg');
  const p = state && state.property;
  if (!p) return;
  const room = p.roomTypes.find((r) => r.id === $('roomType').value);
  const names = $('guest').value.trim().split(/\\s+/);
  try {
    const checkIn = $('checkIn').value;
    const booking = await api('/bookings', {
      propertyId: p.id, channel: $('channel').value, force: $('force').checked,
      rooms: [{ roomTypeId: room.id, ratePlanId: room.ratePlans[0] ? room.ratePlans[0].id : null, checkIn, checkOut: addDays(checkIn, Number($('nights').value) || 1) }],
      customer: { name: names[0] || 'Guest', surname: names.slice(1).join(' ') || '' },
    });
    msg.className = 'msg ok'; msg.textContent = 'Booked. Confirmation ' + booking.code + '.';
  } catch (e) { msg.className = 'msg bad'; msg.textContent = e.message; }
  refresh();
});
$('bookings').addEventListener('click', async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.dataset.cancel) await api('/bookings/' + t.dataset.cancel + '/cancel', {});
  if (t.dataset.extend) await api('/bookings/' + t.dataset.extend + '/modify', { rooms: [{ checkOut: addDays(t.dataset.out, 1) }] }).catch((err) => alert(err.message));
  refresh();
});
$('outage').addEventListener('click', async () => { await api('/faults', { outageSeconds: 30 }); refresh(); });
$('failNext').addEventListener('click', async () => { await api('/faults', { failNext: 3, failStatus: 503 }); refresh(); });
$('drop').addEventListener('click', async () => { await api('/faults', { dropWebhooks: !state.faults.dropWebhooks }); refresh(); });
$('redeliver').addEventListener('click', async () => { const r = await api('/redeliver', {}); $('faultMsg').textContent = 'Announced ' + r.announced + ' booking message(s) again.'; refresh(); });

refresh();
setInterval(refresh, 1500);
</script>
</body>
</html>`;

/** The stand-in for the channel manager's embedded "connect your channels" screen. */
export function channelScreenHtml(
  property: { id: string; title: string },
  username: string,
): string {
  return /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Channels</title>
<style>
  body { margin:0; padding:20px; font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:#16202c; background:#fff; }
  h1 { font-size:16px; margin:0 0 4px; } p { color:#5b6675; margin:0 0 16px; }
  .channel { display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-top:1px solid #e2e5ea; }
  button { font:inherit; padding:6px 12px; border-radius:6px; border:1px solid #c9ced6; background:#fff; cursor:pointer; }
  .on { color:#1f8a4c; font-weight:600; } .off { color:#5b6675; }
</style></head><body>
<h1>Channels for ${property.title.replace(/[&<>"]/g, '')}</h1>
<p>Simulated channel manager, signed in as ${username.replace(/[&<>"]/g, '')}. Switch a booking site on or off.</p>
<div id="list"></div>
<script>
const propertyId = ${JSON.stringify(property.id)};
async function load() {
  const s = await (await fetch('/sim/state?propertyId=' + propertyId)).json();
  document.getElementById('list').innerHTML = s.property.channels.map((c) =>
    '<div class="channel"><span>' + c.title + ' <span class="' + (c.active ? 'on' : 'off') + '">' + (c.active ? 'connected' : 'not connected') + '</span></span>' +
    '<button data-code="' + c.code + '" data-active="' + (!c.active) + '">' + (c.active ? 'Disconnect' : 'Connect') + '</button></div>').join('');
}
document.getElementById('list').addEventListener('click', async (e) => {
  const t = e.target; if (!(t instanceof HTMLElement) || !t.dataset.code) return;
  await fetch('/sim/channels', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ propertyId, code: t.dataset.code, active: t.dataset.active === 'true' }) });
  load();
});
load();
</script></body></html>`;
}
