/* ツーリング相棒 — バイク+インカム向けハンズフリー会話エージェント */
'use strict';

// ===================== 定数 =====================
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 1024;
const MAX_HISTORY_MESSAGES = 30;      // APIへ送る会話履歴の上限(件)
const SESSION_RESUME_HOURS = 6;       // これ以上間が空いたら新セッション

const SYSTEM_PROMPT = `あなたは「相棒」という名前の、バイクツーリングに同行するハンズフリー音声アシスタントです。ライダーはヘルメットのインカム越しに話しており、あなたの返答はそのまま音声で読み上げられます。

会話のルール:
- 話し言葉の自然な日本語で答える。書き言葉・箇条書き・記号・絵文字・マークダウン・URLは一切使わない。
- 普段の返答は1〜3文で簡潔に。詳しく聞かれたときだけ長めに話してよい。
- 気さくで頼れるツーリング仲間として、フランクすぎない丁寧すぎない口調で話す。
- ライダーは運転中。画面を見る操作を促してはいけない。危険な運転につながる提案もしない。
- 相手の発話は音声認識なので誤変換がありうる。文脈から意図を推測し、どうしても不明なときだけ短く聞き返す。

できること:
- 雑談相手: 眠気防止の話し相手。話題を振ったりクイズを出したりしてもよい。
- 周辺ガイド: 発話に付く現在地情報(緯度経度・進行方向・速度)をもとに、周辺の観光スポット、道の駅、グルメ、休憩場所などを案内する。位置情報から地名を推測して自然に話す。緯度経度の数値は読み上げない。
- メモ: 「メモして」「覚えておいて」などと頼まれたら save_memo ツールで保存し、保存したことを一言で伝える。

情報が古い可能性がある場合(営業時間・天気など)は、その旨を一言添える。`;

const SAVE_MEMO_TOOL = {
  name: 'save_memo',
  description: 'ユーザーが「メモして」「覚えておいて」「記録して」などと頼んだ内容をツーリングメモとして保存する。メモには自動で時刻と位置が付く。',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'メモ本文。ユーザーの言った内容を簡潔な一文〜数文にまとめる。' },
    },
    required: ['text'],
  },
};

const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 };

// ===================== 設定・保存 =====================
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('tb_' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) { localStorage.setItem('tb_' + key, JSON.stringify(value)); },
  remove(key) { localStorage.removeItem('tb_' + key); },
};

const settings = {
  apiKey: store.get('apiKey', ''),
  mode: store.get('mode', 'always'),          // 'always' | 'wake'
  wakeWord: store.get('wakeWord', 'ねえ相棒'),
  webSearch: store.get('webSearch', false),
  useGeo: store.get('useGeo', true),
  voiceName: store.get('voiceName', ''),
  rate: store.get('rate', 1.0),
};

let memos = store.get('memos', []);           // {id, text, time, lat, lon}
let sessions = store.get('sessions', []);     // {id, startedAt, updatedAt, turns:[{who,'user'|'ai', text, time}]}
let apiMessages = store.get('apiMessages', []); // Claude APIに渡す生のメッセージ配列(現在セッション)

// ===================== 状態 =====================
let sessionActive = false;      // 会話セッション中か
let state = 'idle';             // idle | listening | thinking | speaking
let recognition = null;
let recognitionRunning = false;
let pendingUtterances = 0;      // 読み上げ待ち・読み上げ中の文の数
let abortController = null;
let wakeLock = null;
let geoWatchId = null;
let geo = null;                 // {lat, lon, heading, speed, accuracy, time}
let currentSession = null;

// ===================== DOM =====================
const $ = (id) => document.getElementById(id);
const el = {
  statusDot: $('status-dot'), statusText: $('status-text'),
  bigBtn: $('big-btn'), bigBtnIcon: $('big-btn-icon'), bigBtnLabel: $('big-btn-label'),
  modeLabel: $('mode-label'), searchLabel: $('search-label'),
  userLine: $('user-line'), userText: $('user-text'),
  aiLine: $('ai-line'), aiText: $('ai-text'),
  toast: $('toast'),
};

// ===================== ユーティリティ =====================
function showToast(msg, ms = 2500) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.toast.classList.add('hidden'), ms);
}

