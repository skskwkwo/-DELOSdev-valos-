/* =====================================================================
   DELOS — front-end controller
   Real-time token streaming + live DuckDuckGo research console
   ===================================================================== */

(() => {
  'use strict';

  /* ----------------------------- DOM refs ----------------------------- */
  const $ = (id) => document.getElementById(id);

  const el = {
    stream: $('stream'),
    welcome: $('welcome'),
    input: $('input'),
    btnSend: $('btnSend'),
    btnStop: $('btnStop'),
    modelSelect: $('modelSelect'),
    refreshModels: $('refreshModels'),
    systemPrompt: $('systemPrompt'),
    tempRange: $('tempRange'),
    tempValue: $('tempValue'),
    optResearch: $('optResearch'),
    optDeep: $('optDeep'),
    optCite: $('optCite'),
    optSound: $('optSound'),
    newChat: $('newChat'),
    clearChat: $('clearChat'),
    statusDot: $('statusDot'),
    statusText: $('statusText'),
    researchPanel: $('researchPanel'),
    researchSteps: $('researchSteps'),
    researchSources: $('researchSources'),
    toggleResearch: $('toggleResearch'),
    tokenMeter: $('tokenMeter'),
    engineInfo: $('engineInfo'),
    btnClose: $('btnClose'),
    btnMin: $('btnMin'),
    btnMax: $('btnMax')
  };

  /* ----------------------------- State ----------------------------- */
  const state = {
    messages: [],
    streaming: false,
    controller: null,
    researchController: null,
    researchContext: '',
    lastSources: [],
    tokens: 0,
    streamStart: 0,
    meterTimer: null
  };

  const SUGGESTION_FALLBACK = 'llama3.2';

  /* ----------------------------- Utils ----------------------------- */
  function scrollToBottom(smooth) {
    el.stream.scrollTo({ top: el.stream.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function nowTime() {
    const d = new Date();
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function beep(freq, dur) {
    if (!el.optSound.checked) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq || 660;
      gain.gain.value = 0.03;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (dur || 0.05));
      osc.onended = () => ctx.close();
    } catch (e) { /* ignore */ }
  }

  /* --------------------------- Markdown --------------------------- */
  function renderMarkdown(src) {
    if (!src) return '';
    const blocks = [];
    let text = String(src);

    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      const i = blocks.length;
      blocks.push(
        '<pre><code class="lang-' + escapeHtml(lang || 'text') + '">' +
        escapeHtml(code.replace(/\n$/, '')) + '</code></pre>'
      );
      return '\u0000BLOCK' + i + '\u0000';
    });

    const inline = [];
    text = text.replace(/`([^`\n]+)`/g, (m, c) => {
      const i = inline.length;
      inline.push('<code>' + escapeHtml(c) + '</code>');
      return '\u0001IN' + i + '\u0001';
    });

    text = escapeHtml(text);

    text = text.replace(/^###### (.*)$/gm, '<h3>$1</h3>')
      .replace(/^##### (.*)$/gm, '<h3>$1</h3>')
      .replace(/^#### (.*)$/gm, '<h3>$1</h3>')
      .replace(/^### (.*)$/gm, '<h3>$1</h3>')
      .replace(/^## (.*)$/gm, '<h2>$1</h2>')
      .replace(/^# (.*)$/gm, '<h1>$1</h1>');

    text = text.replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>');

    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');

    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<>)]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

    const lines = text.split('\n');
    const out = [];
    let list = null;
    const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^[-*+]\s+/.test(trimmed)) {
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        out.push('<li>' + trimmed.replace(/^[-*+]\s+/, '') + '</li>');
      } else if (/^\d+\.\s+/.test(trimmed)) {
        if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
        out.push('<li>' + trimmed.replace(/^\d+\.\s+/, '') + '</li>');
      } else if (trimmed === '') {
        closeList();
      } else if (/^<(h[1-3]|blockquote|pre)/.test(trimmed)) {
        closeList();
        out.push(trimmed);
      } else {
        closeList();
        out.push('<p>' + trimmed + '</p>');
      }
    }
    closeList();

    let html = out.join('\n');
    html = html.replace(/\u0000BLOCK(\d+)\u0000/g, (m, i) => blocks[+i] || '');
    html = html.replace(/\u0001IN(\d+)\u0001/g, (m, i) => inline[+i] || '');
    return html;
  }

  /* --------------------------- Messages --------------------------- */
  function hideWelcome() {
    if (el.welcome) el.welcome.classList.add('hidden');
  }

  function showWelcome() {
    if (el.welcome) el.welcome.classList.remove('hidden');
  }

  const FOX_MINI = '<svg viewBox="0 0 160 160" width="24" height="24" aria-hidden="true">' +
    '<path d="M80 36 L114 50 L106 92 L80 128 L54 92 L46 50 Z" fill="#ff2d6f"/>' +
    '<path d="M60 70 L76 76 L64 82 Z" fill="#0affff"/><path d="M100 70 L84 76 L96 82 Z" fill="#0affff"/></svg>';

  function createMessage(role, text) {
    hideWelcome();
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;

    const avatar = document.createElement('div');
    avatar.className = 'avatar ' + role;
    avatar.innerHTML = role === 'assistant' ? FOX_MINI : 'YOU';

    const content = document.createElement('div');
    content.className = 'msg-content';

    const roleLabel = document.createElement('div');
    roleLabel.className = 'msg-role';
    roleLabel.textContent = role === 'assistant' ? 'DELOS · Devil Fox' : 'You';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';

    content.appendChild(roleLabel);
    content.appendChild(bubble);
    content.appendChild(meta);
    wrap.appendChild(avatar);
    wrap.appendChild(content);
    el.stream.appendChild(wrap);
    scrollToBottom(true);
    return { wrap, bubble, meta, content };
  }

  /* --------------------------- Token meter --------------------------- */
  function startMeter() {
    state.tokens = 0;
    state.streamStart = performance.now();
    stopMeter();
    state.meterTimer = setInterval(() => {
      const secs = (performance.now() - state.streamStart) / 1000;
      const rate = secs > 0 ? state.tokens / secs : 0;
      el.tokenMeter.textContent = rate.toFixed(1) + ' tok/s';
    }, 180);
  }

  function stopMeter() {
    if (state.meterTimer) {
      clearInterval(state.meterTimer);
      state.meterTimer = null;
    }
  }

  /* --------------------------- Research SSE --------------------------- */
  function resetResearch() {
    el.researchSteps.innerHTML = '';
    el.researchSources.innerHTML = '';
    state.lastSources = [];
    state.researchContext = '';
  }

  function addStep(label, detail, kind) {
    const d = document.createElement('div');
    d.className = 'rstep' + (kind ? ' ' + kind : '');
    d.innerHTML = '<span class="rlabel">' + escapeHtml(label) + '</span>' +
      (detail ? '<span class="rdetail">' + escapeHtml(detail) + '</span>' : '');
    el.researchSteps.appendChild(d);
    el.researchSteps.scrollTop = el.researchSteps.scrollHeight;
  }

  function addSource(src) {
    const card = document.createElement('div');
    card.className = 'source-card';
    card.innerHTML =
      '<div class="source-idx">[' + src.index + '/' + src.total + '] ' + escapeHtml(src.domain || '') + '</div>' +
      '<div class="source-title">' + escapeHtml(src.title) + '</div>' +
      (src.snippet ? '<div class="source-snippet">' + escapeHtml(src.snippet) + '</div>' : '');
    card.title = src.url;
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => window.open(src.url, '_blank', 'noopener'));
    el.researchSources.appendChild(card);
    el.researchSources.scrollTop = el.researchSources.scrollHeight;
    state.lastSources.push(src);
  }

  function runResearch(query) {
    return new Promise((resolve) => {
      if (!el.optResearch.checked) {
        resetResearch();
        addStep('웹 리서치 비활성화', '설정에서 실시간 웹 리서치를 켜세요', 'muted');
        resolve('');
        return;
      }
      resetResearch();
      if (el.researchPanel.classList.contains('collapsed')) {
        el.researchPanel.classList.remove('collapsed');
      }
      const depth = el.optDeep.checked ? 10 : 5;
      const controller = new AbortController();
      state.researchController = controller;

      fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, depth }),
        signal: controller.signal
      }).then(async (resp) => {
        if (!resp.ok || !resp.body) throw new Error('research status ' + resp.status);
        const reader = resp.body.getReader();
        const dec = new TextDecoder('utf-8');
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            handleResearchEvent(chunk, resolve);
          }
        }
      }).catch((err) => {
        if (String(err.name) === 'AbortError') return;
        addStep('리서치 실패', String(err.message || err), 'err');
        resolve('');
      });
    });
  }

  function handleResearchEvent(chunk, resolve) {
    let event = 'message';
    let data = '';
    chunk.split('\n').forEach((line) => {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    });
    if (!data) return;
    let payload;
    try { payload = JSON.parse(data); } catch (e) { return; }

    if (event === 'step') {
      const ok = payload.pct >= 100;
      addStep(payload.label, payload.detail, ok ? 'ok' : '');
    } else if (event === 'answer') {
      addStep('Instant Answer', payload.source || 'DuckDuckGo', 'ok');
      const card = document.createElement('div');
      card.className = 'source-card';
      card.innerHTML = '<div class="source-idx">INSTANT ANSWER</div>' +
        '<div class="source-title">' + escapeHtml(payload.heading || 'DuckDuckGo') + '</div>' +
        '<div class="source-snippet" style="-webkit-line-clamp:5">' + escapeHtml(payload.abstract || '') + '</div>';
      el.researchSources.appendChild(card);
    } else if (event === 'source') {
      addSource(payload);
    } else if (event === 'done') {
      state.researchContext = payload.context || '';
      addStep('리서치 완료', payload.count + '개 출처 확보', 'ok');
      resolve(state.researchContext);
    } else if (event === 'error') {
      addStep('리서치 오류', payload.message, 'err');
      resolve('');
    }
  }

  /* --------------------------- Chat streaming --------------------------- */
  function buildMessages(userText) {
    const messages = [];
    const sys = (el.systemPrompt.value || '').trim();
    let system = sys;
    if (state.researchContext) {
      const cite = el.optCite.checked
        ? ' 인용 시 [1], [2] 형식의 출처 번호를 본문에 명시하세요.'
        : '';
      system = sys + '\n\n' + state.researchContext + cite;
    }
    if (system) messages.push({ role: 'system', content: system });
    for (const m of state.messages) messages.push({ role: m.role, content: m.content });
    messages.push({ role: 'user', content: userText });
    return messages;
  }

  async function sendMessage() {
    const text = el.input.value.trim();
    if (!text || state.streaming) return;

    el.input.value = '';
    autoGrow();

    state.messages.push({ role: 'user', content: text });
    createMessage('user', text).bubble.innerHTML = renderMarkdown(text);
    const userMeta = el.stream.querySelector('.msg.user:last-of-type .msg-meta');
    if (userMeta) userMeta.textContent = nowTime();

    setStreaming(true);
    beep(520, 0.05);

    const assistant = createMessage('assistant', '');
    assistant.wrap.classList.add('streaming');

    await runResearch(text);

    const messages = buildMessages(text);
    assistant.wrap.classList.add('streaming');
    startMeter();

    const controller = new AbortController();
    state.controller = controller;

    let full = '';
    let raf = null;
    let pending = false;

    const paint = () => {
      raf = null;
      assistant.bubble.innerHTML = renderMarkdown(full);
      scrollToBottom(false);
      pending = false;
    };
    const schedule = () => {
      if (!pending) {
        pending = true;
        raf = requestAnimationFrame(paint);
      }
    };

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: el.modelSelect.value || SUGGESTION_FALLBACK,
          messages,
          temperature: parseFloat(el.tempRange.value),
          options: { temperature: parseFloat(el.tempRange.value), num_ctx: 8192 }
        }),
        signal: controller.signal
      });

      if (!resp.ok || !resp.body) throw new Error('chat status ' + resp.status);

      const reader = resp.body.getReader();
      const dec = new TextDecoder('utf-8');
      let buf = '';
      let thinkingEl = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message';
          let data = '';
          chunk.split('\n').forEach((line) => {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          });
          if (!data) continue;
          let p;
          try { p = JSON.parse(data); } catch (e) { continue; }

          if (event === 'token' && p.content) {
            full += p.content;
            state.tokens += 1;
            schedule();
          } else if (event === 'thinking' && p.content) {
            if (!thinkingEl) {
              thinkingEl = document.createElement('div');
              thinkingEl.className = 'thinking';
              assistant.bubble.parentNode.insertBefore(thinkingEl, assistant.bubble);
            }
            thinkingEl.textContent += p.content;
            thinkingEl.scrollTop = thinkingEl.scrollHeight;
          } else if (event === 'done' || event === 'end') {
            if (p.content && p.content.length > full.length) full = p.content;
            if (typeof p.eval_count === 'number') {
              const dur = (p.total_duration || 0) / 1e9;
              const metaBits = [];
              if (p.model) metaBits.push('model: ' + p.model);
              if (dur > 0) metaBits.push((p.eval_count / dur).toFixed(1) + ' tok/s');
              metaBits.push(p.eval_count + ' tokens');
              if (p.prompt_eval_count) metaBits.push('ctx ' + p.prompt_eval_count);
              if (p.demo) metaBits.push('DEMO MODE');
              assistant.meta.textContent = metaBits.join('  ·  ');
            } else if (p.demo) {
              assistant.meta.textContent = 'demo stream';
            }
            if (event === 'done') {
              assistant.meta.textContent = assistant.meta.textContent || (nowTime() + '  ·  complete');
            }
          } else if (event === 'error') {
            full += '\n\n> ⚠ ' + (p.message || 'error');
            schedule();
          }
        }
      }

      if (full) {
        state.messages.push({ role: 'assistant', content: full });
      }
      if (!assistant.meta.textContent) assistant.meta.textContent = nowTime();
      paint();
      beep(760, 0.06);
    } catch (err) {
      if (String(err.name) === 'AbortError') {
        assistant.meta.textContent = '중지됨';
        if (full) state.messages.push({ role: 'assistant', content: full });
      } else {
        assistant.bubble.innerHTML = renderMarkdown('오류: ' + String(err.message || err));
      }
    } finally {
      if (raf) cancelAnimationFrame(raf);
      assistant.wrap.classList.remove('streaming');
      stopMeter();
      el.tokenMeter.textContent = '0 tok/s';
      state.controller = null;
      setStreaming(false);
      scrollToBottom(true);
    }
  }

  function setStreaming(on) {
    state.streaming = on;
    el.btnSend.classList.toggle('hidden', on);
    el.btnStop.classList.toggle('hidden', !on);
    el.input.disabled = false;
    if (!on) el.input.focus();
  }

  /* --------------------------- Input handling --------------------------- */
  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 180) + 'px';
  }

  el.input.addEventListener('input', autoGrow);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  el.btnSend.addEventListener('click', sendMessage);
  el.btnStop.addEventListener('click', () => {
    if (state.controller) state.controller.abort();
    if (state.researchController) state.researchController.abort();
  });

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      el.input.value = chip.textContent.trim();
      autoGrow();
      el.input.focus();
    });
  });

  /* --------------------------- Sidebar actions --------------------------- */
  el.tempRange.addEventListener('input', () => {
    el.tempValue.textContent = parseFloat(el.tempRange.value).toFixed(2);
  });

  el.newChat.addEventListener('click', () => {
    state.messages = [];
    el.stream.querySelectorAll('.msg').forEach((n) => n.remove());
    resetResearch();
    el.researchSteps.innerHTML = '<div class="rstep muted">새 대화 세션. 질문을 입력하면 실시간 리서치가 시작됩니다.</div>';
    showWelcome();
    el.input.focus();
  });

  el.clearChat.addEventListener('click', () => {
    state.messages = [];
    el.stream.querySelectorAll('.msg').forEach((n) => n.remove());
    resetResearch();
    showWelcome();
  });

  el.toggleResearch.addEventListener('click', () => {
    el.researchPanel.classList.toggle('collapsed');
  });

  /* --------------------------- Models + health --------------------------- */
  async function loadModels() {
    try {
      const resp = await fetch('/api/models');
      const data = await resp.json();
      const models = data.models || [];
      if (models.length) {
        el.modelSelect.innerHTML = '';
        models.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m.name;
          const bits = [m.name];
          if (m.parameters) bits.push(m.parameters);
          if (m.quantization) bits.push(m.quantization);
          opt.textContent = bits.join(' · ');
          el.modelSelect.appendChild(opt);
        });
      }
    } catch (e) { /* keep fallback */ }
  }

  async function checkHealth() {
    try {
      const resp = await fetch('/api/health');
      const data = await resp.json();
      if (data.ollama && data.ollama.online) {
        el.statusDot.className = 'status-dot online';
        el.statusText.textContent = 'Ollama 연결됨';
        el.engineInfo.textContent = 'engine: ollama @ ' + data.ollamaUrl;
      } else {
        el.statusDot.className = 'status-dot offline';
        el.statusText.textContent = 'Ollama 오프라인 · 데모 모드';
        el.engineInfo.textContent = 'engine: demo fallback';
      }
    } catch (e) {
      el.statusDot.className = 'status-dot offline';
      el.statusText.textContent = '서버 연결 실패';
    }
  }

  el.refreshModels.addEventListener('click', loadModels);

  /* --------------------------- Window chrome --------------------------- */
  el.btnMin.addEventListener('click', () => {
    document.querySelector('.window').style.transform = 'scale(0.985)';
    setTimeout(() => { document.querySelector('.window').style.transform = ''; }, 180);
  });
  el.btnMax.addEventListener('click', () => {
    const w = document.querySelector('.window');
    if (w.dataset.max === '1') {
      w.style.width = '';
      w.style.height = '';
      w.dataset.max = '0';
    } else {
      w.style.width = '100%';
      w.style.height = '100%';
      w.dataset.max = '1';
    }
  });
  el.btnClose.addEventListener('click', () => {
    document.body.style.transition = 'opacity 0.4s ease';
    document.body.style.opacity = '0';
    setTimeout(() => { document.body.style.opacity = '1'; }, 700);
  });

  /* --------------------------- Boot --------------------------- */
  el.researchSteps.innerHTML = '<div class="rstep muted">아직 리서치가 실행되지 않았습니다. 질문을 입력하면 DuckDuckGo 엔드포인트에서 실시간으로 소스를 수집합니다.</div>';
  el.tempValue.textContent = parseFloat(el.tempRange.value).toFixed(2);
  autoGrow();
  checkHealth();
  loadModels();
  setInterval(checkHealth, 20000);
  window.addEventListener('load', () => el.input.focus());
})();
