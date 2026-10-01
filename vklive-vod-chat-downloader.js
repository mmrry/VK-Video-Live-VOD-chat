// ==UserScript==
// @name         VK Video Live — скачать чат записи (VOD)
// @namespace    aaa.vkvideo.vodchat
// @version      1.1.0
// @description  Кнопка «↓ Скачать чат» на записях VK Video Live: выгружает весь чат VOD в TXT / JSON / CSV
// @match        https://live.vkvideo.ru/*
// @run-at       document-idle
// @grant        none
// @license MIT
// ==/UserScript==

(() => {
  'use strict';

  // ───────────────────────── настройки ─────────────────────────
  const API       = 'https://api.live.vkvideo.ru/v1';
  const LIMIT     = 200;          // как у сайта; сервер отдаёт до LIMIT сообщений до и после time_code
  const DELAY_MS  = 120;          // пауза между запросами
  const MAX_REQS  = 100000;       // предохранитель от бесконечного цикла
  const CORNER    = 'top-right';    // 'top-right' | 'bottom-right' | 'top-left' | 'bottom-left'
  const OFFSET    = 10;           // отступ кнопки от края чата, px
  const HEADER_ZONE = 64;         // кнопки в этой полосе сверху чата считаются шапкой (→, вкладка чата)
  const CSV_SEP   = ';';          // ';' — чтобы русский Excel открывал без мастера импорта

  // Кандидаты на контейнер чата (CSS-классы у сайта хэшированные, поэтому ищем по подстроке).
  // Если кнопка встала не туда — допиши сюда точный селектор из DevTools первым элементом.
  const CHAT_SELECTORS = [
    '[class*="ChatBox"]',
    '[class*="RecordChat"]',
    '[class*="ChatHistory"]',
    '[class*="Chat_root"]',
    '[class*="chat_root"]',
    '[data-role*="chat" i]',
    '[class*="Chat"]',
  ];

  const RECORD_RE = /^\/([^/]+)\/record\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

  // ───────────────────────── состояние ─────────────────────────
  const cache = new Map();   // recordId -> отсортированный массив сообщений
  let busy = false;
  let abortRequested = false;
  let ui = null;             // { wrap, btn, menu }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function currentRecord() {
    const m = location.pathname.match(RECORD_RE);
    return m ? { channel: decodeURIComponent(m[1]), recordId: m[2].toLowerCase() } : null;
  }

  // ───────────────────────── API ─────────────────────────
  async function apiGet(url) {
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (abortRequested) throw new Error('Отменено');
      try {
        const r = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'X-App': 'streams_web',
            'X-Referer': 'vkvideo.ru',
          },
        });
        if (r.status === 429 || r.status >= 500) {
          lastErr = new Error(`HTTP ${r.status}`);
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        lastErr = e;
        if (e.message === 'Отменено' || /^HTTP 4\d\d$/.test(e.message)) throw e;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  /**
   * Эндпоинт /chat/?time_code=T&limit=N возвращает окно: до N сообщений с timeCode < T
   * и до N сообщений с timeCode >= T. Идём вперёд: T = максимальный timeCode из «правой»
   * половины, дубли (повторно пришедшие сообщения той же секунды) отсекаем по id.
   * Конец — когда справа от T ничего не пришло.
   */
  async function fetchAllMessages(channel, recordId, onProgress) {
    const byId = new Map();
    let t = 0;
    for (let reqs = 1; reqs <= MAX_REQS; reqs++) {
      const url = `${API}/channel/${encodeURIComponent(channel)}/record/${recordId}/chat/?time_code=${t}&limit=${LIMIT}`;
      const json = await apiGet(url);
      const list = Array.isArray(json && json.data) ? json.data : [];

      let after = 0;
      let maxTc = -1;
      for (const m of list) {
        if (!m || m.id == null) continue;
        byId.set(m.id, m);
        const tc = Number(m.timeCode) || 0;
        if (tc >= t) {
          after++;
          if (tc > maxTc) maxTc = tc;
        }
      }
      onProgress(byId.size, t);

      if (after === 0) break;
      // если все сообщения «справа» в одной секунде — сдвигаемся на секунду вперёд
      t = maxTc > t ? maxTc : t + 1;
      await sleep(DELAY_MS);
    }
    return [...byId.values()].sort(
      (a, b) => (a.timeCode - b.timeCode) || ((a.createdAt || 0) - (b.createdAt || 0)) || (a.id - b.id)
    );
  }

  // ───────────────────────── разбор сообщений ─────────────────────────
  function parseContent(c) {
    if (!c) return '';
    try {
      const a = JSON.parse(c);           // формат: ["текст","unstyled",[]]
      return Array.isArray(a) ? String(a[0] ?? '') : String(a);
    } catch {
      return String(c);
    }
  }

  function messageText(blocks) {
    let out = '';
    const push = (s, spaced) => {
      if (!s) return;
      if (spaced && out && !/\s$/.test(out)) out += ' ';
      out += s;
      if (spaced) out += ' ';
    };
    for (const b of blocks || []) {
      if (!b) continue;
      if (b.modificator === 'BLOCK_END') { out = out.replace(/[ \t]+$/, '') + '\n'; continue; }
      switch (b.type) {
        case 'text':    push(parseContent(b.content), false); break;
        case 'link':    push(parseContent(b.content) || b.url || '', false); break;
        case 'smile':   push(`:${b.name || 'smile'}:`, true); break;
        case 'mention': push('@' + (b.displayName || b.nick || b.name || '?'), true); break;
        default:        push(parseContent(b.content) || b.url || `[${b.name || b.type}]`, true);
      }
    }
    return out.replace(/\u200b/g, '').replace(/ {2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  }

  const nickOf = (a) => (a && (a.displayName || a.nick || a.name)) || '?';

  function fmtTc(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  const isoOf = (unix) => (unix ? new Date(unix * 1000).toISOString() : '');

  // ───────────────────────── экспорт ─────────────────────────
  function toTxt(msgs, meta) {
    const lines = [
      `# Канал: ${meta.channel}`,
      `# Запись: ${meta.url}`,
      `# Сообщений: ${msgs.length}`,
      `# Выгружено: ${new Date().toLocaleString('ru-RU')}`,
      '',
    ];
    for (const m of msgs) {
      let head = `[${fmtTc(m.timeCode)}] ${nickOf(m.author)}`;
      if (m.parent) {
        const pt = messageText(m.parent.data).replace(/\s+/g, ' ');
        head += ` (ответ ${nickOf(m.parent.author)}: «${pt.length > 60 ? pt.slice(0, 60) + '…' : pt}»)`;
      }
      let text = messageText(m.data);
      if (m.isDeleted) text += ' [удалено]';
      lines.push(`${head}: ${text.replace(/\n/g, '\n    ')}`);
    }
    return lines.join('\n') + '\n';
  }

  function toCsv(msgs) {
    const esc = (v) => {
      const s = String(v ?? '');
      return /["\n\r]/.test(s) || s.includes(CSV_SEP) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['time_code', 'time', 'created_at', 'id', 'user_id', 'nick', 'display_name',
      'is_owner', 'is_moderator', 'reply_to_id', 'reply_to_nick', 'deleted', 'text'];
    const rows = [head.join(CSV_SEP)];
    for (const m of msgs) {
      const a = m.author || {};
      rows.push([
        m.timeCode, fmtTc(m.timeCode), isoOf(m.createdAt), m.id, a.id, a.nick, a.displayName,
        a.isOwner ? 1 : 0, (a.isChannelModerator || a.isChatModerator) ? 1 : 0,
        m.parent ? m.parent.id : '', m.parent ? nickOf(m.parent.author) : '',
        m.isDeleted ? 1 : 0, messageText(m.data),
      ].map(esc).join(CSV_SEP));
    }
    return '\uFEFF' + rows.join('\r\n') + '\r\n';
  }

  function toJson(msgs, meta) {
    return JSON.stringify({
      channel: meta.channel,
      recordId: meta.recordId,
      url: meta.url,
      exportedAt: new Date().toISOString(),
      count: msgs.length,
      messages: msgs,
    }, null, 1);
  }

  function saveFile(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  // ───────────────────────── UI ─────────────────────────
  const BTN_LABEL = '↓ Скачать чат';

  function injectStyle() {
    if (document.getElementById('vkvc-style')) return;
    const st = document.createElement('style');
    st.id = 'vkvc-style';
    st.textContent = `
      #vkvc-wrap{position:fixed;z-index:2147483000;font:600 13px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
      #vkvc-btn{all:unset;cursor:pointer;padding:7px 12px;border-radius:8px;background:rgba(20,20,24,.85);
        color:#fff;border:1px solid rgba(255,255,255,.18);box-shadow:0 2px 8px rgba(0,0,0,.35);white-space:nowrap;
        backdrop-filter:blur(4px);transition:background .15s}
      #vkvc-btn:hover{background:rgba(0,119,255,.9)}
      #vkvc-btn.busy{background:rgba(0,119,255,.9);cursor:progress}
      #vkvc-menu{position:absolute;right:0;display:none;flex-direction:column;min-width:150px;padding:4px;
        border-radius:8px;background:rgba(20,20,24,.95);border:1px solid rgba(255,255,255,.18);box-shadow:0 4px 14px rgba(0,0,0,.4)}
      #vkvc-wrap.up #vkvc-menu{bottom:calc(100% + 6px)}
      #vkvc-wrap:not(.up) #vkvc-menu{top:calc(100% + 6px)}
      #vkvc-wrap.open #vkvc-menu{display:flex}
      #vkvc-menu button{all:unset;cursor:pointer;padding:7px 10px;border-radius:6px;color:#fff;font-weight:500}
      #vkvc-menu button:hover{background:rgba(255,255,255,.12)}
      #vkvc-menu small{color:#aaa;font-weight:400}
    `;
    document.head.appendChild(st);
  }

  function buildUi() {
    injectStyle();
    const wrap = document.createElement('div');
    wrap.id = 'vkvc-wrap';
    wrap.classList.toggle('up', CORNER.startsWith('bottom'));

    const btn = document.createElement('button');
    btn.id = 'vkvc-btn';
    btn.type = 'button';
    btn.textContent = BTN_LABEL;
    btn.title = 'Выгрузить весь чат этой записи';

    const menu = document.createElement('div');
    menu.id = 'vkvc-menu';
    for (const [fmt, label, hint] of [
      ['txt', 'TXT', 'читаемый лог'],
      ['csv', 'CSV', 'для Excel'],
      ['json', 'JSON', 'сырые данные API'],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `${label} <small>— ${hint}</small>`;
      b.addEventListener('click', (e) => { e.stopPropagation(); wrap.classList.remove('open'); run(fmt); });
      menu.appendChild(b);
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (busy) {
        abortRequested = true;
        btn.textContent = 'Отмена…';
        return;
      }
      wrap.classList.toggle('open');
    });
    document.addEventListener('click', () => wrap.classList.remove('open'));

    wrap.append(btn, menu);
    document.body.appendChild(wrap);
    return { wrap, btn, menu };
  }

  function findChat() {
    for (const sel of CHAT_SELECTORS) {
      let best = null, bestArea = 0;
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest('#vkvc-wrap') || el.querySelector('video')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height < 200 || r.bottom <= 0 || r.top >= innerHeight) continue;
        const area = r.width * r.height;
        if (area > bestArea) { best = el; bestArea = area; }
      }
      if (best) return best;
    }
    return null;
  }

  // Нижняя граница шапки чата (строка с кнопкой «→» и вкладкой чата), чтобы кнопка
  // встала сразу под ней, а не поверх. Если шапки нет — верх контейнера чата.
  function headerBottom(chat, r) {
    if (!chat) return 0;
    let maxBottom = 0;
    for (const el of chat.querySelectorAll('button, [role="button"], [role="tab"]')) {
      if (el.closest('#vkvc-wrap')) continue;
      const er = el.getBoundingClientRect();
      if (!er.width || !er.height) continue;
      if (er.top >= r.top - 1 && er.top < r.top + HEADER_ZONE && er.height < HEADER_ZONE) {
        maxBottom = Math.max(maxBottom, er.bottom);
      }
    }
    return maxBottom;
  }

  function position() {
    if (!ui) return;
    const st = ui.wrap.style;
    st.top = st.bottom = st.left = st.right = 'auto';
    const chat = findChat();
    const r = chat
      ? chat.getBoundingClientRect()
      : { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
    const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
    if (CORNER.startsWith('top')) st.top = `${Math.max(top, headerBottom(chat, r)) + OFFSET}px`;
    else st.bottom = `${innerHeight - bottom + OFFSET}px`;
    if (CORNER.endsWith('right')) st.right = `${innerWidth - r.right + OFFSET}px`;
    else st.left = `${r.left + OFFSET}px`;
    ui.menu.style.right = CORNER.endsWith('right') ? '0' : 'auto';
    ui.menu.style.left = CORNER.endsWith('left') ? '0' : 'auto';
  }

  async function run(fmt) {
    const rec = currentRecord();
    if (!rec || busy) return;
    const meta = { ...rec, url: `https://live.vkvideo.ru/${rec.channel}/record/${rec.recordId}` };
    busy = true;
    abortRequested = false;
    ui.btn.classList.add('busy');
    try {
      let msgs = cache.get(rec.recordId);
      if (!msgs) {
        ui.btn.textContent = '⏳ Загрузка…';
        msgs = await fetchAllMessages(rec.channel, rec.recordId, (n, t) => {
          ui.btn.textContent = `⏳ ${n.toLocaleString('ru-RU')} сообщ. · ${fmtTc(t)}  ✕`;
        });
        cache.set(rec.recordId, msgs);
      }
      if (!msgs.length) {
        alert('В чате этой записи нет сообщений (или API ничего не вернул).');
        return;
      }
      const base = `${rec.channel.replace(/[^\w.-]+/g, '_')}_${rec.recordId}_chat`;
      if (fmt === 'txt') saveFile(toTxt(msgs, meta), `${base}.txt`, 'text/plain;charset=utf-8');
      else if (fmt === 'csv') saveFile(toCsv(msgs), `${base}.csv`, 'text/csv;charset=utf-8');
      else saveFile(toJson(msgs, meta), `${base}.json`, 'application/json;charset=utf-8');
      ui.btn.textContent = `✓ ${msgs.length.toLocaleString('ru-RU')} сообщ.`;
      setTimeout(() => { if (!busy && ui) ui.btn.textContent = BTN_LABEL; }, 3000);
    } catch (e) {
      console.error('[vkvc]', e);
      if (e.message !== 'Отменено') alert('Не удалось выгрузить чат: ' + e.message);
      ui.btn.textContent = BTN_LABEL;
    } finally {
      busy = false;
      ui.btn.classList.remove('busy');
    }
  }

  // ───────────────────────── SPA-навигация ─────────────────────────
  function tick() {
    const rec = currentRecord();
    if (rec) {
      if (!ui || !document.body.contains(ui.wrap)) ui = buildUi();
      position();
    } else if (ui) {
      ui.wrap.remove();
      ui = null;
    }
  }

  tick();
  setInterval(tick, 700);
  addEventListener('resize', position, { passive: true });
  addEventListener('scroll', position, { passive: true, capture: true });
})();