function setState(next) {
  state = next;
  el.statusDot.className = 'dot ' + (next === 'idle' ? 'idle' : next);
  el.bigBtn.className = 'big-btn ' + (next === 'idle' ? 'idle' : next);
  const map = {
    idle: ['🎙️', 'タップして開始', '待機中'],
    listening: ['🎙️', 'タップして終了', settings.mode === 'wake' ? `「${settings.wakeWord}」で呼びかけてください` : '聞き取り中'],
    thinking: ['💭', '応答を止める', '考え中…'],
    speaking: ['🔊', '応答を止める', '話し中'],
  };
  const [icon, label, status] = map[next];
  el.bigBtnIcon.textContent = icon;
  el.bigBtnLabel.textContent = label;
  el.statusText.textContent = status;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function headingToCompass(deg) {
  if (deg == null || isNaN(deg)) return null;
  const dirs = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
  return dirs[Math.round(deg / 45) % 8];
}

// ===================== 位置情報 =====================
function startGeo() {
  if (!settings.useGeo || !navigator.geolocation || geoWatchId != null) return;
  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      geo = {
        lat: pos.coords.latitude, lon: pos.coords.longitude,
        heading: pos.coords.heading, speed: pos.coords.speed,
        accuracy: pos.coords.accuracy, time: Date.now(),
      };
    },
    () => { /* 拒否・失敗時は位置情報なしで続行 */ },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
  );
}

function stopGeo() {
  if (geoWatchId != null) { navigator.geolocation.clearWatch(geoWatchId); geoWatchId = null; }
}

function contextLine() {
  const now = new Date();
  const parts = [`時刻 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${now.getHours()}時${now.getMinutes()}分`];
  if (geo && Date.now() - geo.time < 5 * 60 * 1000) {
    parts.push(`現在地 緯度${geo.lat.toFixed(5)} 経度${geo.lon.toFixed(5)}`);
    const dir = headingToCompass(geo.heading);
    if (dir) parts.push(`進行方向 ${dir}`);
    if (geo.speed != null && geo.speed >= 0) parts.push(`速度 約${Math.round(geo.speed * 3.6)}km/h`);
  } else {
    parts.push('現在地 不明');
  }
  return parts.join(' / ');
}

// ===================== 画面スリープ防止 =====================
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* 非対応・拒否は無視 */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && sessionActive && !wakeLock) acquireWakeLock();
});

// ===================== 読み上げ(TTS) =====================
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  if (settings.voiceName) {
    const v = voices.find((v) => v.name === settings.voiceName);
    if (v) return v;
  }
  return voices.find((v) => v.lang && v.lang.startsWith('ja')) || null;
}

function sanitizeForSpeech(text) {
  return text
    .replace(/[*_#>`~|]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .trim();
}

function speak(text, { onAllDone } = {}) {
  const clean = sanitizeForSpeech(text);
  if (!clean) { if (onAllDone && pendingUtterances === 0) onAllDone(); return; }
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = 'ja-JP';
  const voice = pickVoice();
  if (voice) u.voice = voice;
  u.rate = settings.rate;
  pendingUtterances++;
  // 読み上げ中は自分の声を拾わないよう認識を止める
  pauseRecognition();
  if (sessionActive && (state === 'thinking' || state === 'listening')) setState('speaking');
  const done = () => {
    pendingUtterances = Math.max(0, pendingUtterances - 1);
    if (pendingUtterances === 0 && onAllDone) onAllDone();
  };
  u.onend = done;
  u.onerror = done;
  speechSynthesis.speak(u);
}

function stopSpeaking() {
  pendingUtterances = 0;
  speechSynthesis.cancel();
}

// 文単位に区切って逐次読み上げるためのチャンカー
function createSentenceChunker(onSentence) {
  let buf = '';
  return {
    push(delta) {
      buf += delta;
      let idx;
      while ((idx = buf.search(/[。!?!?\n]/)) !== -1) {
        const sentence = buf.slice(0, idx + 1);
        buf = buf.slice(idx + 1);
        if (sentence.trim()) onSentence(sentence);
      }
    },
    flush() {
      if (buf.trim()) onSentence(buf);
      buf = '';
    },
  };
}

// ===================== 音声認識 =====================
function createRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = 'ja-JP';
  rec.continuous = true;
  rec.interimResults = false;
  rec.onresult = (ev) => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (res.isFinal) handleUtterance(res[0].transcript.trim());
    }
  };
  rec.onerror = (ev) => {
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
      endSession();
      showToast('マイクの使用が許可されていません。ブラウザの設定を確認してください。', 5000);
    }
    // no-speech / network などは onend の自動再開に任せる
  };
  rec.onend = () => {
    recognitionRunning = false;
    // セッション中で読み上げ・思考中でなければ自動再開(Androidは無音で止まるため)
    if (sessionActive && state === 'listening') {
      setTimeout(() => { if (sessionActive && state === 'listening') resumeRecognition(); }, 300);
    }
  };
  return rec;
}

