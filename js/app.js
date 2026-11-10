// Group Trip Planner — static site for GitHub Pages. No accounts, no setup.
// All data is one JSON document on textdb.dev (see js/config.js). Roles are honour-system:
// the planner passcode only decides which controls this page shows. Anyone with the
// storage address could still change the data directly, so keep backups (People tab).
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
  const clean = (v, max) => (v && v.trim() ? v.trim().slice(0, max) : null);
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const STATUS = { going: 'Going', maybe: 'Maybe', no: 'Not going' };
  const KINDS = { activity: 'Activity', place: 'Place', food: 'Food & drink', stay: 'Stay', other: 'Other' };
  const TABS = ['itinerary', 'suggestions', 'interest', 'people'];
  const POLL_MS = 10000;
  const STORE = (window.TRIP_CONFIG || {}).storeUrl;

  const S = { doc: null, raw: '', meId: null, myHash: null, tab: 'itinerary', openPeople: new Set(), form: null, pendingRender: false, busy: false };

  /* ---------- local (this device) ---------- */
  const local = {
    get(k) { try { return localStorage.getItem('trip.' + k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem('trip.' + k) : localStorage.setItem('trip.' + k, v); } catch { /* storage unavailable */ } },
  };

  /* ---------- small helpers ---------- */
  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3500); }
  function banner(msg) { const b = $('#banner'); b.hidden = !msg; b.textContent = msg || ''; }
  function show(view) { for (const id of ['startView', 'whoView', 'appView']) $('#' + id).hidden = id !== view; }
  function fail(e) { console.error(e); toast(e && e.userMessage ? e.userMessage : 'Couldn’t save. Check your connection and try again.'); }
  async function hashPass(p) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('group-trip-planner:' + p));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* ---------- storage ---------- */
  function emptyDoc() {
    return { v: 1, trip: { name: 'Our group trip', destination: null, start_date: null, end_date: null, group_size: 10 },
      plannerHash: null, people: [], items: [], sugs: [], rsvps: [], votes: [], updated_at: null };
  }
  function validDoc(d) {
    return d && d.v === 1 && d.trip && ['people', 'items', 'sugs', 'rsvps', 'votes'].every((k) => Array.isArray(d[k]));
  }
  async function fetchRaw() {
    // No "Accept: application/json" header: textdb.dev then returns the JSON wrapped in a string.
    const res = await fetch(STORE, { cache: 'no-store' });
    if (res.status === 404) return '';
    if (!res.ok) throw new Error('Load failed: ' + res.status);
    return (await res.text()).trim();
  }
  function parseDoc(text) {
    if (!text) return null;
    try {
      let d = JSON.parse(text);
      if (typeof d === 'string') d = JSON.parse(d); // tolerate a double-encoded copy
      return validDoc(d) ? d : null;
    } catch { return null; }
  }
  async function saveDoc(doc) {
    const body = JSON.stringify(doc);
    const res = await fetch(STORE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!res.ok) throw new Error('Save failed: ' + res.status);
    S.doc = doc; S.raw = body;
  }
  // Read the latest copy, apply one change, save. Keeps the window for overwriting someone
  // else's simultaneous change as small as possible (the store has no transactions).
  async function mutate(change) {
    S.busy = true;
    try {
      const latest = parseDoc(await fetchRaw());
      if (!latest) throw Object.assign(new Error('missing'), { userMessage: 'The trip data couldn’t be read. Reload the page and try again.' });
      change(latest);
      latest.updated_at = new Date().toISOString();
      await saveDoc(latest);
    } finally {
      S.busy = false;
    }
    route();
  }
  async function refresh() {
    if (S.busy || document.visibilityState !== 'visible') return;
    try {
      const text = await fetchRaw();
      banner('');
      if (text === S.raw) return;
      const doc = parseDoc(text);
      if (!doc && text) { banner('The trip data looks damaged. A planner can restore a backup from the People tab.'); return; }
      S.doc = doc; S.raw = text;
      route();
    } catch (e) {
      console.error(e);
      banner('Can’t reach the trip data right now. Changes from others will show up once the connection is back.');
    }
  }

  /* ---------- who is using this device ---------- */
  const D = () => S.doc;
  const me = () => (D() && D().people.find((p) => p.id === S.meId)) || null;
  const isPlanner = () => !!(D() && D().plannerHash && S.myHash === D().plannerHash);
  const nameOf = (id) => { const p = D().people.find((x) => x.id === id); return p ? p.name : 'Former member'; };
  function dot(id) {
    let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const initials = nameOf(id).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    return `<span class="dot" aria-hidden="true" style="background:hsl(${h % 360} 45% 42%)">${esc(initials)}</span>`;
  }

  /* ---------- dates ---------- */
  const parseDay = (d) => (d ? new Date(d + 'T00:00:00') : null);
  const fmtDay = (d) => parseDay(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  function fmtRange(a, b) {
    if (!a) return 'Group trip';
    const o = { day: 'numeric', month: 'short', year: 'numeric' };
    return b && b !== a ? `${parseDay(a).toLocaleDateString(undefined, o)} – ${parseDay(b).toLocaleDateString(undefined, o)}` : parseDay(a).toLocaleDateString(undefined, o);
  }
  function dayNumber(d) {
    const s = D().trip.start_date; if (!s || !d) return null;
    const n = Math.round((parseDay(d) - parseDay(s)) / 864e5) + 1;
    return n >= 1 ? n : null;
  }

  /* ---------- derived data ---------- */
  const answersFor = (itemId) => {
    const order = { going: 0, maybe: 1, no: 2 };
    return D().rsvps.filter((r) => r.item_id === itemId && STATUS[r.status]).sort((a, b) => order[a.status] - order[b.status]);
  };
  const myAnswer = (itemId) => D().rsvps.find((r) => r.item_id === itemId && r.user_id === S.meId) || null;
  const likesFor = (sid) => D().votes.filter((v) => v.suggestion_id === sid).length;
  const iLike = (sid) => D().votes.some((v) => v.suggestion_id === sid && v.user_id === S.meId);
  const sortedItems = () => [...D().items].sort((a, b) =>
    (a.day || '9999').localeCompare(b.day || '9999') || (a.start_time || '99').localeCompare(b.start_time || '99') || a.title.localeCompare(b.title));

  /* ---------- routing ---------- */
  function route() {
    renderHeader();
    if (!D()) { show('startView'); return; }
    if (!me()) { renderPicker(); show('whoView'); return; }
    show('appView');
    render();
  }

  /* ---------- rendering ---------- */
  function renderHeader() {
    const t = D() && D().trip;
    $('#tripName').textContent = (t && t.name) || 'Group Trip Planner';
    $('#tripDates').textContent = t ? fmtRange(t.start_date, t.end_date) : 'Group trip';
    const dest = $('#tripDest');
    if (!D()) dest.textContent = 'Plan the trip together: one itinerary, everyone’s ideas, and who’s going to what.';
    else if (t.destination) dest.textContent = t.destination + (t.group_size ? ` · ${t.group_size} travellers` : '');
    else dest.textContent = isPlanner() ? 'Add the destination and dates with “Edit trip details”.' : 'The planning team hasn’t added trip details yet.';
    const m = D() && me();
    $('#whoChip').hidden = !m;
    if (m) { $('#whoName').textContent = m.name; $('#whoRole').textContent = isPlanner() ? 'Planning team' : 'Suggester'; }
  }

  function renderPicker() {
    const people = [...D().people].sort((a, b) => a.name.localeCompare(b.name));
    $('#pickList').innerHTML = people.length
      ? '<p class="note" style="width:100%">Pick your name:</p>' + people.map((p) => `<button type="button" class="btn" data-act="pick" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('')
      : '<p class="note">Nobody else has joined yet. Add your name below.</p>';
  }

  function renderChrome() {
    $('#cItin').textContent = D().items.length || '';
    $('#cSug').textContent = D().sugs.length || '';
    $('#cPeople').textContent = D().people.length || '';
    const r = isPlanner() ? 'planner' : 'member';
    const notes = {
      itinerary: { planner: 'You’re on the planning team: you can add, edit and remove itinerary activities.', member: 'Only the planning team changes the itinerary. Tell them if you’re going to each activity, or add ideas under Suggestions.' },
      suggestions: { planner: 'Anyone in the group can suggest ideas. Use “Add to itinerary” to move one into the plan.', member: 'Add places or activities you’d like to do. You can remove your own suggestions; the planning team can move them into the itinerary.' },
      interest: { planner: 'Everyone’s answers for every activity, so you can see headcounts and who hasn’t replied.', member: 'Everyone’s answers for every activity. Change yours on the Itinerary tab.' },
      people: { planner: 'Everyone who has joined. Keep a backup now and then: the free storage has no guarantees.', member: 'Everyone who has joined. Planners can unlock planning tools here with the passcode.' },
    };
    $('#roleNote').textContent = notes[S.tab][r];
    const slot = $('#tripFormSlot');
    if (isPlanner()) { if (!slot.firstChild) slot.innerHTML = '<div class="actions"><button class="btn small" type="button" data-act="edit-trip">Edit trip details</button></div>'; }
    else slot.innerHTML = '';
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  }

  function rsvpBlock(it) {
    const mine = myAnswer(it.id);
    const seg = (s) => `<button type="button" class="seg ${s}" data-act="rsvp" data-id="${esc(it.id)}" data-s="${s}" aria-pressed="${!!mine && mine.status === s}">${STATUS[s]}</button>`;
    return `<div class="rsvp"><span class="lbl">You:</span>${seg('going')}${seg('maybe')}${seg('no')}
      <input id="note-${esc(it.id)}" data-note="${esc(it.id)}" maxlength="140" placeholder="${mine ? 'Add a note, e.g. joining late' : 'Pick an answer, then add a note'}" value="${esc(mine && mine.note)}" ${mine ? '' : 'disabled'} aria-label="Note for ${esc(it.title)}"></div>`;
  }

  function itemCard(it) {
    const ans = answersFor(it.id);
    const n = (s) => ans.filter((a) => a.status === s).length;
    const link = safeUrl(it.link);
    const open = S.openPeople.has(it.id);
    return `<article class="item">
      <div class="time">${esc(it.start_time || '—')}${it.end_time ? `<small>to ${esc(it.end_time)}</small>` : ''}</div>
      <div class="body">
        <div class="bar"><h3>${esc(it.title)}</h3>${isPlanner() ? `<div class="tools"><button type="button" class="btn small" data-act="edit-item" data-id="${esc(it.id)}">Edit</button><button type="button" class="btn small danger" data-act="del-item" data-id="${esc(it.id)}">Delete</button></div>` : ''}</div>
        ${it.location || link ? `<p class="meta">${esc(it.location)}${it.location && link ? ' · ' : ''}${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">Link</a>` : ''}</p>` : ''}
        ${it.notes ? `<p class="notes">${esc(it.notes)}</p>` : ''}
        <div class="tally"><span class="pill going">${n('going')} going</span><span class="pill maybe">${n('maybe')} maybe</span><span class="pill no">${n('no')} not going</span>
          ${ans.length ? `<button type="button" class="linkbtn" data-act="people" data-id="${esc(it.id)}" aria-expanded="${open}">${open ? 'Hide names' : 'See who'}</button>` : ''}</div>
        ${open && ans.length ? `<div class="people">${ans.map((a) => `<div class="person">${dot(a.user_id)}<b>${esc(nameOf(a.user_id))}</b><span class="pill ${a.status}">${STATUS[a.status]}</span>${a.note ? `<span class="q">“${esc(a.note)}”</span>` : ''}</div>`).join('')}</div>` : ''}
        ${rsvpBlock(it)}
      </div></article>`;
  }

  function renderItinerary() {
    const items = sortedItems();
    let h = isPlanner() && !S.form ? '<div class="bar"><span></span><button type="button" class="btn primary" data-act="new-item">Add activity</button></div>' : '';
    if (!items.length) {
      return h + `<div class="empty"><h3>No activities yet</h3><p>${isPlanner() ? 'Add the first activity, or pick one from Suggestions.' : 'The planning team will add activities here. Meanwhile, add your ideas under Suggestions.'}</p></div>`;
    }
    const groups = new Map();
    for (const it of items) { const k = it.day || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
    for (const [d, list] of groups) {
      const num = dayNumber(d);
      h += `<section class="day"><div class="dayhead">${num ? `<span class="num">DAY ${num}</span>` : ''}<h2>${d ? esc(fmtDay(d)) : 'Date to be decided'}</h2></div>${list.map(itemCard).join('')}</section>`;
    }
    return h;
  }

  function renderSuggestions() {
    let h = !S.form ? '<div class="bar"><span></span><button type="button" class="btn primary" data-act="new-sug">Suggest something</button></div>' : '';
    if (!D().sugs.length) return h + '<div class="empty"><h3>No suggestions yet</h3><p>Add a place, food spot or activity you’d like the group to consider.</p></div>';
    const list = [...D().sugs].sort((a, b) => likesFor(b.id) - likesFor(a.id) || (b.created_at || '').localeCompare(a.created_at || ''));
    return h + '<div class="sgrid">' + list.map((s) => {
      const link = safeUrl(s.link);
      const canDel = s.created_by === S.meId || isPlanner();
      const onItin = s.promoted_to && D().items.some((i) => i.id === s.promoted_to);
      return `<article class="sug"><span class="kind">${esc(KINDS[s.kind] || 'Other')}</span><h3>${esc(s.title)}</h3>
        ${s.location || link ? `<p class="meta">${esc(s.location)}${s.location && link ? ' · ' : ''}${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">Link</a>` : ''}</p>` : ''}
        ${s.why ? `<p class="notes">${esc(s.why)}</p>` : ''}
        <p class="meta">Suggested by ${esc(nameOf(s.created_by))}</p>
        ${onItin ? '<span class="promoted">✓ On the itinerary</span>' : ''}
        <div class="foot"><button type="button" class="like" data-act="like" data-id="${esc(s.id)}" aria-pressed="${iLike(s.id)}">▲ ${likesFor(s.id)} interested</button>
          <span class="tools">${isPlanner() && !onItin ? `<button type="button" class="btn small" data-act="promote" data-id="${esc(s.id)}">Add to itinerary</button>` : ''}${canDel ? `<button type="button" class="btn small danger" data-act="del-sug" data-id="${esc(s.id)}">Remove</button>` : ''}</span></div>
      </article>`;
    }).join('') + '</div>';
  }

  function renderInterest() {
    const items = sortedItems();
    if (!items.length) return '<div class="empty"><h3>Nothing to track yet</h3><p>Once the itinerary has activities, everyone’s answers show up here.</p></div>';
    const people = [...D().people].sort((a, b) => (b.id === S.meId) - (a.id === S.meId) || a.name.localeCompare(b.name));
    const replied = new Set(D().rsvps.filter((r) => items.some((i) => i.id === r.item_id)).map((r) => r.user_id));
    const size = D().trip.group_size || 0;
    const goingTotals = items.map((it) => answersFor(it.id).filter((a) => a.status === 'going').length);
    const avg = goingTotals.reduce((x, y) => x + y, 0) / items.length;
    const best = Math.max(...goingTotals);
    const top = items[goingTotals.indexOf(best)];
    const glyph = { going: '✓', maybe: '?', no: '✕' };
    let h = `<div class="summary">
      <div class="stat"><b>${replied.size} / ${size || people.length}</b><span>people have replied</span></div>
      <div class="stat"><b>${avg.toFixed(1)}</b><span>going per activity, on average</span></div>
      <div class="stat"><b>${best}</b><span>going to ${esc(top.title)}</span></div></div>`;
    h += `<div class="gridwrap"><table><thead><tr><th class="name">Person</th>${items.map((it) => `<th class="act" title="${esc(it.title)}"><small>${it.day ? esc(fmtDay(it.day)) : 'TBD'}</small>${esc(it.title.length > 28 ? it.title.slice(0, 27) + '…' : it.title)}</th>`).join('')}</tr></thead><tbody>`;
    for (const p of people) {
      h += `<tr><td class="name"><div class="person">${dot(p.id)}<b>${esc(p.name)}</b></div></td>`;
      for (const it of items) {
        const a = D().rsvps.find((r) => r.item_id === it.id && r.user_id === p.id && STATUS[r.status]);
        h += a ? `<td class="c" title="${esc(STATUS[a.status] + (a.note ? ': ' + a.note : ''))}"><span class="pill ${a.status}">${glyph[a.status]}</span></td>` : '<td class="c" title="No answer"><span class="pill none">–</span></td>';
      }
      h += '</tr>';
    }
    h += `</tbody><tfoot><tr><td class="name">Going</td>${goingTotals.map((n) => `<td>${n}${size ? `/${size}` : ''}</td>`).join('')}</tr></tfoot></table></div>`;
    h += '<p class="note">Hover or tap a cell to see that person’s note. Everyone who has joined is listed, so a row of dashes means they haven’t replied yet.</p>';
    return h;
  }

  function renderPeople() {
    let h = '';
    if (isPlanner()) {
      h += `<div class="panel"><h2>Planning tools</h2>
        <p class="note">The trip is stored on a free service with no guarantees. Download a backup after big changes, and restore it if anything goes missing.</p>
        <div class="actions"><button type="button" class="btn" data-act="backup">Download backup</button><button type="button" class="btn" data-act="restore">Restore from backup…</button><button type="button" class="btn" data-act="change-pass">Change planner passcode</button></div></div>`;
    } else if (!S.form) {
      h += '<div class="actions"><button type="button" class="btn" data-act="unlock">I’m on the planning team</button></div>';
    }
    h += '<div class="mlist">' + [...D().people].sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
      const self = p.id === S.meId;
      const tools = [];
      if (self) tools.push('<button type="button" class="btn small" data-act="rename">Change my name</button>');
      if (isPlanner() && !self) tools.push(`<button type="button" class="btn small danger" data-act="remove-person" data-id="${esc(p.id)}">Remove</button>`);
      return `<div class="mrow"><div class="person">${dot(p.id)}<b>${esc(p.name)}${self ? ' (you)' : ''}</b>${p.planner ? '<span class="role planner">Planning team</span>' : ''}</div><div class="tools">${tools.join('')}</div></div>`;
    }).join('') + '</div>';
    return h;
  }

  function render() {
    const a = document.activeElement;
    if (a && $('#listSlot').contains(a) && a.matches('input')) { S.pendingRender = true; return; }
    S.pendingRender = false;
    renderHeader();
    renderChrome();
    const views = { itinerary: renderItinerary, suggestions: renderSuggestions, interest: renderInterest, people: renderPeople };
    $('#listSlot').innerHTML = views[S.tab]();
  }
  $('#listSlot').addEventListener('focusout', () => setTimeout(() => { if (S.pendingRender) render(); }, 0));

  /* ---------- forms ---------- */
  const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  function openItemForm(it, fromSug) {
    S.form = { kind: 'item', id: it && it.id, fromSug };
    const v = it || {};
    const t = D().trip;
    $('#formSlot').innerHTML = `<form class="panel" data-form="item"><h2>${v.id ? 'Edit activity' : 'Add activity'}</h2>
      <div class="fields">
        <label class="wide">Activity<input id="f-title" required maxlength="120" value="${esc(v.title)}" placeholder="e.g. Sunrise hike up the ridge"></label>
        <label>Date<input id="f-date" type="date" value="${esc(v.day)}" min="${esc(t.start_date)}" max="${esc(t.end_date)}"></label>
        <label>Start time<input id="f-time" type="time" value="${esc(v.start_time)}"></label>
        <label>End time<input id="f-end" type="time" value="${esc(v.end_time)}"></label>
        <label class="wide">Where<input id="f-loc" maxlength="160" value="${esc(v.location)}" placeholder="Meeting point or address"></label>
        <label class="wide">Link<input id="f-link" type="url" maxlength="500" value="${esc(v.link)}" placeholder="https://"></label>
        <label class="wide">Notes<textarea id="f-notes" maxlength="1000" placeholder="Cost, what to bring, booking details">${esc(v.notes)}</textarea></label>
      </div>
      <div class="actions"><button class="btn primary" type="submit">${v.id ? 'Save changes' : 'Add to itinerary'}</button><button class="btn" type="button" data-act="cancel">Cancel</button></div></form>`;
    render(); $('#f-title').focus();
  }
  function openSugForm() {
    S.form = { kind: 'sug' };
    $('#formSlot').innerHTML = `<form class="panel" data-form="sug"><h2>Suggest a place or activity</h2>
      <div class="fields">
        <label class="wide">What is it?<input id="s-title" required maxlength="120" placeholder="e.g. Night market food crawl"></label>
        <label>Type<select id="s-kind">${Object.entries(KINDS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label>Where<input id="s-loc" maxlength="160" placeholder="Area or address"></label>
        <label class="wide">Link<input id="s-link" type="url" maxlength="500" placeholder="https://"></label>
        <label class="wide">Why should we go?<textarea id="s-why" maxlength="600" placeholder="Price, opening hours, why it’s worth it"></textarea></label>
      </div>
      <div class="actions"><button class="btn primary" type="submit">Add suggestion</button><button class="btn" type="button" data-act="cancel">Cancel</button></div></form>`;
    render(); $('#s-title').focus();
  }
  function openTripForm() {
    const t = D().trip;
    $('#tripFormSlot').innerHTML = `<form class="panel" data-form="trip"><h2>Trip details</h2>
      <div class="fields">
        <label class="wide">Trip name<input id="t-name" maxlength="80" required value="${esc(t.name)}"></label>
        <label class="wide">Destination<input id="t-dest" maxlength="120" value="${esc(t.destination)}"></label>
        <label>First day<input id="t-start" type="date" value="${esc(t.start_date)}"></label>
        <label>Last day<input id="t-end" type="date" value="${esc(t.end_date)}"></label>
        <label>Group size<input id="t-size" type="number" min="1" max="200" value="${esc(t.group_size || 10)}"></label>
      </div>
      <div class="actions"><button class="btn primary" type="submit">Save trip details</button><button class="btn" type="button" data-act="cancel-trip">Cancel</button></div></form>`;
    $('#t-name').focus();
  }
  function openSmallForm(kind, title, field) {
    S.form = { kind };
    $('#formSlot').innerHTML = `<form class="panel narrow" data-form="${kind}"><h2>${title}</h2>${field}
      <div class="actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-act="cancel">Cancel</button></div></form>`;
    render(); $('#formSlot input').focus();
  }
  function closeForm() { S.form = null; $('#formSlot').innerHTML = ''; render(); }

  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('form'); if (!f) return;
    e.preventDefault();
    const btn = f.querySelector('[type=submit]'); if (btn) btn.disabled = true;
    try {
      if (f.id === 'startView') return await startTrip();
      if (f.id === 'whoView') return await identify();
      const kind = f.dataset.form;
      if (kind === 'item') {
        const row = { title: val('f-title').slice(0, 120), day: val('f-date') || null, start_time: val('f-time') || null, end_time: val('f-end') || null,
          location: clean(val('f-loc'), 160), link: safeUrl(val('f-link')) || null, notes: clean(val('f-notes'), 1000) };
        const { id, fromSug } = S.form;
        await mutate((d) => {
          if (id) { const it = d.items.find((x) => x.id === id); if (it) Object.assign(it, row); return; }
          const itemId = newId();
          d.items.push({ id: itemId, ...row, created_by: S.meId, created_at: new Date().toISOString() });
          const s = fromSug && d.sugs.find((x) => x.id === fromSug); if (s) s.promoted_to = itemId;
        });
        toast(id ? 'Activity updated' : 'Added to the itinerary');
        closeForm();
      } else if (kind === 'sug') {
        const row = { id: newId(), title: val('s-title').slice(0, 120), kind: val('s-kind'), location: clean(val('s-loc'), 160), link: safeUrl(val('s-link')) || null,
          why: clean(val('s-why'), 600), created_by: S.meId, created_at: new Date().toISOString(), promoted_to: null };
        await mutate((d) => { d.sugs.push(row); });
        toast('Suggestion added'); closeForm();
      } else if (kind === 'trip') {
        const size = Number(val('t-size'));
        const trip = { name: val('t-name').slice(0, 80), destination: clean(val('t-dest'), 120), start_date: val('t-start') || null, end_date: val('t-end') || null, group_size: size >= 1 ? size : null };
        await mutate((d) => { d.trip = trip; });
        $('#tripFormSlot').innerHTML = ''; toast('Trip details saved'); render();
      } else if (kind === 'rename') {
        const name = val('r-name').slice(0, 40);
        await mutate((d) => { const p = d.people.find((x) => x.id === S.meId); if (p) p.name = name; });
        toast('Name updated'); closeForm();
      } else if (kind === 'unlock') {
        const h = await hashPass(val('u-pass'));
        if (h !== D().plannerHash) { toast('That passcode isn’t right.'); return; }
        S.myHash = h; local.set('plannerHash', h);
        await mutate((d) => { const p = d.people.find((x) => x.id === S.meId); if (p) p.planner = true; });
        toast('Planning tools unlocked'); closeForm();
      } else if (kind === 'change-pass') {
        const h = await hashPass(val('c-pass'));
        await mutate((d) => { d.plannerHash = h; });
        S.myHash = h; local.set('plannerHash', h);
        toast('Passcode changed. Tell the other planners the new one.'); closeForm();
      }
    } catch (err) {
      fail(err);
    } finally {
      if (btn && document.body.contains(btn)) btn.disabled = false;
    }
  });

  /* ---------- first visit, and choosing who you are ---------- */
  async function startTrip() {
    $('#startError').hidden = true;
    const existing = parseDoc(await fetchRaw());
    if (existing) { S.doc = existing; S.raw = JSON.stringify(existing); toast('Someone already started this trip.'); route(); return; }
    const doc = emptyDoc();
    const id = newId();
    doc.trip.name = val('startTrip').slice(0, 80);
    doc.plannerHash = await hashPass(val('startPass'));
    doc.people.push({ id, name: val('startName').slice(0, 40), planner: true, joined_at: new Date().toISOString() });
    doc.updated_at = new Date().toISOString();
    await saveDoc(doc);
    S.meId = id; local.set('me', id);
    S.myHash = doc.plannerHash; local.set('plannerHash', S.myHash);
    route();
    toast('Trip created. Share this page’s link with the group.');
  }
  async function identify(pickedId) {
    $('#whoError').hidden = true;
    const pass = val('whoPass');
    const newName = val('whoNew').slice(0, 40);
    let hash = null;
    if (pass) {
      hash = await hashPass(pass);
      if (hash !== D().plannerHash) { $('#whoError').textContent = 'That planner passcode isn’t right. Leave it empty to join as a suggester.'; $('#whoError').hidden = false; return; }
    }
    let id = pickedId;
    if (!id) {
      if (!newName) { $('#whoError').textContent = 'Pick your name or type it in.'; $('#whoError').hidden = false; return; }
      const same = D().people.find((p) => p.name.toLowerCase() === newName.toLowerCase());
      id = same ? same.id : newId();
    }
    await mutate((d) => {
      let p = d.people.find((x) => x.id === id);
      if (!p) { p = { id, name: newName, planner: false, joined_at: new Date().toISOString() }; d.people.push(p); }
      if (hash) p.planner = true;
    });
    S.meId = id; local.set('me', id);
    S.myHash = hash; local.set('plannerHash', hash);
    $('#whoPass').value = ''; $('#whoNew').value = '';
    route();
  }

  /* ---------- clicks ---------- */
  const armed = new Set();
  function confirmTwice(btn, key) {
    if (armed.has(key)) { armed.delete(key); return true; }
    armed.add(key); btn.classList.add('armed'); btn.textContent = 'Click again to confirm';
    setTimeout(() => { if (armed.delete(key)) render(); }, 4000);
    return false;
  }

  document.addEventListener('click', async (e) => {
    const tab = e.target.closest('.tabs button');
    if (tab) { setTab(tab.dataset.tab); return; }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const { act, id } = b.dataset;
    try {
      switch (act) {
        case 'pick': b.disabled = true; return await identify(id);
        case 'new-item': return openItemForm(null);
        case 'edit-item': return openItemForm(D().items.find((i) => i.id === id));
        case 'new-sug': return openSugForm();
        case 'cancel': return closeForm();
        case 'edit-trip': return openTripForm();
        case 'cancel-trip': $('#tripFormSlot').innerHTML = ''; return renderChrome();
        case 'rename': return openSmallForm('rename', 'Change your name', `<label>Name<input id="r-name" maxlength="40" required value="${esc(me().name)}"></label>`);
        case 'unlock': return openSmallForm('unlock', 'Unlock planning tools', '<label>Planner passcode<input id="u-pass" type="password" required autocomplete="current-password"></label>');
        case 'change-pass': return openSmallForm('change-pass', 'Change planner passcode', '<label>New passcode<input id="c-pass" type="password" minlength="4" required autocomplete="new-password"></label>');
        case 'people': S.openPeople.has(id) ? S.openPeople.delete(id) : S.openPeople.add(id); return render();
        case 'promote': {
          const s = D().sugs.find((x) => x.id === id); if (!s) return;
          setTab('itinerary');
          return openItemForm({ title: s.title, location: s.location, link: s.link, notes: s.why }, s.id);
        }
        case 'backup': return downloadBackup();
        case 'restore': return $('#restoreFile').click();
      }
      if (act === 'del-item') {
        if (!confirmTwice(b, 'i' + id)) return;
        await mutate((d) => { d.items = d.items.filter((x) => x.id !== id); d.rsvps = d.rsvps.filter((r) => r.item_id !== id); });
        toast('Activity deleted');
      } else if (act === 'del-sug') {
        if (!confirmTwice(b, 's' + id)) return;
        await mutate((d) => { d.sugs = d.sugs.filter((x) => x.id !== id); d.votes = d.votes.filter((v) => v.suggestion_id !== id); });
        toast('Suggestion removed');
      } else if (act === 'remove-person') {
        if (!confirmTwice(b, 'p' + id)) return;
        await mutate((d) => { d.people = d.people.filter((x) => x.id !== id); d.rsvps = d.rsvps.filter((r) => r.user_id !== id); d.votes = d.votes.filter((v) => v.user_id !== id); });
        toast('Removed from the trip');
      } else if (act === 'rsvp') {
        b.disabled = true;
        const s = b.dataset.s;
        await mutate((d) => {
          const i = d.rsvps.findIndex((r) => r.item_id === id && r.user_id === S.meId);
          if (i >= 0 && d.rsvps[i].status === s) d.rsvps.splice(i, 1);
          else if (i >= 0) d.rsvps[i].status = s;
          else d.rsvps.push({ item_id: id, user_id: S.meId, status: s, note: null });
        });
      } else if (act === 'like') {
        b.disabled = true;
        await mutate((d) => {
          const i = d.votes.findIndex((v) => v.suggestion_id === id && v.user_id === S.meId);
          if (i >= 0) d.votes.splice(i, 1); else d.votes.push({ suggestion_id: id, user_id: S.meId });
        });
      }
    } catch (err) {
      fail(err);
      if (document.body.contains(b)) b.disabled = false;
    }
  });

  async function commitNote(input) {
    const id = input.dataset.note, note = input.value.trim().slice(0, 140);
    const mine = myAnswer(id); if (!mine || (mine.note || '') === note) return;
    try { await mutate((d) => { const r = d.rsvps.find((x) => x.item_id === id && x.user_id === S.meId); if (r) r.note = note || null; }); }
    catch (err) { fail(err); }
  }
  document.addEventListener('change', (e) => { if (e.target.matches('input[data-note]')) commitNote(e.target); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input[data-note]')) { e.preventDefault(); e.target.blur(); } });

  function setTab(t) {
    if (!TABS.includes(t)) t = 'itinerary';
    S.tab = t; local.set('tab', t);
    const keep = S.form && ((S.form.kind === 'item' && t === 'itinerary') || (S.form.kind === 'sug' && t === 'suggestions'));
    if (!keep) { S.form = null; $('#formSlot').innerHTML = ''; }
    render();
  }

  $('#switchPerson').addEventListener('click', () => {
    S.meId = null; S.myHash = null; local.set('me', null); local.set('plannerHash', null);
    S.form = null; $('#formSlot').innerHTML = ''; $('#tripFormSlot').innerHTML = '';
    route();
  });

  /* ---------- backups ---------- */
  function downloadBackup() {
    const blob = new Blob([JSON.stringify(D(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trip-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('#restoreFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try {
      const doc = JSON.parse(await file.text());
      if (!validDoc(doc)) { toast('That file isn’t a trip backup.'); return; }
      S.busy = true;
      try {
        // Compare against the latest saved copy, not what this page last saw. If the stored
        // data is damaged, fall back to this page's copy (restoring is how that gets fixed).
        const cur = parseDoc(await fetchRaw()) || D() || emptyDoc();
        const backupIds = new Set(doc.people.map((p) => p.id));
        const keep = cur.people.filter((p) => !backupIds.has(p.id)); // joined after the backup
        const when = doc.updated_at ? new Date(doc.updated_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'an unknown date';
        const n = (k, d) => `${d[k].length} ${k === 'items' ? 'activities' : k === 'sugs' ? 'suggestions' : 'people'}`;
        const msg = `Replace the current trip (${n('items', cur)}, ${n('sugs', cur)}, ${n('people', cur)}) `
          + `with the backup from ${when} (${n('items', doc)}, ${n('sugs', doc)}, ${n('people', doc)})?\n\n`
          + 'Everything changed since that backup will be lost.'
          + (keep.length ? `\n\n${keep.length === 1 ? 'This person is' : 'These people are'} not in the backup and will be kept: ${keep.map((p) => p.name).join(', ')}.` : '')
          + '\n\nThe current planner passcode stays the same.';
        if (!confirm(msg)) return;
        doc.people.push(...keep);
        doc.plannerHash = cur.plannerHash || doc.plannerHash; // never bring back an old passcode
        doc.updated_at = new Date().toISOString();
        await saveDoc(doc);
      } finally {
        S.busy = false;
      }
      toast('Backup restored'); route();
    } catch (err) { fail(err); }
  });

  /* ---------- boot ---------- */
  async function boot() {
    const t = local.get('tab'); if (TABS.includes(t)) S.tab = t;
    S.meId = local.get('me'); S.myHash = local.get('plannerHash');
    if (!STORE) { banner('This site has no storage address set in js/config.js.'); return; }
    try {
      const text = await fetchRaw();
      S.raw = text; S.doc = parseDoc(text);
      if (!S.doc && text) banner('The trip data looks damaged. A planner can restore a backup from the People tab.');
    } catch (e) {
      console.error(e);
      banner('Can’t reach the trip data. Check your connection and reload the page.');
      $('#tripDest').textContent = '';
      return;
    }
    route();
    setInterval(refresh, POLL_MS);
    document.addEventListener('visibilitychange', refresh);
  }
  boot();
})();
