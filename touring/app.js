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
- 収録済みのガイド・ラジオの再生操作はアプリ本体が音声コマンドで処理する。再生を頼まれたら「ガイド再生、またはラジオ流して、と言ってみてください」と短く案内する。

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

// パック生成(事前収録)用: 品質重視でOpus 5を使用
const MODEL_GEN = 'claude-opus-5';
const GEN_WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 4 };
const GEN_SYSTEM = `あなたは日本のツーリング向け音声コンテンツ(バスガイド風ツアーガイド・ラジオ番組)の敏腕構成作家です。歴史・地理・地形・グルメ・雑学に精通し、聞いていて楽しく、ためになる語りを書きます。出力は必ず指示されたJSONのみを返し、それ以外の文章は一切書きません。`;

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
  ttsEngine: store.get('ttsEngine', 'device'),   // 'device' | 'azure'
  azureKey: store.get('azureKey', ''),
  azureRegion: store.get('azureRegion', 'japaneast'),
  azureVoice: store.get('azureVoice', 'ja-JP-NanamiNeural'),
};

let memos = store.get('memos', []);           // {id, text, time, lat, lon}
let packs = store.get('packs', []);           // {id, type:'guide'|'radio', title, dest, memo, geoEnabled, createdAt, tracks:[{title,text,lat,lon,radius,played}]}
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
let generating = false;         // パック生成中フラグ
const player = {                // ガイド・ラジオ再生の状態
  packId: null,
  idx: -1,
  continuous: false,            // トラック終了後に自動で次へ進むか
  chatInterrupted: false,       // 会話割り込み後に再生を再開するか
  autoTimer: null,
};

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
      maybeGeoTrigger();
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

function useAzure() {
  return settings.ttsEngine === 'azure' && !!settings.azureKey;
}

function speechDone(onAllDone) {
  pendingUtterances = Math.max(0, pendingUtterances - 1);
  if (pendingUtterances === 0 && onAllDone) onAllDone();
}

function speak(text, { onAllDone } = {}) {
  const clean = sanitizeForSpeech(text);
  if (!clean) { if (onAllDone && pendingUtterances === 0) onAllDone(); return; }
  pendingUtterances++;
  // 読み上げ中は自分の声を拾わないよう認識を止める
  pauseRecognition();
  if (sessionActive && (state === 'thinking' || state === 'listening')) setState('speaking');
  if (useAzure()) azureEnqueue(clean, onAllDone);
  else deviceSpeak(clean, onAllDone);
}

function deviceSpeak(clean, onAllDone) {
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = 'ja-JP';
  const voice = pickVoice();
  if (voice) u.voice = voice;
  u.rate = settings.rate;
  const done = () => speechDone(onAllDone);
  u.onend = done;
  u.onerror = done;
  speechSynthesis.speak(u);
}

// 端末TTSをPromiseで待つ(Azure失敗時のフォールバック用。カウンタは操作しない)
function deviceSpeakRaw(clean) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = 'ja-JP';
    const voice = pickVoice();
    if (voice) u.voice = voice;
    u.rate = settings.rate;
    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

function stopSpeaking() {
  pendingUtterances = 0;
  azureGen++;
  azureQueue = [];
  try { audioEl.pause(); audioEl.removeAttribute('src'); } catch { /* noop */ }
  speechSynthesis.cancel();
}

// ---- Microsoft Azure 音声合成 ----
const audioEl = new Audio();
let azureQueue = [];
let azureBusy = false;
let azureGen = 0; // 停止するたびに増やし、進行中の再生ループを無効化する

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

