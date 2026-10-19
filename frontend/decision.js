// 결정 버튼 cards. server/decision-hook registers each AskUserQuestion with the metrics server and steps aside, so the
// same question is open in the terminal picker too. An answer here (api.decide) is typed into that picker by the
// server through the session's Orca terminal; when it cannot (no Orca terminal, the picker not as expected) the card
// says so and the question is answered in the terminal. An answer in the terminal closes the card. A lone
// single-choice question sends on click, several questions or a multiSelect send together with 「답 보내기」, typed
// text only on single-choice questions.
// Cards live in #decisions, outside #view, which every refresh rebuilds. A card is built once per request id and
// later refreshes only touch its meta and status lines, so picks, typed text, focus and an IME composition
// survive (a periodic re-render wiping input is the bug the 8799 page hit first).
const decisions = (() => {
  const box = document.getElementById('decisions');
  const cards = new Map();  // request id -> {el, r, ans, sentAt}
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const who = (r, o) => o ? (o.href ? `<a href="${esc(o.href)}">${esc(o.name)}</a>` : esc(o.name)) : esc(r.agent || '에이전트');
  const since = t => { const s = Math.max(0, Math.round(Date.now() / 1000 - t)); return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.round(s / 60)}분 전` : `${Math.round(s / 3600)}시간 전`; };
  const needsSubmit = r => r.questions.length > 1 || r.questions.some(q => q.multiSelect);
  // A single-choice answer is {label} or {text}; a multiSelect one is a Set of labels.
  const answerOf = (q, a) => q.multiSelect ? (a.size ? [...a] : null) : (a.text || a.label || null);
  const complete = c => c.r.questions.every((q, i) => answerOf(q, c.ans[i]) !== null);
  const SENT_HOLD = 8000;  // a sent card stays greyed this long while the next snapshot catches up

  function setStatus(c, text, err) {
    const st = c.el.querySelector('.dc-status');
    st.textContent = text || '';
    st.classList.toggle('err', !!err);
  }

  async function send(c) {
    c.sentAt = Date.now();
    c.el.classList.add('done');
    setStatus(c, '터미널에 입력하는 중…');
    let res;
    try { res = await api.decide(c.r.id, c.r.questions.map((q, i) => answerOf(q, c.ans[i]))); }
    catch { res = { status: 0, body: { error: '대시보드 서버에 보내지 못했습니다' } }; }
    if (res.status === 200) return setStatus(c, '터미널에 답을 넣었습니다');
    if (res.body?.closed) return document.getElementById('toast')?.show?.(res.body.error);  // the card goes on the next refresh
    c.sentAt = 0;
    c.el.classList.remove('done');  // a question answered elsewhere goes on the next refresh
    setStatus(c, res.body?.error || `전송 실패 (${res.status})`, true);
  }

  // Picks only: the input boxes are never rebuilt, so text being typed stays.
  function sync(c) {
    c.r.questions.forEach((q, qi) => {
      const a = c.ans[qi], qel = c.el.querySelector(`.dc-q[data-qi="${qi}"]`);
      qel.querySelectorAll('button.dc-opt').forEach(b => {
        const label = q.options[+b.dataset.i].label;
        b.classList.toggle('picked', q.multiSelect ? a.has(label) : (!a.text && a.label === label));
      });
      qel.querySelector('input')?.classList.toggle('filled', !!a.text);
    });
    const sub = c.el.querySelector('.dc-submit');
    if (sub) sub.disabled = !complete(c);
  }

  function build(r) {
    const el = document.createElement('section');
    el.className = 'dc-card';
    el.dataset.id = r.id;
    el.innerHTML = `<div class="dc-meta"></div>
      ${r.context ? `<p class="dc-context">${esc(r.context)}</p>` : ''}
      ${r.questions.map((q, qi) => `<div class="dc-q" data-qi="${qi}">
        ${q.header ? `<span class="dc-tag">${esc(q.header)}</span>` : ''}
        <h3>${esc(q.question)}</h3>
        ${q.multiSelect ? '<p class="dc-hint">여러 개 고를 수 있습니다</p>' : ''}
        <div class="dc-options">${q.options.map((o, i) => `<button class="dc-opt" data-i="${i}">
          <span class="dc-label">${q.multiSelect ? '<span class="dc-check">✓</span>' : ''}${esc(o.label)}</span>
          ${o.description ? `<span class="dc-desc">${esc(o.description)}</span>` : ''}</button>`).join('')}</div>
        ${q.multiSelect ? '' : `<form class="dc-other"><input placeholder="직접 입력 (기타)" autocomplete="off"><button>${needsSubmit(r) ? '입력' : '보내기'}</button></form>`}
      </div>`).join('')}
      <p class="dc-hint">터미널에도 같은 선택지가 떠 있습니다. 여기서 고르면 터미널에 대신 입력합니다.</p>
      ${needsSubmit(r) ? '<div class="dc-actions"><button class="dc-submit" disabled>답 보내기</button></div>' : ''}
      <div class="dc-status"></div>`;
    const c = { el, r, ans: r.questions.map(q => q.multiSelect ? new Set() : {}), sentAt: 0 };
    el.querySelectorAll('.dc-q').forEach(qel => {
      const qi = +qel.dataset.qi, q = r.questions[qi];
      qel.querySelectorAll('button.dc-opt').forEach(b => b.onclick = () => {
        const label = q.options[+b.dataset.i].label;
        if (q.multiSelect) { const s = c.ans[qi]; s.has(label) ? s.delete(label) : s.add(label); }
        else {
          c.ans[qi] = { label };
          const inp = qel.querySelector('input'); if (inp) inp.value = '';
          if (!needsSubmit(r)) return send(c);
        }
        sync(c);
      });
      const form = qel.querySelector('form');
      if (form) {
        const inp = form.querySelector('input');
        inp.oninput = () => { c.ans[qi] = inp.value.trim() ? { text: inp.value.trim() } : {}; sync(c); };
        form.onsubmit = e => {
          e.preventDefault();
          if (!inp.value.trim()) return;
          c.ans[qi] = { text: inp.value.trim() };
          if (!needsSubmit(r)) return send(c);
          sync(c);
        };
      }
    });
    const sub = el.querySelector('.dc-submit');
    if (sub) sub.onclick = () => send(c);
    return c;
  }

  function update(c, owner) {
    const r = c.r, o = owner(r);
    c.el.querySelector('.dc-meta').innerHTML = `<b>결정 대기</b> · ${who(r, o)}${o?.badge || ''} · ${since(r.created_at)}`;
    const held = c.sentAt && Date.now() - c.sentAt < SENT_HOLD;
    if (r.error) { c.sentAt = 0; c.el.classList.remove('done'); setStatus(c, r.error + ' — 다시 답할 수 있습니다', true); }
    else if (!held) { c.sentAt = 0; c.el.classList.remove('done'); if (!c.el.querySelector('.dc-status.err')) setStatus(c, ''); }
  }

  return {
    esc, who, since,
    // Show exactly `items` (8799 requests) in #decisions. A card for a request still in `pending` but not shown
    // on this screen is detached and kept, so its picks come back with it; owner(r) -> {name, href?} names the
    // session the request belongs to, and its badge (HTML) the metric server it came from.
    show(items, pending, owner = () => null) {
      const live = new Set(pending.map(r => r.id)), here = new Set(items.map(r => r.id));
      for (const [id, c] of cards) {
        if (!live.has(id)) { c.el.remove(); cards.delete(id); }
        else if (!here.has(id)) c.el.remove();
      }
      for (const r of items) {
        let c = cards.get(r.id);
        if (!c) { c = build(r); cards.set(r.id, c); }
        if (!c.el.isConnected) box.appendChild(c.el);  // a card on screen is never moved (focus, IME)
        c.r = r;
        update(c, owner);
        sync(c);
      }
      box.hidden = !items.length;
    },
  };
})();

// 메일함: questions 메일함 mode filed while the user was away. The hook denied each one, so the agent went on with
// the recommended option (or its own call) and was asked to write its pick down; the server shows that line once the
// transcript has it (r.chosen), else the recommended options it worked out (r.recommended). 「확인」 marks an item
// read. Picking other answers and 「세션에 바꾸라고 알리기」 has the server send the session a follow-up message
// (api.inbox); an item can be answered again later. Cards are built once per item, like the 결정 버튼 cards.
const inbox = (() => {
  const box = document.getElementById('inbox');
  box.innerHTML = '<div class="sec-h"><h2></h2><span>자리를 비운 동안 들어온 질문입니다. 에이전트는 이미 진행했습니다.</span></div><div class="ib-list"></div>';
  const list = box.querySelector('.ib-list'), head = box.querySelector('h2');
  const { esc, who, since } = decisions;
  const cards = new Map();  // item id -> {el, r, ans}
  const answerOf = (q, a) => q.multiSelect ? (a.size ? [...a] : null) : (a.text || a.label || null);

  function setStatus(c, text, err) {
    const st = c.el.querySelector('.dc-status');
    st.textContent = text || '';
    st.classList.toggle('err', !!err);
  }

  async function act(c, action) {
    c.el.classList.add('busy');
    setStatus(c, action === 'answer' ? '세션에 보내는 중…' : '');
    let res;
    try { res = await api.inbox(c.r.id, action, action === 'answer' ? c.r.questions.map((q, i) => answerOf(q, c.ans[i])) : undefined); }
    catch { res = { status: 0, body: { error: '대시보드 서버에 보내지 못했습니다' } }; }
    c.el.classList.remove('busy');
    if (res.status !== 200) return setStatus(c, res.body?.error || `전송 실패 (${res.status})`, true);
    if (action === 'answer') {
      c.ans = c.r.questions.map(q => q.multiSelect ? new Set() : {});
      c.el.querySelectorAll('.dc-other input').forEach(i => i.value = '');
      sync(c);
      setStatus(c, '세션에 바꾸라는 메시지를 보냈습니다');
    } else {  // shown at once; the next snapshot says the same
      setStatus(c, '');
      c.r = { ...c.r, read: action === 'read' };
      c.el.classList.toggle('read', c.r.read);
      c.el.querySelector('.ib-read').textContent = c.r.read ? '안읽음으로' : '확인';
    }
  }

  function sync(c) {
    c.r.questions.forEach((q, qi) => {
      const a = c.ans[qi], qel = c.el.querySelector(`.dc-q[data-qi="${qi}"]`);
      qel.querySelectorAll('button.dc-opt').forEach(b => {
        const label = q.options[+b.dataset.i].label;
        b.classList.toggle('picked', q.multiSelect ? a.has(label) : (!a.text && a.label === label));
      });
      qel.querySelector('input')?.classList.toggle('filled', !!a.text);
    });
    c.el.querySelector('.dc-submit').disabled = !c.r.questions.some((q, i) => answerOf(q, c.ans[i]) !== null);
  }

  function build(r) {
    const el = document.createElement('section');
    el.className = 'dc-card ib-card';
    el.dataset.id = r.id;
    el.innerHTML = `<div class="dc-meta"></div><p class="ib-went"></p>
      ${r.questions.map((q, qi) => `<div class="dc-q" data-qi="${qi}">
        ${q.header ? `<span class="dc-tag">${esc(q.header)}</span>` : ''}
        <h3>${esc(q.question)}</h3>
        <div class="dc-options">${q.options.map((o, i) => `<button class="dc-opt" data-i="${i}">
          <span class="dc-label">${q.multiSelect ? '<span class="dc-check">✓</span>' : ''}${esc(o.label)}${o.label === r.recommended?.[qi] ? '<span class="ib-rec">권장</span>' : ''}</span>
          ${o.description ? `<span class="dc-desc">${esc(o.description)}</span>` : ''}</button>`).join('')}</div>
        ${q.multiSelect ? '' : '<form class="dc-other"><input placeholder="직접 입력 (기타)" autocomplete="off"></form>'}
      </div>`).join('')}
      <p class="ib-follow"></p>
      <div class="dc-actions"><button class="dc-submit" disabled>세션에 바꾸라고 알리기</button><button class="dc-release ib-read"></button></div>
      <div class="dc-status"></div>`;
    const c = { el, r, ans: r.questions.map(q => q.multiSelect ? new Set() : {}) };
    el.querySelectorAll('.dc-q').forEach(qel => {
      const qi = +qel.dataset.qi, q = r.questions[qi];
      qel.querySelectorAll('button.dc-opt').forEach(b => b.onclick = () => {
        const label = q.options[+b.dataset.i].label;
        if (q.multiSelect) { const s = c.ans[qi]; s.has(label) ? s.delete(label) : s.add(label); }
        else {
          c.ans[qi] = c.ans[qi].label === label && !c.ans[qi].text ? {} : { label };  // a second click takes it back
          const inp = qel.querySelector('input'); if (inp) inp.value = '';
        }
        sync(c);
      });
      const form = qel.querySelector('form');
      if (form) {
        const inp = form.querySelector('input');
        inp.oninput = () => { c.ans[qi] = inp.value.trim() ? { text: inp.value.trim() } : {}; sync(c); };
        form.onsubmit = e => e.preventDefault();
      }
    });
    el.querySelector('.dc-submit').onclick = () => act(c, 'answer');
    el.querySelector('.ib-read').onclick = () => act(c, c.r.read ? 'unread' : 'read');
    return c;
  }

  function update(c, owner) {
    const r = c.r;
    c.el.classList.toggle('read', !!r.read);
    c.el.querySelector('.dc-meta').innerHTML = `<b>메일함</b> · ${who(r, owner(r))}${owner(r)?.badge || ''} · ${since(r.created_at)}`
      + ` · ${r.read ? '읽음' : '<b class="ib-new">안읽음</b>'}`;
    c.el.querySelector('.ib-went').innerHTML = r.chosen
      ? `<b>에이전트가 진행한 선택</b> ${esc(r.chosen)}`
      : `<b>권장안으로 진행</b> ${esc((r.recommended || []).join(' / '))} <span class="dc-hint">(에이전트가 아직 기록하지 않아 서버가 고른 권장안)</span>`;
    const f = r.followup;
    c.el.querySelector('.ib-follow').innerHTML = f ? `<b>보낸 후속 메시지</b> · ${since(f.at)}<br>${esc(f.text)}` : '';
    c.el.querySelector('.ib-read').textContent = r.read ? '안읽음으로' : '확인';
  }

  return {
    // Show `items` (newest first) in #inbox; owner(r) as for decisions.show.
    show(items, owner = () => null) {
      const here = new Set(items.map(r => r.id));
      for (const [id, c] of cards) if (!here.has(id)) { c.el.remove(); cards.delete(id); }
      items.forEach((r, i) => {
        let c = cards.get(r.id);
        if (!c) { c = build(r); cards.set(r.id, c); }
        if (list.children[i] !== c.el) list.insertBefore(c.el, list.children[i] || null);  // only new cards move in
        c.r = r;
        update(c, owner);
      });
      const unread = items.filter(r => !r.read).length;
      head.textContent = `메일함 ${items.length}` + (unread ? ` · 안읽음 ${unread}` : '');
      box.hidden = !items.length;
    },
    hide() { box.hidden = true; },
  };
})();
