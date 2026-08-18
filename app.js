/* 宅建一問一答 — SM-2ベースの間隔反復(SRS)アプリ */
"use strict";

const STORE_KEY = "takken1q_v1";
const MASTER_IV = 21; // この間隔(日)以上で「習得済み」扱い

// ---------- 永続化 ----------
function defaultStore() {
  return {
    cards: {},              // id -> {iv, ease, due, reps, lapses, state, c, w}
    log: {},                // "YYYY-MM-DD" -> {n, r, c, w}
    custom: [],             // ユーザー追加問題
    settings: { newPerDay: 20, cats: ["gyo", "ken", "hor", "zei"], mode: "auto" },
  };
}
let store = load();
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultStore();
    const s = JSON.parse(raw);
    return Object.assign(defaultStore(), s, {
      settings: Object.assign(defaultStore().settings, s.settings || {}),
    });
  } catch (e) {
    return defaultStore();
  }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
  catch (e) { toast("保存に失敗しました（容量不足の可能性）"); }
}

// ---------- 日付 ----------
function todayStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 問題 ----------
function allQuestions() {
  return QUESTIONS.concat(store.custom);
}
function questionById(id) {
  return allQuestions().find((q) => q.id === id);
}
function catLabel(code) { return CATEGORIES[code] || code; }

// ---------- SRSコア (SM-2変形 / Ankiと同系) ----------
function getCard(id) {
  if (!store.cards[id]) {
    store.cards[id] = { iv: 0, ease: 2.5, due: null, reps: 0, lapses: 0, state: "new", c: 0, w: 0 };
  }
  return store.cards[id];
}
function previewIv(card, grade) {
  const ease = card.ease;
  const learning = card.state !== "review" || card.iv < 1;
  let iv;
  if (grade === "hard") iv = learning ? 1 : Math.max(card.iv + 1, Math.round(card.iv * 1.2));
  else if (grade === "good") iv = learning ? 1 : Math.round(card.iv * ease);
  else if (grade === "easy") iv = learning ? 4 : Math.round(card.iv * ease * 1.3);
  else return 0;
  return Math.min(Math.max(iv, 1), 365);
}
function rateCard(id, grade) {
  const card = getCard(id);
  if (grade === "again") {
    card.ease = Math.max(1.3, card.ease - 0.2);
    if (card.state === "review") card.lapses++;
    card.state = "learning";
    card.iv = 0;
    card.due = todayStr(); // 同日中に再出題
    return;
  }
  if (grade === "hard") card.ease = Math.max(1.3, card.ease - 0.15);
  if (grade === "easy") card.ease = Math.min(3.0, card.ease + 0.15);
  card.iv = previewIv(card, grade);
  card.state = "review";
  card.reps++;
  card.due = todayStr(card.iv);
}
function fmtIv(days) {
  if (days < 1) return "10分後";
  if (days < 30) return `${days}日後`;
  if (days < 360) return `${(days / 30).toFixed(1).replace(/\.0$/, "")}か月後`;
  return "1年後";
}