async function azureSynth(text) {
  const pct = Math.round((settings.rate - 1) * 100);
  const ssml = `<speak version="1.0" xml:lang="ja-JP"><voice name="${settings.azureVoice}"><prosody rate="${pct >= 0 ? '+' : ''}${pct}%">${escapeXml(text)}</prosody></voice></speak>`;
  const res = await fetch(`https://${settings.azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': settings.azureKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
    },
    body: ssml,
  });
  if (!res.ok) throw new Error('Azure TTS HTTP ' + res.status);
  return await res.blob();
}

function playBlobOnce(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const cleanup = () => { URL.revokeObjectURL(url); resolve(); };
    audioEl.src = url;
    audioEl.onended = cleanup;
    audioEl.onerror = cleanup;
    audioEl.play().catch(cleanup);
  });
}

function azureEnqueue(text, onAllDone) {
  azureQueue.push({ text, onAllDone, blobPromise: null });
  azureLoop();
}

async function azureLoop() {
  if (azureBusy) return;
  azureBusy = true;
  const gen = azureGen;
  try {
    while (azureQueue.length > 0 && gen === azureGen) {
      const item = azureQueue.shift();
      // 次の文を先読み合成してつなぎ目の待ちを減らす
      if (azureQueue[0] && !azureQueue[0].blobPromise) {
        const next = azureQueue[0];
        next.blobPromise = azureSynth(next.text).catch(() => null);
      }
      let blob = null;
      try { blob = await (item.blobPromise || azureSynth(item.text)); } catch { blob = null; }
      if (gen !== azureGen) break; // 停止済み
      if (blob) await playBlobOnce(blob);
      else await deviceSpeakRaw(item.text); // 圏外・エラー時は端末TTSにフォールバック
      if (gen !== azureGen) break;
      speechDone(item.onAllDone);
    }
  } finally {
    azureBusy = false;
    if (azureQueue.length > 0 && gen === azureGen) azureLoop();
  }
}

// 収録トラックの合成済み音声1本をそのまま再生する
async function speakCachedBlob(blob, onAllDone) {
  pendingUtterances++;
  pauseRecognition();
  if (sessionActive && (state === 'thinking' || state === 'listening')) setState('speaking');
  const gen = azureGen;
  await playBlobOnce(blob);
  if (gen === azureGen) speechDone(onAllDone);
}

// ---- 合成済み音声の保存 (IndexedDB) ----
let adbPromise = null;
function adbOpen() {
  if (adbPromise) return adbPromise;
  adbPromise = new Promise((res, rej) => {
    const r = indexedDB.open('touring_audio', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('a');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return adbPromise;
}
function adbPut(key, val) {
  return adbOpen().then((db) => new Promise((res, rej) => {
    const tx = db.transaction('a', 'readwrite');
    tx.objectStore('a').put(val, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  }));
}
function adbGet(key) {
  return adbOpen().then((db) => new Promise((res, rej) => {
    const rq = db.transaction('a').objectStore('a').get(key);
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => rej(rq.error);
  }));
}
function adbDel(key) {
  return adbOpen().then((db) => new Promise((res, rej) => {
    const tx = db.transaction('a', 'readwrite');
    tx.objectStore('a').delete(key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  }));
}
function audioKey(packId, idx) { return `${packId}|${idx}`; }

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

  // ガイド・ラジオの音声コマンドはウェイクワード不要で最優先処理
  // (停止・次・続きなどは再生コンテキストがあるときだけコマンド扱いにする)
  const cmd = matchCommand(normalizeKana(text));
  if (cmd && (cmd === 'guide' || cmd === 'radio' || player.packId)) { runCommand(cmd); return; }

  // 連続再生の合間に会話が始まったら、自動進行を止めて会話後に再開する
  if (player.autoTimer) {
    clearAuto();
    if (player.continuous) player.chatInterrupted = true;
  }

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
  // 会話で中断していた連続再生を少し置いて再開
  if (player.chatInterrupted && player.packId && player.continuous) {
    player.chatInterrupted = false;
    scheduleAuto(6000);
  }
}

// ===================== ガイド・ラジオ再生 =====================
function savePacks() { store.set('packs', packs); }
function findPack(id) { return packs.find((p) => p.id === id); }
function latestPack(type) {
  for (let i = packs.length - 1; i >= 0; i--) {
    if (packs[i].type === type && packs[i].tracks.length > 0) return packs[i];
  }
  return null;
}

function splitSentences(text) {
  return (text.match(/[^。!?!?\n]+[。!?!?\n]?/g) || [text]).map((s) => s.trim()).filter(Boolean);
}

function clearAuto() {
  if (player.autoTimer) { clearTimeout(player.autoTimer); player.autoTimer = null; }
}

function stopPack(silent) {
  clearAuto();
  player.continuous = false;
  player.chatInterrupted = false;
  player.packId = null;
  player.idx = -1;
  if (!silent) speak('再生を止めました。', { onAllDone: () => finishTurnAfterSpeech() });
}

function playTrack(pack, i, opts = {}) {
  const track = pack.tracks[i];
  if (!track) return;
  clearAuto();
  player.packId = pack.id;
  player.idx = i;
  player.continuous = opts.continuous !== false;
  player.chatInterrupted = false;
  const label = pack.type === 'guide' ? 'ガイド' : 'ラジオ';
  const intro = opts.geo ? `ここで${label}です。${track.title}。` : `${label}、${track.title}。`;
  el.aiText.textContent = `🎧 ${track.title}`;
  el.aiLine.classList.remove('hidden');
  const speakLive = () => {
    const parts = [intro].concat(splitSentences(track.text));
    parts.forEach((s, k) => {
      speak(s, k === parts.length - 1 ? { onAllDone: () => onTrackEnd(pack.id, i) } : undefined);
    });
  };
  if (useAzure()) {
    // 事前合成した音声があればオフラインでもそのまま再生
    adbGet(audioKey(pack.id, i)).then((blob) => {
      if (player.packId !== pack.id || player.idx !== i) return; // 待ち時間中に別再生が始まった
      if (blob) speakCachedBlob(blob, () => onTrackEnd(pack.id, i));
      else speakLive();
    }).catch(speakLive);
  } else {
    speakLive();
  }
  renderPacks();
}

function onTrackEnd(packId, i) {
  const pack = findPack(packId);
  if (pack && pack.tracks[i]) { pack.tracks[i].played = true; savePacks(); }
  if (pack && player.continuous && player.packId === packId) {
    const hasNext = pack.tracks.some((t, k) => k > i && !t.played);
    if (!hasNext) {
      player.continuous = false;
      renderPacks();
      speak('このパックは最後まで再生しました。', { onAllDone: () => finishTurnAfterSpeech() });
      return;
    }
    scheduleAuto(4000); // 少し間を置いて次のトラックへ(この間は聞き取りが再開され会話もできる)
  }
  renderPacks();
  finishTurnAfterSpeech();
}

function scheduleAuto(ms) {
  clearAuto();
  player.autoTimer = setTimeout(() => {
    player.autoTimer = null;
    const pack = findPack(player.packId);
    if (!pack || !player.continuous) return;
    // 会話や応答の最中なら少し待って再試行
    if (state === 'thinking' || pendingUtterances > 0 || abortController) { scheduleAuto(3000); return; }
    const next = pack.tracks.findIndex((t, k) => k > player.idx && !t.played);
    if (next !== -1) playTrack(pack, next, { continuous: true });
  }, ms);
}

function startPack(pack) {
  if (!pack || pack.tracks.length === 0) return;
  if (pack.tracks.every((t) => t.played)) pack.tracks.forEach((t) => { t.played = false; }); // 全部聴き終えていたら最初から
  const first = pack.tracks.findIndex((t) => !t.played);
  playTrack(pack, first === -1 ? 0 : first, { continuous: true });
}

// GPSでスポットに近づいたら該当トラックを自動再生
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function maybeGeoTrigger() {
  if (!sessionActive || state !== 'listening' || pendingUtterances > 0 || abortController || !geo) return;
  for (const pack of packs) {
    if (pack.type !== 'guide' || !pack.geoEnabled) continue;
    for (let i = 0; i < pack.tracks.length; i++) {
      const t = pack.tracks[i];
      if (t.played || t.lat == null || t.lon == null) continue;
      if (distanceKm(geo.lat, geo.lon, t.lat, t.lon) <= (t.radius || 3)) {
        playTrack(pack, i, { continuous: false, geo: true });
        return;
      }
    }
  }
}

// ---- 音声コマンド(ウェイクワード不要) ----
function matchCommand(n) {
  if (!n || n.length > 16) return null;
  const play = /(再生|さいせい|流して|ながして|かけて|つけて|すたーと|開始|聞かせて|きかせて|お願い|おねがい)/;
  const stop = /(止めて|とめて|停止|ていし|すとっぷ|やめて|終了|おふ)/;
  if (/がいど/.test(n) && stop.test(n)) return 'stop';
  if (/らじお/.test(n) && stop.test(n)) return 'stop';
  if (/がいど/.test(n) && (play.test(n) || n === 'がいど')) return 'guide';
  if (/らじお/.test(n) && (play.test(n) || n === 'らじお')) return 'radio';
  if (/^(つぎ|次)(へ|で|の(とらっく|曲|きょく|話|はなし))?(お願い|おねがい)?$/.test(n) || n === 'すきっぷ') return 'next';
  if (/^(つづき|続き|さいかい|再開)(から|を|お願い|おねがい)?(再生|さいせい)?$/.test(n)) return 'resume';
  if (/^(すとっぷ|停止|ていし|止めて|とめて|やめて|それ止めて|もう止めて|再生止めて)$/.test(n)) return 'stop';
  if (/^(もう一度|もういちど|もう一回|もういっかい|もっかい)(お願い|おねがい)?$/.test(n)) return 'repeat';
  return null;
}

function speakNotice(msg) {
  speak(msg, { onAllDone: () => finishTurnAfterSpeech() });
}

function runCommand(cmd) {
  const pack = player.packId ? findPack(player.packId) : null;
  switch (cmd) {
    case 'guide': {
      const p = latestPack('guide');
      if (!p) { speakNotice('ガイドパックがまだありません。アプリのガイド画面で生成してください。'); return; }
      startPack(p);
      return;
    }
    case 'radio': {
      const p = latestPack('radio');
      if (!p) { speakNotice('ラジオパックがまだありません。アプリのガイド画面で生成してください。'); return; }
      startPack(p);
      return;
    }
    case 'next': {
      const p = pack || latestPack('guide') || latestPack('radio');
      if (!p) { speakNotice('再生できるパックがありません。'); return; }
      const from = p.id === player.packId ? player.idx : -1;
      const next = p.tracks.findIndex((t, k) => k > from && !t.played);
      if (next === -1) { speakNotice('最後のトラックです。'); return; }
      playTrack(p, next, { continuous: true });
      return;
    }
    case 'resume': {
      const p = pack;
      if (!p) { speakNotice('再生中のパックがありません。ガイド再生、と言ってください。'); return; }
      const cur = p.tracks[player.idx];
      const idx = cur && !cur.played ? player.idx : p.tracks.findIndex((t, k) => k > player.idx && !t.played);
      if (idx === -1) { speakNotice('このパックは最後まで再生済みです。'); return; }
      playTrack(p, idx, { continuous: true });
      return;
    }
    case 'repeat': {
      if (!pack || player.idx < 0) { speakNotice('再生中のトラックがありません。'); return; }
      playTrack(pack, player.idx, { continuous: player.continuous });
      return;
    }
    case 'stop':
      stopPack(false);
      return;
  }
}

// ---- パック生成(Claude Opus 5) ----
async function genApiRequest(userText, useSearch, onStatus) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: userText }] }];
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL_GEN,
        max_tokens: 16000,
        fallbacks: 'default',
        system: GEN_SYSTEM,
        tools: useSearch ? [GEN_WEB_SEARCH_TOOL] : [],
        messages,
      }),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error?.message || ''; } catch { /* noop */ }
      throw new Error(res.status === 401 ? 'APIキーが正しくありません' : (detail || `HTTP ${res.status}`));
    }
    const data = await res.json();
    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: data.content });
      if (onStatus) onStatus('Web検索中…');
      continue;
    }
    if (data.stop_reason === 'refusal') throw new Error('生成が拒否されました。内容を変えて再試行してください');
    return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  throw new Error('生成が完了しませんでした');
}

function extractJson(text) {
  const s = text.indexOf('['), e = text.lastIndexOf(']');
  if (s === -1 || e <= s) throw new Error('生成結果の解析に失敗しました');
  return JSON.parse(text.slice(s, e + 1));
}

function guideOutlinePrompt(title, memo, count) {
  return `「${title}」へのツーリング向け音声ガイド(バスガイド風)を作ります。
ライダーのメモ: ${memo || '特になし'}

まず全${count}トラックの構成案を作ってください。
条件:
- 主要なアプローチ路、道中と現地の見どころ、歴史、地理・地形、グルメ、雑学をバランスよく
- 場所に強く紐づくトラックには、その場所の中心の緯度(lat)・経度(lon)と再生トリガー半径radius_km(2〜8)を入れる。位置に自信がない場合はnullにする
- 導入・総論・まとめなど場所に紐づかないトラックはlat/lon/radius_kmをnull
- おおよそのルート順(アプローチ→現地→まとめ)に並べる
出力は次の形のJSON配列のみ:
[{"title":"トラック名","summary":"内容の要点1文","lat":33.5,"lon":132.9,"radius_km":4}]`;
}

function radioOutlinePrompt(title, memo, count) {
  return `ツーリング中にどこでも聴ける音声ラジオ番組「${title}」を作ります。
リスナーの要望メモ: ${memo || '特になし'}

まず全${count}回分のエピソード構成案を作ってください。
条件:
- バイク・道路・地理・歴史・雑学など、走りながら聴いて楽しい話題
- 1エピソード1テーマで、雑学として満足度が高い切り口にする
- lat/lon/radius_kmはすべてnull
出力は次の形のJSON配列のみ:
[{"title":"エピソード名","summary":"内容の要点1文","lat":null,"lon":null,"radius_km":null}]`;
}

function batchPrompt(type, title, memo, outline, batch) {
  return `「${title}」向け音声${type === 'guide' ? 'ガイド' : 'ラジオ番組'}の本文を執筆します。
リスナーはバイクで走行中のライダーで、本文はそのまま音声読み上げされます。
リスナーのメモ: ${memo || '特になし'}
全体の構成: ${JSON.stringify(outline.map((o) => o.title))}

今回執筆するトラック: ${JSON.stringify(batch.map((o) => ({ title: o.title, summary: o.summary })))}

条件:
- 各トラック300〜500文字。話し言葉の日本語、です・ます調で、バスガイドやラジオDJのような聞いて楽しい語り口
- 記号・箇条書き・URL・絵文字は使わない。数字は漢数字など耳で聞いて分かる表現にする
- 変わりやすい情報(営業時間・料金など)は断定せず、変わりやすいので確認を、と一言添える
- 運転中でも安全に聞ける内容にし、必要な安全上の注意は自然に織り込む
出力は今回のトラックと同数・同順のJSON配列のみ:
[{"title":"トラック名","text":"本文"}]`;
}

async function generatePack() {
  if (generating) return;
  if (!settings.apiKey) {
    showToast('先に設定画面でClaude APIキーを入力してください', 4000);
    openPanel('panel-settings');
    return;
  }
  const type = $('gen-type').value;
  const title = $('gen-title').value.trim();
  const memo = $('gen-memo').value.trim();
  const count = Number($('gen-count').value);
  const useSearch = $('gen-search').checked;
  const geoOn = type === 'guide' && $('gen-geo').checked;
  if (!title) { showToast(type === 'guide' ? '目的地を入力してください' : 'テーマを入力してください'); return; }

  generating = true;
  const prog = $('gen-progress');
  const btn = $('btn-generate');
  prog.classList.remove('hidden');
  btn.disabled = true;
  try {
    prog.textContent = '構成(トラック一覧)を作成中…';
    const outlineText = await genApiRequest(
      type === 'guide' ? guideOutlinePrompt(title, memo, count) : radioOutlinePrompt(title, memo, count),
      useSearch, (s) => { prog.textContent = `構成を作成中… ${s}`; });
    const outline = extractJson(outlineText).slice(0, count).filter((o) => o && o.title);
    if (outline.length === 0) throw new Error('構成の生成に失敗しました');

    const tracks = [];
    for (let i = 0; i < outline.length; i += 5) {
      const batch = outline.slice(i, i + 5);
      prog.textContent = `本文を執筆中… ${i + 1}〜${Math.min(i + 5, outline.length)} / ${outline.length}トラック`;
      const items = extractJson(await genApiRequest(batchPrompt(type, title, memo, outline, batch), useSearch));
      batch.forEach((o, k) => {
        const it = items[k] || {};
        const text = String(it.text || '').trim();
        if (!text) return;
        tracks.push({
          title: o.title,
          text,
          lat: geoOn && o.lat != null ? Number(o.lat) : null,
          lon: geoOn && o.lon != null ? Number(o.lon) : null,
          radius: geoOn && o.radius_km != null ? Number(o.radius_km) : null,
          played: false,
        });
      });
    }
    if (tracks.length < Math.max(2, outline.length / 2)) throw new Error('生成結果が不完全でした。もう一度お試しください');

    packs.push({
      id: 'P' + Date.now(),
      type, dest: title, memo,
      title: type === 'guide' ? `${title} ツアーガイド` : title,
      geoEnabled: geoOn,
      createdAt: Date.now(),
      tracks,
    });
    savePacks();
    renderPacks();
    prog.textContent = `完成! ${tracks.length}トラックを保存しました。走行中は「${type === 'guide' ? 'ガイド再生' : 'ラジオ流して'}」で再生できます。`;
    $('gen-title').value = '';
    $('gen-memo').value = '';
  } catch (err) {
    console.error(err);
    prog.textContent = 'エラー: ' + err.message;
  } finally {
    generating = false;
    btn.disabled = false;
  }
}

// パック全トラックをAzureで事前合成して端末に保存(オフライン再生用)
async function renderPackAudio(pack, btn) {
  if (!useAzure()) { showToast('設定でMicrosoft Azure音声を有効にしてください'); return; }
  btn.disabled = true;
  const label = pack.type === 'guide' ? 'ガイド' : 'ラジオ';
  try {
    for (let i = 0; i < pack.tracks.length; i++) {
      btn.textContent = `音声作成中… ${i + 1}/${pack.tracks.length}`;
      const t = pack.tracks[i];
      const blob = await azureSynth(sanitizeForSpeech(`${label}、${t.title}。${t.text}`));
      await adbPut(audioKey(pack.id, i), blob);
    }
    pack.audioReady = true;
    savePacks();
    showToast('音声を保存しました。オフラインでも再生できます');
  } catch (err) {
    console.error(err);
    showToast('音声作成に失敗しました: ' + err.message, 4000);
  } finally {
    btn.disabled = false;
    renderPacks();
  }
}

// ---- パック一覧UI ----
function renderPacks() {
  const wrap = $('pack-list');
  if (!wrap) return;
  const openIds = new Set([...wrap.querySelectorAll('details[open]')].map((d) => d.dataset.id));
  wrap.innerHTML = '';
  for (const pack of [...packs].reverse()) {
    const det = document.createElement('details');
    det.className = 'pack-item';
    det.dataset.type = pack.type;
    det.dataset.id = pack.id;
    if (openIds.has(pack.id)) det.open = true;

    const sum = document.createElement('summary');
    const badge = document.createElement('span');
    badge.className = 'pack-badge ' + pack.type;
    badge.textContent = pack.type === 'guide' ? 'ガイド' : 'ラジオ';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'pack-title-wrap';
    const played = pack.tracks.filter((t) => t.played).length;
    titleWrap.innerHTML = '';
    const t1 = document.createElement('div');
    t1.className = 'pack-title';
    t1.textContent = pack.title;
    const t2 = document.createElement('div');
    t2.className = 'pack-sub';
    t2.textContent = `${pack.tracks.length}トラック / 再生済み ${played}` + (pack.geoEnabled ? ' / 📍位置連動' : '');
    titleWrap.append(t1, t2);
    const playBtn = document.createElement('button');
    playBtn.className = 'pack-play-btn';
    playBtn.textContent = '▶ 再生';
    playBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); startPack(pack); showToast('再生を開始しました'); };
    sum.append(badge, titleWrap, playBtn);
    det.appendChild(sum);

    const body = document.createElement('div');
    body.className = 'pack-tracks';
    pack.tracks.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'pack-track';
      const st = document.createElement('span');
      st.className = 't-status';
      st.textContent = player.packId === pack.id && player.idx === i ? '🔊' : (t.played ? '✓' : '・');
      const tt = document.createElement('span');
      tt.className = 't-title' + (t.played ? ' played' : '');
      tt.textContent = `${i + 1}. ${t.title}`;
      const gg = document.createElement('span');
      gg.className = 't-geo';
      gg.textContent = t.lat != null ? '📍' : '';
      const pb = document.createElement('button');
      pb.className = 'icon-btn';
      pb.textContent = '▶';
      pb.onclick = () => playTrack(pack, i, { continuous: true });
      row.append(st, tt, gg, pb);
      body.appendChild(row);
    });
    const actions = document.createElement('div');
    actions.className = 'pack-actions';
    const resetBtn = document.createElement('button');
    resetBtn.className = 'sub-btn';
    resetBtn.textContent = '再生済みをリセット';
    resetBtn.onclick = () => { pack.tracks.forEach((t) => { t.played = false; }); savePacks(); renderPacks(); };
    const delBtn = document.createElement('button');
    delBtn.className = 'sub-btn danger';
    delBtn.textContent = '削除';
    delBtn.onclick = () => {
      if (!confirm(`「${pack.title}」を削除しますか?`)) return;
      if (player.packId === pack.id) stopPack(true);
      pack.tracks.forEach((_, i) => adbDel(audioKey(pack.id, i)).catch(() => {}));
      packs = packs.filter((p) => p.id !== pack.id);
      savePacks();
      renderPacks();
    };
    actions.append(resetBtn, delBtn);
    if (useAzure()) {
      const audioBtn = document.createElement('button');
      audioBtn.className = 'sub-btn';
      audioBtn.textContent = pack.audioReady ? '🔊 音声を更新' : '🔊 音声を作成';
      audioBtn.onclick = () => renderPackAudio(pack, audioBtn);
      actions.appendChild(audioBtn);
    }
    body.appendChild(actions);
    det.appendChild(body);
    wrap.appendChild(det);
  }
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
  stopPack(true);
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
    stopPack(true); // 再生中のガイド・ラジオの続行も止める
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
$('btn-packs').addEventListener('click', () => { renderPacks(); openPanel('panel-packs'); });

// パック生成フォーム
$('gen-type').addEventListener('change', () => {
  const isGuide = $('gen-type').value === 'guide';
  $('gen-geo-row').style.display = isGuide ? '' : 'none';
  $('gen-title-label').textContent = isGuide ? '目的地・タイトル' : 'テーマ・番組名';
  $('gen-title').placeholder = isGuide ? '例: 四国カルスト' : '例: 日本の峠と酷道の雑学';
  $('gen-memo-label').textContent = isGuide ? 'ルート・日程・こだわり(自由記入)' : '聴きたい内容(自由記入)';
});
$('btn-generate').addEventListener('click', generatePack);

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

  // 音声エンジン(端末標準 / Microsoft Azure)
  const refreshTtsRows = () => {
    const az = $('set-tts-engine').value === 'azure';
    $('azure-rows').classList.toggle('hidden', !az);
    $('row-device-voice').style.display = az ? 'none' : '';
  };
  $('set-tts-engine').value = settings.ttsEngine;
  $('set-azure-key').value = settings.azureKey;
  $('set-azure-region').value = settings.azureRegion;
  $('set-azure-voice').value = settings.azureVoice;
  refreshTtsRows();
  $('set-tts-engine').addEventListener('change', (e) => {
    settings.ttsEngine = e.target.value;
    store.set('ttsEngine', settings.ttsEngine);
    refreshTtsRows();
    renderPacks(); // 「音声を作成」ボタンの表示を更新
  });
  $('set-azure-key').addEventListener('change', (e) => { settings.azureKey = e.target.value.trim(); store.set('azureKey', settings.azureKey); renderPacks(); });
  $('set-azure-region').addEventListener('change', (e) => { settings.azureRegion = e.target.value; store.set('azureRegion', settings.azureRegion); });
  $('set-azure-voice').addEventListener('change', (e) => { settings.azureVoice = e.target.value; store.set('azureVoice', settings.azureVoice); });

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
// 同梱サンプルパックの初回取り込み
if (!store.get('samplesImported', false) && typeof SAMPLE_PACKS !== 'undefined') {
  const copies = JSON.parse(JSON.stringify(SAMPLE_PACKS));
  copies.forEach((p) => {
    p.createdAt = Date.now();
    p.tracks.forEach((t) => { t.played = false; });
  });
  packs.push(...copies);
  store.set('samplesImported', true);
  savePacks();
}

initSettingsUI();
refreshModeIndicator();
renderMemos();
renderPacks();
setState('idle');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