function resumeRecognition() {
  if (!recognition || recognitionRunning) return;
  try { recognition.start(); recognitionRunning = true; } catch { /* already started */ }
}

function pauseRecognition() {
  if (recognition && recognitionRunning) {
    try { recognition.stop(); } catch { /* noop */ }
    recognitionRunning = false;
  }
}

// ===================== 発話ハンドリング =====================
function normalizeKana(s) {
  return s.replace(/[ァ-ン]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/[\s、。!?!?・]/g, '')
    .toLowerCase();
}

function matchWakeWord(text) {
  const ww = normalizeKana(settings.wakeWord || 'ねえ相棒');
  const t = normalizeKana(text);
  const pos = t.indexOf(ww);
  if (pos === -1 || pos > 6) return null; // 冒頭付近にウェイクワードがあるときだけ反応
  // 元テキストからウェイクワード以降を推定して返す(正規化位置とずれるため単純に全文から除去を試みる)
  const raw = text.replace(/[\s、。!?!?・]/g, '');
  const rawNorm = normalizeKana(raw);
  const cut = rawNorm.indexOf(ww) + ww.length;
  // 正規化後のインデックスは raw と1対1対応(置換は同長のため)
  const rest = raw.slice(cut).trim();
  return rest; // 呼びかけのみのときは空文字
}

function handleUtterance(text) {
  if (!sessionActive || state !== 'listening') return;
  if (!text || text.length < 2) return; // ノイズ除去

  let content = text;
  if (settings.mode === 'wake') {
    const rest = matchWakeWord(text);
    if (rest === null) return; // ウェイクワードなし → 無視
    if (!rest) {
      // 呼びかけだけのときはAPIを使わず即応答
      speak('はい、どうしました?', { onAllDone: () => finishTurnAfterSpeech() });
      return;
    }
    content = rest;
  }

  el.userText.textContent = content;
  el.userLine.classList.remove('hidden');
  sendToClaude(content);
}

// ===================== セッション管理 =====================
function ensureSession() {
  const now = Date.now();
  currentSession = sessions[sessions.length - 1] || null;
  if (!currentSession || now - currentSession.updatedAt > SESSION_RESUME_HOURS * 3600 * 1000) {
    currentSession = { id: 'S' + now, startedAt: now, updatedAt: now, turns: [] };
    sessions.push(currentSession);
    apiMessages = [];
    store.set('apiMessages', apiMessages);
  }
  if (sessions.length > 20) sessions = sessions.slice(-20);
  store.set('sessions', sessions);
}

function logTurn(who, text) {
  if (!currentSession) return;
  currentSession.turns.push({ who, text, time: Date.now() });
  currentSession.updatedAt = Date.now();
  store.set('sessions', sessions);
}

function newSession() {
  apiMessages = [];
  store.set('apiMessages', apiMessages);
  currentSession = { id: 'S' + Date.now(), startedAt: Date.now(), updatedAt: Date.now(), turns: [] };
  sessions.push(currentSession);
  store.set('sessions', sessions);
  showToast('新しい会話を始めました');
}

// 履歴をAPIに送れる形に切り詰める(tool_result で始まらない user 境界で切る)
function trimmedMessages() {
  if (apiMessages.length <= MAX_HISTORY_MESSAGES) return apiMessages;
  for (let i = apiMessages.length - MAX_HISTORY_MESSAGES; i < apiMessages.length; i++) {
    const m = apiMessages[i];
    const isToolResult = Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');
    if (m.role === 'user' && !isToolResult) return apiMessages.slice(i);
  }
  return apiMessages.slice(-MAX_HISTORY_MESSAGES);
}

// ===================== Claude API =====================
function buildTools() {
  const tools = [SAVE_MEMO_TOOL];
  if (settings.webSearch) tools.push(WEB_SEARCH_TOOL);
  return tools;
}

