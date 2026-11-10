// Group Trip Planner — static front end for GitHub Pages, backed by Supabase.
// Permissions are enforced by the database (supabase/schema.sql); this page only hides
// controls a person can't use and explains refusals.
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
  const blankToNull = (v) => (v && v.trim() ? v.trim() : null);
  const STATUS = { going: 'Going', maybe: 'Maybe', no: 'Not going' };
  const KINDS = { activity: 'Activity', place: 'Place', food: 'Food & drink', stay: 'Stay', other: 'Other' };
  const TABS = ['itinerary', 'suggestions', 'interest', 'people'];

  const S = {
    session: null, uid: null, me: null,
    trip: null, members: [], items: [], sugs: [], rsvps: [], votes: [], codes: null,
    tab: 'itinerary', openPeople: new Set(), form: null, pendingRender: false, loaded: false,
  };
  let sb = null;

  /* ---------- small helpers ---------- */
  let toastT;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3500);
  }
  function banner(msg) { const b = $('#banner'); b.hidden = !msg; b.textContent = msg || ''; }
  function show(view) {
    for (const id of ['setupView', 'signInView', 'joinView', 'appView']) $('#' + id).hidden = id !== view;
  }
  function friendlyError(e) {
    const code = e && e.code;
    if (code === '42501' || /row-level security|permission denied/i.test(e && e.message)) {
      return "You don't have permission to do that. Ask a planner if you think you should.";
    }
    if (code === '23514') return 'Some of those details aren’t valid. Check the fields (links must start with http:// or https://).';
    if (code === 'P0001') return e.message; // messages raised by our own database functions
    if (e && /fetch|network/i.test(e.message)) return 'Couldn’t reach the trip database. Check your connection and try again.';
    return (e && e.message) || 'Something went wrong. Try again.';
  }
  async function run(promise) {
    const { data, error } = await promise;
    if (error) throw error;
    return data;
  }
  function fail(e) { console.error(e); toast(friendlyError(e)); }

  const isPlanner = () => S.me && S.me.role === 'planner';
  const nameOf = (uid) => { const m = S.members.find((x) => x.user_id === uid); return m ? m.display_name : 'Former member'; };
  function dot(uid) {
    let h = 0; for (const c of String(uid)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const initials = nameOf(uid).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    return `<span class="dot" aria-hidden="true" style="background:hsl(${h % 360} 45% 42%)">${esc(initials)}</span>`;
  }

  /* ---------- dates ---------- */
  const parseDay = (d) => (d ? new Date(d + 'T00:00:00') : null);
  const fmtDay = (d) => parseDay(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const hhmm = (t) => (t ? String(t).slice(0, 5) : '');
  function fmtRange(a, b) {
    if (!a) return 'Group trip';
    const o = { day: 'numeric', month: 'short', year: 'numeric' };
    return b && b !== a ? `${parseDay(a).toLocaleDateString(undefined, o)} – ${parseDay(b).toLocaleDateString(undefined, o)}` : parseDay(a).toLocaleDateString(undefined, o);
  }
  function dayNumber(d) {
    const s = S.trip && S.trip.start_date; if (!s || !d) return null;
    const n = Math.round((parseDay(d) - parseDay(s)) / 864e5) + 1;
    return n >= 1 ? n : null;
  }

  /* ---------- derived data ---------- */
  const answersFor = (itemId) => {
    const order = { going: 0, maybe: 1, no: 2 };
    return S.rsvps.filter((r) => r.item_id === itemId).sort((a, b) => order[a.status] - order[b.status]);
  };
  const myAnswer = (itemId) => S.rsvps.find((r) => r.item_id === itemId && r.user_id === S.uid) || null;
  const likesFor = (sid) => S.votes.filter((v) => v.suggestion_id === sid).length;
  const iLike = (sid) => S.votes.some((v) => v.suggestion_id === sid && v.user_id === S.uid);
  const sortedItems = () => [...S.items].sort((a, b) =>
    (a.day || '9999').localeCompare(b.day || '9999') || (a.start_time || '99').localeCompare(b.start_time || '99') || a.title.localeCompare(b.title));

  /* ---------- loading ---------- */
  async function loadAll() {
    try {
      const [trip, members, items, sugs, rsvps, votes] = await Promise.all([
        run(sb.from('trip').select('*').eq('id', 1).maybeSingle()),
        run(sb.from('members').select('*').order('display_name')),
        run(sb.from('itinerary').select('*')),
        run(sb.from('suggestions').select('*')),
        run(sb.from('rsvps').select('*')),
        run(sb.from('suggestion_votes').select('*')),
      ]);
      Object.assign(S, { trip, members, items, sugs, rsvps, votes, loaded: true });
      S.me = members.find((m) => m.user_id === S.uid) || null;
      banner('');
      return true;
    } catch (e) {
      console.error(e);
      banner('Couldn’t load the trip. Check your connection, then reload the page.');
      return false;
    }
  }
  let reloadT;
  function scheduleReload() { clearTimeout(reloadT); reloadT = setTimeout(async () => { await loadAll(); route(); }, 250); }
  let channel = null;
  function subscribe() {
    if (channel) return;
    channel = sb.channel('trip-changes')
      .on('postgres_changes', { event: '*', schema: 'public' }, scheduleReload)
      .subscribe();
  }

  /* ---------- routing between sign-in, join and the app ---------- */
  async function route() {
    if (!S.session) { show('signInView'); $('#whoChip').hidden = true; renderHeader(); return; }
    if (!S.loaded) await loadAll();
    if (!S.me) { show('joinView'); renderHeader(); return; }
    show('appView');
    subscribe();
    render();
  }

  /* ---------- rendering ---------- */
  function renderHeader() {
    const t = S.trip;
    $('#tripName').textContent = (t && t.name) || 'Group Trip Planner';
    $('#tripDates').textContent = t ? fmtRange(t.start_date, t.end_date) : 'Group trip';
    const dest = $('#tripDest');
    if (!S.session) dest.textContent = 'Plan the trip together: one itinerary, everyone’s ideas, and who’s going to what.';
    else if (!S.me) dest.textContent = 'You’re signed in. Join the trip to see the plan.';
    else if (t && t.destination) dest.textContent = t.destination + (t.group_size ? ` · ${t.group_size} travellers` : '');
    else dest.textContent = isPlanner() ? 'Add the destination and dates with “Edit trip details”.' : 'The planning team hasn’t added trip details yet.';

    const chip = $('#whoChip');
    chip.hidden = !S.session;
    $('#whoName').textContent = S.me ? S.me.display_name : (S.session && S.session.user.email) || '';
    $('#whoRole').textContent = S.me ? (isPlanner() ? 'Planning team' : 'Suggester') : 'Not joined yet';
  }

  function renderChrome() {
    $('#cItin').textContent = S.items.length || '';
    $('#cSug').textContent = S.sugs.length || '';
    $('#cPeople').textContent = S.members.length || '';
    const r = isPlanner() ? 'planner' : 'member';
    const notes = {
      itinerary: { planner: 'You’re on the planning team: you can add, edit and remove itinerary activities.', member: 'Only the planning team changes the itinerary. Tell them if you’re going to each activity, or add ideas under Suggestions.' },
      suggestions: { planner: 'Anyone in the group can suggest ideas. Use “Add to itinerary” to move one into the plan.', member: 'Add places or activities you’d like to do. You can remove your own suggestions; the planning team can move them into the itinerary.' },
      interest: { planner: 'Everyone’s answers for every activity, so you can see headcounts and who hasn’t replied.', member: 'Everyone’s answers for every activity. Change yours on the Itinerary tab.' },
      people: { planner: 'Share an invite code to bring people in. The planner code makes someone part of the planning team.', member: 'Everyone on the trip. Planners can change roles.' },
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
      <div class="time">${esc(hhmm(it.start_time) || '—')}${it.end_time ? `<small>to ${esc(hhmm(it.end_time))}</small>` : ''}</div>
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
    if (!S.sugs.length) return h + '<div class="empty"><h3>No suggestions yet</h3><p>Add a place, food spot or activity you’d like the group to consider.</p></div>';
    const list = [...S.sugs].sort((a, b) => likesFor(b.id) - likesFor(a.id) || b.created_at.localeCompare(a.created_at));
    return h + '<div class="sgrid">' + list.map((s) => {
      const link = safeUrl(s.link);
      const canDel = s.created_by === S.uid || isPlanner();
      const onItin = s.promoted_to && S.items.some((i) => i.id === s.promoted_to);
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
    const people = [...S.members].sort((a, b) => (b.user_id === S.uid) - (a.user_id === S.uid) || a.display_name.localeCompare(b.display_name));
    const replied = new Set(S.rsvps.map((r) => r.user_id));
    const size = (S.trip && S.trip.group_size) || 0;
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
      h += `<tr><td class="name"><div class="person">${dot(p.user_id)}<b>${esc(p.display_name)}</b></div></td>`;
      for (const it of items) {
        const a = S.rsvps.find((r) => r.item_id === it.id && r.user_id === p.user_id);
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
      if (S.codes) {
        h += `<div class="panel"><h2>Invite codes</h2><p class="note">Send people this page’s link and the right code. They sign in with their email, then enter the code.</p>
          ${S.codes.map((c) => `<div class="actions"><b style="min-width:110px">${c.role === 'planner' ? 'Planning team' : 'Suggesters'}</b><span class="code">${esc(c.code)}</span><button type="button" class="btn small" data-act="copy" data-code="${esc(c.code)}">Copy</button></div>`).join('')}</div>`;
      } else {
        h += '<div class="actions"><button type="button" class="btn" data-act="show-codes">Show invite codes</button></div>';
      }
    }
    h += '<div class="mlist">' + S.members.map((m) => {
      const self = m.user_id === S.uid;
      const tools = [];
      if (self) tools.push('<button type="button" class="btn small" data-act="rename">Change my name</button>');
      if (isPlanner() && !self) {
        tools.push(m.role === 'planner'
          ? `<button type="button" class="btn small" data-act="set-role" data-id="${esc(m.user_id)}" data-role="member">Make suggester</button>`
          : `<button type="button" class="btn small" data-act="set-role" data-id="${esc(m.user_id)}" data-role="planner">Make planner</button>`);
        tools.push(`<button type="button" class="btn small danger" data-act="remove-member" data-id="${esc(m.user_id)}">Remove</button>`);
      }
      return `<div class="mrow"><div class="person">${dot(m.user_id)}<b>${esc(m.display_name)}${self ? ' (you)' : ''}</b><span class="role ${m.role}">${m.role === 'planner' ? 'Planning team' : 'Suggester'}</span></div><div class="tools">${tools.join('')}</div></div>`;
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
    const t = S.trip || {};
    $('#formSlot').innerHTML = `<form class="panel" data-form="item"><h2>${v.id ? 'Edit activity' : 'Add activity'}</h2>
      <div class="fields">
        <label class="wide">Activity<input id="f-title" required maxlength="120" value="${esc(v.title)}" placeholder="e.g. Sunrise hike up the ridge"></label>
        <label>Date<input id="f-date" type="date" value="${esc(v.day)}" min="${esc(t.start_date)}" max="${esc(t.end_date)}"></label>
        <label>Start time<input id="f-time" type="time" value="${esc(hhmm(v.start_time))}"></label>
        <label>End time<input id="f-end" type="time" value="${esc(hhmm(v.end_time))}"></label>
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
    const t = S.trip || {};
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
  function openRenameForm() {
    S.form = { kind: 'rename' };
    $('#formSlot').innerHTML = `<form class="panel narrow" data-form="rename"><h2>Change your name</h2>
      <label>Name<input id="r-name" maxlength="40" required value="${esc(S.me.display_name)}"></label>
      <div class="actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-act="cancel">Cancel</button></div></form>`;
    $('#r-name').focus();
  }
  function closeForm() { S.form = null; $('#formSlot').innerHTML = ''; render(); }

  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('form'); if (!f) return;
    e.preventDefault();
    const btn = f.querySelector('[type=submit]'); if (btn) btn.disabled = true;
    try {
      if (f.id === 'signInView') return await signIn();
      if (f.id === 'joinView') return await join();
      const kind = f.dataset.form;
      if (kind === 'item') {
        const row = { title: val('f-title'), day: val('f-date') || null, start_time: val('f-time') || null, end_time: val('f-end') || null,
          location: blankToNull(val('f-loc')), link: blankToNull(val('f-link')), notes: blankToNull(val('f-notes')), updated_at: new Date().toISOString() };
        if (S.form.id) {
          await run(sb.from('itinerary').update(row).eq('id', S.form.id));
          toast('Activity updated');
        } else {
          const created = await run(sb.from('itinerary').insert(row).select('id').single());
          if (S.form.fromSug) await run(sb.from('suggestions').update({ promoted_to: created.id }).eq('id', S.form.fromSug));
          toast('Added to the itinerary');
        }
        S.form = null; $('#formSlot').innerHTML = '';
      } else if (kind === 'sug') {
        await run(sb.from('suggestions').insert({ title: val('s-title'), kind: val('s-kind'), location: blankToNull(val('s-loc')), link: blankToNull(val('s-link')), why: blankToNull(val('s-why')) }));
        toast('Suggestion added');
        S.form = null; $('#formSlot').innerHTML = '';
      } else if (kind === 'trip') {
        const size = Number(val('t-size'));
        await run(sb.from('trip').update({ name: val('t-name'), destination: blankToNull(val('t-dest')), start_date: val('t-start') || null,
          end_date: val('t-end') || null, group_size: size >= 1 ? size : null, updated_at: new Date().toISOString() }).eq('id', 1));
        $('#tripFormSlot').innerHTML = '';
        toast('Trip details saved');
      } else if (kind === 'rename') {
        await run(sb.from('members').update({ display_name: val('r-name') }).eq('user_id', S.uid));
        toast('Name updated');
        S.form = null; $('#formSlot').innerHTML = '';
      }
      await loadAll(); render();
    } catch (err) {
      fail(err);
    } finally {
      if (btn && document.body.contains(btn)) btn.disabled = false;
    }
  });

  /* ---------- clicks ---------- */
  const armed = new Set();
  function confirmTwice(btn, key) {
    if (armed.has(key)) { armed.delete(key); return true; }
    armed.add(key); btn.classList.add('armed'); btn.textContent = 'Click again to confirm';
    setTimeout(() => { if (armed.delete(key)) render(); }, 4000);
    return false;
  }

  async function setRsvp(itemId, status) {
    const mine = myAnswer(itemId);
    if (mine && mine.status === status) {
      await run(sb.from('rsvps').delete().eq('item_id', itemId).eq('user_id', S.uid));
    } else {
      await run(sb.from('rsvps').upsert({ item_id: itemId, user_id: S.uid, status, note: mine ? mine.note : null, updated_at: new Date().toISOString() },
        { onConflict: 'item_id,user_id' }));
    }
  }

  document.addEventListener('click', async (e) => {
    const tab = e.target.closest('.tabs button');
    if (tab) { setTab(tab.dataset.tab); return; }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const { act, id } = b.dataset;
    try {
      switch (act) {
        case 'new-item': return openItemForm(null);
        case 'edit-item': return openItemForm(S.items.find((i) => i.id === id));
        case 'new-sug': return openSugForm();
        case 'cancel': return closeForm();
        case 'edit-trip': return openTripForm();
        case 'cancel-trip': $('#tripFormSlot').innerHTML = ''; return renderChrome();
        case 'rename': return openRenameForm();
        case 'people': S.openPeople.has(id) ? S.openPeople.delete(id) : S.openPeople.add(id); return render();
        case 'promote': {
          const s = S.sugs.find((x) => x.id === id); if (!s) return;
          setTab('itinerary');
          return openItemForm({ title: s.title, location: s.location, link: s.link, notes: s.why }, s.id);
        }
        case 'copy': {
          try { await navigator.clipboard.writeText(b.dataset.code); toast('Code copied'); } catch { toast('Select the code and copy it'); }
          return;
        }
        case 'show-codes': S.codes = await run(sb.rpc('planner_invite_codes')); return render();
      }
      // Everything below writes to the database.
      if (act === 'del-item') { if (!confirmTwice(b, 'i' + id)) return; await run(sb.from('itinerary').delete().eq('id', id)); toast('Activity deleted'); }
      else if (act === 'del-sug') { if (!confirmTwice(b, 's' + id)) return; await run(sb.from('suggestions').delete().eq('id', id)); toast('Suggestion removed'); }
      else if (act === 'remove-member') { if (!confirmTwice(b, 'm' + id)) return; await run(sb.from('members').delete().eq('user_id', id)); toast('Removed from the trip'); }
      else if (act === 'set-role') { await run(sb.rpc('set_member_role', { target: id, new_role: b.dataset.role })); toast('Role updated'); }
      else if (act === 'rsvp') { b.disabled = true; await setRsvp(id, b.dataset.s); }
      else if (act === 'like') {
        b.disabled = true;
        if (iLike(id)) await run(sb.from('suggestion_votes').delete().eq('suggestion_id', id).eq('user_id', S.uid));
        else await run(sb.from('suggestion_votes').insert({ suggestion_id: id, user_id: S.uid }));
      }
      else return;
      await loadAll(); render();
    } catch (err) {
      fail(err);
      if (document.body.contains(b)) b.disabled = false;
    }
  });

  async function commitNote(input) {
    const id = input.dataset.note, note = input.value.trim().slice(0, 140);
    const mine = myAnswer(id); if (!mine || (mine.note || '') === note) return;
    try {
      await run(sb.from('rsvps').update({ note: note || null, updated_at: new Date().toISOString() }).eq('item_id', id).eq('user_id', S.uid));
      await loadAll(); render();
    } catch (err) { fail(err); }
  }
  document.addEventListener('change', (e) => { if (e.target.matches('input[data-note]')) commitNote(e.target); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input[data-note]')) { e.preventDefault(); e.target.blur(); } });

  function setTab(t) {
    if (!TABS.includes(t)) t = 'itinerary';
    S.tab = t;
    try { localStorage.setItem('trip.tab', t); } catch { /* storage unavailable */ }
    const keep = S.form && ((S.form.kind === 'item' && t === 'itinerary') || (S.form.kind === 'sug' && t === 'suggestions'));
    if (!keep) { S.form = null; $('#formSlot').innerHTML = ''; }
    render();
  }

  /* ---------- auth ---------- */
  async function signIn() {
    const email = val('signInEmail');
    $('#signInError').hidden = true;
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) {
      $('#signInError').textContent = /rate limit/i.test(error.message)
        ? 'Too many sign-in emails were sent in the last hour. Wait a while and try again.'
        : friendlyError(error);
      $('#signInError').hidden = false;
      return;
    }
    const sent = $('#signInSent');
    sent.textContent = `Check your email at ${email} and open the link on this device. You can close this tab.`;
    sent.hidden = false;
  }
  async function join() {
    $('#joinError').hidden = true;
    try {
      await run(sb.rpc('join_trip', { invite_code: val('joinCode'), name: val('joinName') }));
      S.loaded = false;
      await route();
      toast('Welcome to the trip!');
    } catch (err) {
      $('#joinError').textContent = friendlyError(err);
      $('#joinError').hidden = false;
    }
  }
  $('#signOut').addEventListener('click', async () => { await sb.auth.signOut(); });

  /* ---------- boot ---------- */
  function boot() {
    try { const t = localStorage.getItem('trip.tab'); if (TABS.includes(t)) S.tab = t; } catch { /* storage unavailable */ }
    const cfg = window.TRIP_CONFIG || {};
    if (!cfg.supabaseUrl || !cfg.supabaseKey || !window.supabase) {
      show('setupView'); $('#tripDest').textContent = 'Setup needed.';
      if (!window.supabase) banner('Couldn’t load the Supabase library. Check your connection and reload.');
      return;
    }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
    let first = true;
    sb.auth.onAuthStateChange((_event, session) => {
      const uid = session ? session.user.id : null;
      const changed = first || uid !== S.uid;
      first = false;
      S.session = session; S.uid = uid;
      if (changed) {
        Object.assign(S, { loaded: false, me: null, codes: null, form: null });
        if (!session && channel) { sb.removeChannel(channel); channel = null; }
        // Run outside the auth callback so Supabase calls inside route() don't deadlock.
        setTimeout(route, 0);
      }
    });
    renderHeader();
  }
  boot();
})();
