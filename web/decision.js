// 결정 버튼 cards. The decision_buttons server (8799) owns each pending question and the keys typed into its
// terminal; the dashboard shows the questions and relays answers through its own server (api.decide).
// Behaviour follows ~/tools/decision-buttons/index.html: a lone single-choice question sends on click, several
// questions or a multiSelect send together with 「답 보내기」, typed text only on single-choice questions.
// Cards live in #decisions, outside #view, which every refresh rebuilds. A card is built once per request id and
// later refreshes only touch its meta and status lines, so picks, typed text, focus and an IME composition
// survive (a periodic re-render wiping input is the bug the 8799 page hit first).
const decisions = (() => {
  const box = document.getElementById('decisions');
  const cards = new Map();  // request id -> {el, r, ans, sentAt}
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
    setStatus(c, '보내는 중…');
    let res;
    try { res = await api.decide(c.r.id, c.r.questions.map((q, i) => answerOf(q, c.ans[i]))); }
    catch { res = { status: 0, body: { error: '대시보드 서버에 보내지 못했습니다' } }; }
    if (res.status === 200) return setStatus(c, '답을 보냈습니다');
    if (res.status === 202) return setStatus(c, '터미널에 답을 넣는 중…');
    c.sentAt = 0;
    c.el.classList.toggle('done', res.status === 409);  // 409: answered elsewhere; the card goes on the next refresh
    setStatus(c, res.status === 409 ? '이미 답한 질문입니다' : res.body?.error || `전송 실패 (${res.status})`, true);
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
      ${needsSubmit(r) ? '<button class="dc-submit" disabled>답 보내기</button>' : ''}
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
    c.el.querySelector('.dc-meta').innerHTML = `<b>결정 대기</b> · ${o ? (o.href ? `<a href="${esc(o.href)}">${esc(o.name)}</a>` : esc(o.name)) : esc(r.agent || '에이전트')}`
      + ` · ${since(r.created_at)}${r.terminal ? '<span class="badge">터미널에도 떠 있음</span>' : ''}`;
    const held = c.sentAt && Date.now() - c.sentAt < SENT_HOLD;
    if (r.delivering) { c.el.classList.add('done'); setStatus(c, '터미널에 답을 넣는 중…'); }
    else if (r.error) { c.sentAt = 0; c.el.classList.remove('done'); setStatus(c, r.error + ' — 다시 답할 수 있습니다', true); }
    else if (!held) { c.sentAt = 0; c.el.classList.remove('done'); if (!c.el.querySelector('.dc-status.err')) setStatus(c, ''); }
  }

  return {
    // Show exactly `items` (8799 requests) in #decisions. A card for a request still in `pending` but not shown
    // on this screen is detached and kept, so its picks come back with it; owner(r) -> {name, href?} names the
    // session the request belongs to.
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