async function sendToClaude(userText) {
  if (!settings.apiKey) {
    showToast('設定画面でClaude APIキーを入力してください', 4000);
    openPanel('panel-settings');
    return;
  }
  pauseRecognition();
  setState('thinking');
  logTurn('user', userText);

  apiMessages.push({
    role: 'user',
    content: [{ type: 'text', text: `【状況】${contextLine()}\n【発話】${userText}` }],
  });

  el.aiText.textContent = '';
  el.aiLine.classList.remove('hidden');

  try {
    let loops = 0;
    while (loops++ < 6) {
      const result = await streamOnce();
      if (result.stopReason === 'tool_use') {
        const toolResults = [];
        for (const block of result.content) {
          if (block.type === 'tool_use' && block.name === 'save_memo') {
            const memoText = (block.input && block.input.text || '').trim();
            saveMemo(memoText);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: '保存しました' });
          } else if (block.type === 'tool_use') {
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: '不明なツールです', is_error: true });
          }
        }
        if (toolResults.length === 0) break;
        apiMessages.push({ role: 'user', content: toolResults });
        continue;
      }
      if (result.stopReason === 'pause_turn') continue; // Web検索の続きを取得
      break;
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      const msg = err.status === 401 ? 'エラーです。APIキーを確認してください。'
        : err.status === 429 ? 'すみません、利用制限中です。少し待ってください。'
        : err.status === 400 && /credit/i.test(err.message || '') ? 'エラーです。APIのクレジット残高を確認してください。'
        : '通信エラーです。電波の良いところでもう一度どうぞ。';
      el.aiText.textContent = msg;
      speak(msg);
      // 失敗したuserメッセージを履歴から取り除き、会話を壊さない
      const last = apiMessages[apiMessages.length - 1];
      if (last && last.role === 'user') apiMessages.pop();
    }
  } finally {
    store.set('apiMessages', apiMessages);
    abortController = null;
    finishTurn();
  }
}

function finishTurn() {
  if (!sessionActive) { setState('idle'); return; }
  if (pendingUtterances > 0) {
    setState('speaking'); // 読み上げ完了時に speak() の onAllDone 経由で戻る
  } else {
    setState('listening');
    resumeRecognition();
  }
}

// 1リクエスト分をストリーミングで受け、文単位で読み上げる
async function streamOnce() {
  abortController = new AbortController();
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: buildTools(),
    messages: trimmedMessages(),
    stream: true,
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    signal: abortController.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* noop */ }
    const err = new Error(detail || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const chunker = createSentenceChunker((sentence) => {
    speak(sentence, { onAllDone: () => { if (state === 'speaking') finishTurnAfterSpeech(); } });
  });

  const blocks = {};      // index -> content block(組み立て中)
  const jsonBufs = {};    // index -> partial_json 文字列
  let stopReason = null;
  let fullText = '';

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuf += decoder.decode(value, { stream: true });
    const lines = sseBuf.split('\n');
    sseBuf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let ev;
      try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      switch (ev.type) {
        case 'content_block_start':
          blocks[ev.index] = JSON.parse(JSON.stringify(ev.content_block));
          if (ev.content_block.type === 'tool_use' || ev.content_block.type === 'server_tool_use') jsonBufs[ev.index] = '';
          break;
        case 'content_block_delta':
          if (ev.delta.type === 'text_delta') {
            const t = ev.delta.text;
            blocks[ev.index].text = (blocks[ev.index].text || '') + t;
            fullText += t;
            el.aiText.textContent = fullText;
            chunker.push(t);
          } else if (ev.delta.type === 'input_json_delta') {
            jsonBufs[ev.index] += ev.delta.partial_json;
          }
          break;
        case 'content_block_stop':
          if (jsonBufs[ev.index] !== undefined) {
            try { blocks[ev.index].input = jsonBufs[ev.index] ? JSON.parse(jsonBufs[ev.index]) : {}; }
            catch { blocks[ev.index].input = {}; }
            delete jsonBufs[ev.index];
          }
          break;
        case 'message_delta':
          if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
          break;
        case 'error': {
          const err = new Error(ev.error?.message || 'stream error');
          err.status = 500;
          throw err;
        }
      }
    }
  }

  chunker.flush();

  const content = Object.keys(blocks).sort((a, b) => a - b).map((k) => blocks[k]);
  if (content.length > 0) apiMessages.push({ role: 'assistant', content });
  if (fullText.trim()) logTurn('ai', fullText.trim());
  return { stopReason, content, text: fullText };
}

function finishTurnAfterSpeech() {
  if (!sessionActive) { setState('idle'); return; }
  if (abortController) { setState('thinking'); return; } // まだ応答取得中(ツール実行・検索の続きなど)
  setState('listening');
  resumeRecognition();
}