// ---------- キュー計算 ----------
function activeCats() { return store.settings.cats; }
function inActiveCat(q) { return activeCats().includes(q.cat); }
function dueList() {
  const t = todayStr();
  return allQuestions().filter((q) => {
    if (!inActiveCat(q)) return false;
    const c = store.cards[q.id];
    return c && c.state !== "new" && c.due && c.due <= t;
  });
}
function newList() {
  return allQuestions().filter((q) => {
    if (!inActiveCat(q)) return false;
    const c = store.cards[q.id];
    return !c || c.state === "new";
  });
}
function todayLog() {
  const t = todayStr();
  if (!store.log[t]) store.log[t] = { n: 0, r: 0, c: 0, w: 0 };
  return store.log[t];
}
function newRemainingToday() {
  return Math.max(0, store.settings.newPerDay - todayLog().n);
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- セッション ----------
let session = null; // {queue: [ids], total, correct, wrong, current, answered}

function buildSession(extra = false) {
  const due = shuffle(dueList().map((q) => q.id));
  let news = shuffle(newList().map((q) => q.id));
  if (extra) {
    news = news.slice(0, 10);
    if (news.length === 0) {
      // 新規が尽きていれば、期日が近い復習カードを前倒しで10問
      const t = todayStr();
      const ahead = allQuestions()
        .filter((q) => inActiveCat(q) && store.cards[q.id] && store.cards[q.id].due > t)
        .sort((a, b) => (store.cards[a.id].due < store.cards[b.id].due ? -1 : 1))
        .slice(0, 10)
        .map((q) => q.id);
      news = ahead;
    }
  } else {
    news = news.slice(0, newRemainingToday());
  }
  const queue = shuffle(due.concat(news));
  if (queue.length === 0) return null;
  return { queue, total: queue.length, correct: 0, wrong: 0, current: null, answered: false, seen: new Set() };
}

// ---------- UI: ビュー切替 ----------
const views = ["home", "study", "done", "stats", "settings"];
function show(view) {
  views.forEach((v) => document.getElementById("view-" + v).classList.toggle("active", v === view));
  document.body.classList.toggle("studying", view === "study" || view === "done");
  document.querySelectorAll("nav button").forEach((b) =>
    b.classList.toggle("on", b.dataset.nav === view)
  );
  if (view === "home") renderHome();
  if (view === "stats") renderStats();
  if (view === "settings") renderSettings();
}
document.querySelectorAll("nav button").forEach((b) => {
  b.addEventListener("click", () => show(b.dataset.nav));
});

// ---------- UI: ホーム ----------
function renderHome() {
  const due = dueList().length;
  const newAvail = Math.min(newList().length, newRemainingToday());
  const log = todayLog();
  document.getElementById("dueNum").textContent = due;
  document.getElementById("newNum").textContent = newAvail;
  document.getElementById("doneNum").textContent = log.n + log.r;
  document.getElementById("homeDate").textContent = new Date().toLocaleDateString("ja-JP", {
    year: "numeric", month: "long", day: "numeric", weekday: "short",
  });
  const startBtn = document.getElementById("startBtn");
  const extraBtn = document.getElementById("extraBtn");
  if (due + newAvail === 0) {
    startBtn.textContent = "今日の学習は完了 🎉";
    startBtn.disabled = true;
    extraBtn.style.display = "block";
  } else {
    startBtn.textContent = `学習を始める（${due + newAvail}問）`;
    startBtn.disabled = false;
    extraBtn.style.display = "none";
  }
  document.getElementById("streakTxt").textContent = streakText();
  renderCatChips();
}
function streakText() {
  let n = 0;
  let day = todayStr();
  const hasToday = store.log[day] && (store.log[day].n + store.log[day].r) > 0;
  for (let i = hasToday ? 0 : 1; ; i++) {
    const d = todayStr(-i);
    if (store.log[d] && (store.log[d].n + store.log[d].r) > 0) n++;
    else break;
  }
  if (n === 0) return "今日から学習をはじめましょう。";
  return `🔥 ${n}日連続で学習中です。この調子！`;
}
function renderCatChips() {
  const wrap = document.getElementById("catChips");
  wrap.innerHTML = "";
  const t = todayStr();
  Object.keys(CATEGORIES).forEach((code) => {
    const total = allQuestions().filter((q) => q.cat === code).length;
    const due = allQuestions().filter((q) => {
      const c = store.cards[q.id];
      return q.cat === code && c && c.state !== "new" && c.due && c.due <= t;
    }).length;
    const btn = document.createElement("button");
    btn.className = "chip" + (activeCats().includes(code) ? " on" : "");
    btn.innerHTML = `${catLabel(code)}<span class="cnt">${due > 0 ? "復習" + due : total + "問"}</span>`;
    btn.addEventListener("click", () => {
      const cats = activeCats();
      if (cats.includes(code)) {
        if (cats.length === 1) { toast("最低1つの分野を選んでください"); return; }
        store.settings.cats = cats.filter((c) => c !== code);
      } else {
        store.settings.cats = cats.concat(code);
      }
      save();
      renderHome();
    });
    wrap.appendChild(btn);
  });
}

// ---------- UI: 学習 ----------
document.getElementById("startBtn").addEventListener("click", () => startStudy(false));
document.getElementById("extraBtn").addEventListener("click", () => startStudy(true));
document.getElementById("quitBtn").addEventListener("click", () => {
  if (session && session.queue.length > 0) {
    if (!confirm("学習を中断しますか？（ここまでの結果は保存されています）")) return;
  }
  session = null;
  show("home");
});
function startStudy(extra) {
  session = buildSession(extra);
  if (!session) { toast("出題できる問題がありません"); return; }
  show("study");
  nextQuestion();
}
function nextQuestion() {
  if (!session || session.queue.length === 0) { finishSession(); return; }
  session.current = session.queue.shift();
  session.answered = false;
  const q = questionById(session.current);
  const card = store.cards[q.id];
  document.getElementById("qCat").textContent = catLabel(q.cat);
  document.getElementById("qNew").style.display = (!card || card.state === "new") ? "" : "none";
  document.getElementById("qText").textContent = q.q;
  document.getElementById("oxRow").style.display = "";
  document.getElementById("answerArea").style.display = "none";
  const done = session.total - session.queue.length - 1;
  document.getElementById("progFill").style.width = `${(done / session.total) * 100}%`;
  document.getElementById("remainTxt").textContent = `残り ${session.queue.length + 1}`;
}
document.getElementById("btnO").addEventListener("click", () => answer(true));
document.getElementById("btnX").addEventListener("click", () => answer(false));

function answer(pick) {
  if (!session || session.answered) return;
  session.answered = true;
  const q = questionById(session.current);
  const card = getCard(q.id);
  const wasNew = card.state === "new";
  const correct = pick === q.a;
  const firstSeen = !session.seen.has(q.id);
  session.seen.add(q.id);

  // 集計（同一セッション内の再出題は集計に含めない）
  if (firstSeen) {
    if (correct) session.correct++; else session.wrong++;
    const log = todayLog();
    if (wasNew) log.n++; else log.r++;
    if (correct) log.c++; else log.w++;
  }
  if (correct) card.c++; else card.w++;

  // 結果表示
  const banner = document.getElementById("resultBanner");
  banner.className = "result " + (correct ? "ok" : "ng");
  banner.querySelector(".ic").textContent = correct ? "✓" : "✗";
  banner.querySelector(".txt").textContent = correct
    ? `正解！ 答えは「${q.a ? "○" : "×"}」`
    : `不正解… 答えは「${q.a ? "○" : "×"}」`;
  document.getElementById("expText").textContent = q.e;
  document.getElementById("oxRow").style.display = "none";
  document.getElementById("answerArea").style.display = "";

  // 評価ボタン
  const row = document.getElementById("rateRow");
  row.innerHTML = "";
  if (correct) {
    addRateBtn(row, "btn-hard", "難しい", fmtIv(previewIv(card, "hard")), () => grade("hard"));
    addRateBtn(row, "btn-good", "普通", fmtIv(previewIv(card, "good")), () => grade("good"));
    addRateBtn(row, "btn-easy", "簡単", fmtIv(previewIv(card, "easy")), () => grade("easy"));
  } else {
    addRateBtn(row, "btn-good", "次へ", "この後もう一度出題", () => grade("again"));
  }
  save();
}
function addRateBtn(row, cls, label, sub, fn) {
  const b = document.createElement("button");
  b.className = "btn " + cls;
  b.innerHTML = `${label}<span class="iv">${sub}</span>`;
  b.addEventListener("click", fn);
  row.appendChild(b);
}
function grade(g) {
  rateCard(session.current, g);
  if (g === "again") {
    // セッション内で数問後に再出題
    const pos = Math.min(session.queue.length, 3 + Math.floor(Math.random() * 3));
    session.queue.splice(pos, 0, session.current);
    session.total++; // 進捗バー整合のため
  }
  save();
  nextQuestion();
}
function finishSession() {
  const s = session;
  session = null;
  const total = s.correct + s.wrong;
  document.getElementById("doneCorrect").textContent = s.correct;
  document.getElementById("doneWrong").textContent = s.wrong;
  document.getElementById("doneAcc").textContent = total ? Math.round((s.correct / total) * 100) + "%" : "-";
  document.getElementById("doneSummary").textContent = `${total}問を学習しました。間違えた問題は忘却曲線に合わせて早めに再出題されます。`;
  show("done");
}
document.getElementById("doneHomeBtn").addEventListener("click", () => show("home"));

// ---------- UI: 統計 ----------
function renderStats() {
  const qs = allQuestions();
  const learned = qs.filter((q) => store.cards[q.id] && store.cards[q.id].state !== "new");
  const mastered = qs.filter((q) => store.cards[q.id] && store.cards[q.id].iv >= MASTER_IV);
  document.getElementById("stTotal").textContent = qs.length;
  document.getElementById("stLearned").textContent = learned.length;
  document.getElementById("stMastered").textContent = mastered.length;

  // 分野別
  const bars = document.getElementById("catBars");
  bars.innerHTML = "";
  Object.keys(CATEGORIES).forEach((code) => {
    const catQs = qs.filter((q) => q.cat === code);
    if (catQs.length === 0) return;
    const catLearned = catQs.filter((q) => store.cards[q.id] && store.cards[q.id].state !== "new").length;
    let c = 0, w = 0;
    catQs.forEach((q) => {
      const card = store.cards[q.id];
      if (card) { c += card.c; w += card.w; }
    });
    const acc = c + w > 0 ? Math.round((c / (c + w)) * 100) + "%" : "—";
    const pct = Math.round((catLearned / catQs.length) * 100);
    const div = document.createElement("div");
    div.className = "bar-row";
    div.innerHTML = `
      <div class="bar-head"><b>${catLabel(code)}</b><span class="muted">${catLearned}/${catQs.length}問 ・ 正答率 ${acc}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>`;
    bars.appendChild(div);
  });

  // 復習予定（7日分）
  const ft = document.getElementById("forecastTable");
  ft.innerHTML = "";
  const labels = ["今日", "明日"];
  for (let i = 0; i < 7; i++) {
    const d = todayStr(i);
    const n = qs.filter((q) => {
      const card = store.cards[q.id];
      if (!card || card.state === "new" || !card.due) return false;
      return i === 0 ? card.due <= d : card.due === d;
    }).length;
    const label = labels[i] || new Date(Date.now() + i * 864e5).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", weekday: "short" });
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${label}</td><td>${n > 0 ? n + "問" : "—"}</td>`;
    ft.appendChild(tr);
  }

  // 直近の学習記録
  const rt = document.getElementById("recordTable");
  rt.innerHTML = "";
  const days = Object.keys(store.log).sort().reverse().slice(0, 10);
  if (days.length === 0) {
    rt.innerHTML = `<tr><td class="muted">まだ学習記録がありません</td><td></td></tr>`;
  }
  days.forEach((d) => {
    const l = store.log[d];
    const total = l.c + l.w;
    const acc = total ? Math.round((l.c / total) * 100) + "%" : "—";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${d.slice(5).replace("-", "/")}</td><td>${l.n + l.r}問 ・ 正答率 ${acc}</td>`;
    rt.appendChild(tr);
  });
}