// ===================== メモ =====================
function saveMemo(text) {
  if (!text) return;
  memos.push({
    id: 'M' + Date.now(),
    text,
    time: Date.now(),
    lat: geo ? geo.lat : null,
    lon: geo ? geo.lon : null,
  });
  store.set('memos', memos);
  renderMemos();
}

function memoToText(m) {
  let s = `[${fmtTime(m.time)}] ${m.text}`;
  if (m.lat != null) s += `\n  位置: https://www.google.com/maps?q=${m.lat.toFixed(5)},${m.lon.toFixed(5)}`;
  return s;
}

function renderMemos() {
  const list = $('memo-list');
  list.innerHTML = '';
  $('memo-empty').classList.toggle('hidden', memos.length > 0);
  for (const m of [...memos].reverse()) {
    const li = document.createElement('li');
    li.className = 'memo-item';
    const text = document.createElement('div');
    text.className = 'memo-text';
    text.textContent = m.text;
    const meta = document.createElement('div');
    meta.className = 'memo-meta';
    const when = document.createElement('span');
    when.textContent = fmtTime(m.time) + (m.lat != null ? ' 📍' : '');
    const actions = document.createElement('div');
    actions.className = 'memo-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'icon-btn';
    copyBtn.textContent = '📋';
    copyBtn.onclick = () => { navigator.clipboard.writeText(memoToText(m)); showToast('コピーしました'); };
    const mapBtn = document.createElement('button');
    mapBtn.className = 'icon-btn';
    mapBtn.textContent = '🗺️';
    mapBtn.disabled = m.lat == null;
    mapBtn.onclick = () => { if (m.lat != null) window.open(`https://www.google.com/maps?q=${m.lat},${m.lon}`, '_blank'); };
    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn';
    delBtn.textContent = '🗑️';
    delBtn.onclick = () => {
      memos = memos.filter((x) => x.id !== m.id);
      store.set('memos', memos);
      renderMemos();
    };
    actions.append(copyBtn, mapBtn, delBtn);
    meta.append(when, actions);
    li.append(text, meta);
    list.appendChild(li);
  }
}

async function shareText(title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return; } catch { /* キャンセル等 */ }
  }
  await navigator.clipboard.writeText(text);
  showToast('クリップボードにコピーしました');
}

// ===================== 履歴 =====================
function renderHistory() {
  const wrap = $('history-list');
  wrap.innerHTML = '';
  const nonEmpty = sessions.filter((s) => s.turns.length > 0);
  $('history-empty').classList.toggle('hidden', nonEmpty.length > 0);
  for (const s of [...nonEmpty].reverse()) {
    const block = document.createElement('div');
    block.className = 'session-block';
    const date = document.createElement('div');
    date.className = 'session-date';
    date.textContent = `${fmtTime(s.startedAt)} のツーリング(${s.turns.length}発話)`;
    block.appendChild(date);
    for (const t of s.turns) {
      const div = document.createElement('div');
      div.className = 'turn ' + (t.who === 'user' ? 'user' : 'ai');
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = t.who === 'user' ? 'あなた' : '相棒';
      const body = document.createElement('div');
      body.textContent = t.text;
      div.append(who, body);
      block.appendChild(div);
    }
    wrap.appendChild(block);
  }
}

function sessionToText(s) {
  const head = `ツーリング会話ログ ${fmtTime(s.startedAt)}\n`;
  return head + s.turns.map((t) => `${t.who === 'user' ? 'あなた' : '相棒'}: ${t.text}`).join('\n');
}

// ===================== セッション開始/終了 =====================
async function startSession() {
  if (!settings.apiKey) {
    showToast('先に設定画面でClaude APIキーを入力してください', 4000);
    openPanel('panel-settings');
    return;
  }
  if (!recognition) recognition = createRecognition();
  if (!recognition) {
    showToast('このブラウザは音声認識に対応していません。Android Chromeでお使いください。', 6000);
    return;
  }
  sessionActive = true;
  ensureSession();
  startGeo();
  acquireWakeLock();
  // ユーザー操作起点でTTSを一度動かして音声再生をアンロックする
  speechSynthesis.cancel();
  setState('listening');
  resumeRecognition();
  const greet = settings.mode === 'wake'
    ? `準備できました。${settings.wakeWord}、と呼びかけてください。`
    : '準備できました。いつでも話しかけてください。';
  speak(greet, { onAllDone: () => finishTurnAfterSpeech() });
}

function endSession() {
  sessionActive = false;
  if (abortController) abortController.abort();
  stopSpeaking();
  pauseRecognition();
  stopGeo();
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  setState('idle');
}

// 大ボタン: 状態に応じて開始/終了/応答キャンセル
el.bigBtn.addEventListener('click', () => {
  if (state === 'idle') {
    startSession();
  } else if (state === 'thinking' || state === 'speaking') {
    if (abortController) abortController.abort();
    stopSpeaking();
    finishTurnAfterSpeech();
    showToast('応答を止めました');
  } else {
    endSession();
  }
});

// ===================== パネル・設定UI =====================
function openPanel(id) { $(id).classList.remove('hidden'); }
function closePanel(id) { $(id).classList.add('hidden'); }

document.querySelectorAll('.panel-close').forEach((btn) => {
  btn.addEventListener('click', () => closePanel(btn.dataset.close));
});
$('btn-settings').addEventListener('click', () => openPanel('panel-settings'));
$('btn-memos').addEventListener('click', () => { renderMemos(); openPanel('panel-memos'); });
$('btn-history').addEventListener('click', () => { renderHistory(); openPanel('panel-history'); });

function refreshModeIndicator() {
  el.modeLabel.textContent = settings.mode === 'wake' ? `ウェイクワード「${settings.wakeWord}」` : '常時会話モード';
  el.searchLabel.classList.toggle('hidden', !settings.webSearch);
  $('row-wakeword').style.display = settings.mode === 'wake' ? '' : 'none';
}

function initSettingsUI() {
  $('set-apikey').value = settings.apiKey;
  $('set-mode').value = settings.mode;
  $('set-wakeword').value = settings.wakeWord;
  $('set-websearch').checked = settings.webSearch;
  $('set-geo').checked = settings.useGeo;
  $('set-rate').value = settings.rate;
  $('rate-out').textContent = Number(settings.rate).toFixed(1);

  $('set-apikey').addEventListener('change', (e) => { settings.apiKey = e.target.value.trim(); store.set('apiKey', settings.apiKey); });
  $('set-mode').addEventListener('change', (e) => { settings.mode = e.target.value; store.set('mode', settings.mode); refreshModeIndicator(); if (state === 'listening') setState('listening'); });
  $('set-wakeword').addEventListener('change', (e) => { settings.wakeWord = e.target.value.trim() || 'ねえ相棒'; store.set('wakeWord', settings.wakeWord); refreshModeIndicator(); });
  $('set-websearch').addEventListener('change', (e) => { settings.webSearch = e.target.checked; store.set('webSearch', settings.webSearch); refreshModeIndicator(); });
  $('set-geo').addEventListener('change', (e) => {
    settings.useGeo = e.target.checked;
    store.set('useGeo', settings.useGeo);
    if (settings.useGeo && sessionActive) startGeo(); else stopGeo();
  });
  $('set-rate').addEventListener('input', (e) => {
    settings.rate = Number(e.target.value);
    store.set('rate', settings.rate);
    $('rate-out').textContent = settings.rate.toFixed(1);
  });

  const voiceSelect = $('set-voice');
  function populateVoices() {
    const voices = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.startsWith('ja'));
    voiceSelect.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '自動(日本語)';
    voiceSelect.appendChild(auto);
    for (const v of voices) {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = v.name;
      voiceSelect.appendChild(opt);
    }
    voiceSelect.value = settings.voiceName;
  }
  populateVoices();
  speechSynthesis.addEventListener('voiceschanged', populateVoices);
  voiceSelect.addEventListener('change', (e) => { settings.voiceName = e.target.value; store.set('voiceName', settings.voiceName); });

  $('btn-test-voice').addEventListener('click', () => speak('こんにちは、相棒です。今日はどこまで走りますか。'));

  $('btn-new-session').addEventListener('click', () => { newSession(); closePanel('panel-settings'); });
  $('btn-clear-all').addEventListener('click', () => {
    if (!confirm('メモ・会話履歴・APIキーを含む全データを削除します。よろしいですか?')) return;
    endSession();
    localStorage.clear();
    location.reload();
  });

  $('btn-share-memos').addEventListener('click', () => {
    if (memos.length === 0) { showToast('メモがありません'); return; }
    shareText('ツーリングメモ', memos.map(memoToText).join('\n\n'));
  });
  $('btn-share-history').addEventListener('click', () => {
    const s = sessions[sessions.length - 1];
    if (!s || s.turns.length === 0) { showToast('会話がありません'); return; }
    shareText('ツーリング会話ログ', sessionToText(s));
  });
}

// ===================== 起動 =====================
initSettingsUI();
refreshModeIndicator();
renderMemos();
setState('idle');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