// ---------- UI: 設定 ----------
function renderSettings() {
  document.getElementById("newPerDaySel").value = String(store.settings.newPerDay);
  document.getElementById("customCount").textContent =
    store.custom.length > 0 ? `追加済みの問題：${store.custom.length}問` : "";
}
document.getElementById("newPerDaySel").addEventListener("change", (e) => {
  store.settings.newPerDay = parseInt(e.target.value, 10);
  save();
  toast("設定を保存しました");
});

// 問題インポート
const CAT_ALIAS = {
  "宅建業法": "gyo", "業法": "gyo", "gyo": "gyo",
  "権利関係": "ken", "民法": "ken", "ken": "ken",
  "法令上の制限": "hor", "法令": "hor", "hor": "hor",
  "税・その他": "zei", "税その他": "zei", "税": "zei", "その他": "zei", "zei": "zei",
};
// テキスト形式（Q./A.形式）のパース
const Q_START = /^(?:[QqＱ][.．:：、]?|問\s*[0-9０-９]+[.．:：、)）]?)\s*/;
const A_LINE = /^[AaＡ][.．:：、]?\s*([○〇◯●xX×✕])\s*(.*)$/;
function parseTextQuestions(raw) {
  const items = [];
  let cur = null; // {qLines: [], aMark: null, eLines: []}
  const push = () => {
    if (!cur) return;
    const q = cur.qLines.join("").trim();
    if (q && cur.aMark !== null) {
      items.push({ q, a: cur.aMark, e: cur.eLines.join("").trim() });
    }
    cur = null;
  };
  raw.split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t) return;
    if (Q_START.test(t)) {
      push();
      cur = { qLines: [t.replace(Q_START, "")], aMark: null, eLines: [] };
      return;
    }
    if (!cur) return; // 最初のQより前の行は無視
    const m = t.match(A_LINE);
    if (m && cur.aMark === null) {
      cur.aMark = "○〇◯●".includes(m[1]);
      if (m[2]) cur.eLines.push(m[2]);
      return;
    }
    if (cur.aMark === null) cur.qLines.push(t);
    else cur.eLines.push(t);
  });
  push();
  return items;
}
function addQuestions(arr, fallbackCat) {
  let added = 0, skipped = 0;
  let maxN = store.custom.reduce((m, q) => Math.max(m, parseInt(String(q.id).slice(1), 10) || 0), 0);
  arr.forEach((item) => {
    if (!item || typeof item.q !== "string" || typeof item.a !== "boolean") { skipped++; return; }
    const cat = CAT_ALIAS[item.cat] || fallbackCat || "zei";
    // 同一問題文の重複はスキップ
    if (allQuestions().some((q) => q.q === item.q)) { skipped++; return; }
    maxN++;
    store.custom.push({ id: "u" + maxN, cat, a: item.a, q: item.q, e: item.exp || item.e || "" });
    added++;
  });
  return { added, skipped };
}
document.getElementById("importBtn").addEventListener("click", () => {
  const raw = document.getElementById("importArea").value.trim();
  if (!raw) { toast("テキストまたはJSONを貼り付けてください"); return; }
  const fallbackCat = document.getElementById("importCatSel").value;
  let arr;
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try { arr = JSON.parse(raw); } catch (e) { toast("JSONの形式が正しくありません"); return; }
    if (!Array.isArray(arr)) { toast("配列 [ ... ] 形式で貼り付けてください"); return; }
  } else {
    arr = parseTextQuestions(raw);
    if (arr.length === 0) {
      toast("問題を認識できませんでした。「Q. 問題文」「A. ○ 解説」の形式をご確認ください");
      return;
    }
  }
  const { added, skipped } = addQuestions(arr, fallbackCat);
  save();
  document.getElementById("importArea").value = "";
  renderSettings();
  toast(`${added}問を追加しました${skipped ? `（${skipped}件スキップ）` : ""}`);
});

// バックアップ
document.getElementById("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(store)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `takken-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("バックアップを書き出しました");
});
document.getElementById("restoreBtn").addEventListener("click", () => {
  document.getElementById("restoreFile").click();
});
document.getElementById("restoreFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const s = JSON.parse(reader.result);
      if (!s.cards || !s.settings) throw new Error("bad");
      store = Object.assign(defaultStore(), s);
      save();
      renderHome();
      toast("バックアップを読み込みました");
    } catch (err) {
      toast("読み込みに失敗しました");
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});
document.getElementById("resetBtn").addEventListener("click", () => {
  if (!confirm("学習履歴をすべて削除します。よろしいですか？\n（追加した問題は残ります）")) return;
  store.cards = {};
  store.log = {};
  save();
  show("home");
  toast("学習履歴をリセットしました");
});

// ---------- ダーク/ライト切替 ----------
const modeBtn = document.getElementById("modeBtn");
function applyMode() {
  const m = store.settings.mode;
  const dark = m === "dark" || (m === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.mode = dark ? "dark" : "light";
  modeBtn.textContent = dark ? "☀️" : "🌙";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? "#12141c" : "#4338ca";
}
modeBtn.addEventListener("click", () => {
  const dark = document.documentElement.dataset.mode === "dark";
  store.settings.mode = dark ? "light" : "dark";
  save();
  applyMode();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyMode);

// ---------- トースト ----------
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

// ---------- 起動 ----------
applyMode();
renderHome();
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
