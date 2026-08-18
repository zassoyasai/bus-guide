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

// ---------- 画像ストレージ (IndexedDB) ----------
let idbPromise = null;
function idbOpen() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((res, rej) => {
    const r = indexedDB.open("takken1q_img", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("imgs");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return idbPromise;
}
function idbPut(key, val) {
  return idbOpen().then((db) => new Promise((res, rej) => {
    const tx = db.transaction("imgs", "readwrite");
    tx.objectStore("imgs").put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}
function idbGet(key) {
  return idbOpen().then((db) => new Promise((res, rej) => {
    const req = db.transaction("imgs").objectStore("imgs").get(key);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(req.error);
  }));
}
function idbDel(key) {
  return idbOpen().then((db) => new Promise((res, rej) => {
    const tx = db.transaction("imgs", "readwrite");
    tx.objectStore("imgs").delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}
function idbClear() {
  return idbOpen().then((db) => new Promise((res, rej) => {
    const tx = db.transaction("imgs", "readwrite");
    tx.objectStore("imgs").clear();
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}
async function showStoredImg(key, el) {
  el.removeAttribute("src");
  try {
    const blob = await idbGet(key);
    if (!blob) throw new Error("missing");
    const url = URL.createObjectURL(blob);
    el.onload = () => URL.revokeObjectURL(url);
    el.src = url;
  } catch (e) {
    el.alt = "画像が見つかりません（画像カードはバックアップに含まれません）";
  }
}
function isImgCard(q) { return q && q.type === "img"; }
function nextImgId() {
  store.imgSeq = (store.imgSeq || 0) + 1;
  return "i" + store.imgSeq;
}
// 画像内容のフィンガープリント（重複検出用）
async function blobHash(blob) {
  try {
    const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(d).slice(0, 12)).map((x) => x.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    // 非セキュアコンテキスト用フォールバック（FNV-1a・先頭16KB＋サイズ）
    const buf = new Uint8Array(await blob.slice(0, 16384).arrayBuffer());
    let hv = 0x811c9dc5;
    for (let i = 0; i < buf.length; i++) { hv ^= buf[i]; hv = Math.imul(hv, 0x01000193); }
    return "f" + (hv >>> 0).toString(16) + "-" + blob.size;
  }
}
async function pairHash(qBlob, aBlob) {
  return (await blobHash(qBlob)) + ":" + (await blobHash(aBlob));
}
// 追加。戻り値: "added"=新規追加 / "recat"=既存カードの分野を修正 / "dup"=完全な重複でスキップ
async function addImgCard(cat, qBlob, aBlob) {
  const h = await pairHash(qBlob, aBlob);
  const existing = store.custom.find((c) => c.type === "img" && c.h === h);
  if (existing) {
    if (existing.cat !== cat) {
      existing.cat = cat;
      save();
      return "recat";
    }
    return "dup";
  }
  const id = nextImgId();
  await Promise.all([idbPut(id + "_q", qBlob), idbPut(id + "_a", aBlob)]);
  store.custom.push({ id, cat, type: "img", a: true, q: "（画像カード " + id + "）", e: "", h });
  save();
  return "added";
}
// カード削除（画像カード・追加問題共通）
async function deleteCard(id) {
  const q = store.custom.find((c) => c.id === id);
  store.custom = store.custom.filter((c) => c.id !== id);
  delete store.cards[id];
  save();
  if (q && q.type === "img") {
    try { await idbDel(id + "_q"); await idbDel(id + "_a"); } catch (e) {}
  }
}
// 重複画像カードの一括削除（学習の進んでいる方を残す）
async function dedupeImgCards(progress) {
  const cards = imgCards();
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    if (!c.h) {
      const [q, a] = await Promise.all([idbGet(c.id + "_q"), idbGet(c.id + "_a")]);
      c.h = (q && a) ? await pairHash(q, a) : "missing:" + c.id;
    }
    if (progress && (i + 1) % 200 === 0) progress(i + 1, cards.length);
  }
  const score = (c) => {
    const s = store.cards[c.id];
    return s ? s.reps * 10 + s.c + s.w : 0;
  };
  const keep = new Map();
  const toDelete = [];
  for (const c of cards) {
    const prev = keep.get(c.h);
    if (!prev) { keep.set(c.h, c); continue; }
    if (score(c) > score(prev)) { toDelete.push(prev); keep.set(c.h, c); }
    else toDelete.push(c);
  }
  for (const c of toDelete) await deleteCard(c.id);
  save();
  return toDelete.length;
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
const views = ["home", "study", "done", "crop", "stats", "settings"];
function show(view) {
  views.forEach((v) => document.getElementById("view-" + v).classList.toggle("active", v === view));
  document.body.classList.toggle("studying", view === "study" || view === "done" || view === "crop");
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
  if (allQuestions().length === 0) {
    startBtn.textContent = "問題を取り込んで始める（設定へ）";
    startBtn.disabled = false;
    startBtn.dataset.mode = "import";
    extraBtn.style.display = "none";
    document.getElementById("streakTxt").textContent = "設定画面のインポート機能で問題を追加してください。";
    renderCatChips();
    return;
  }
  startBtn.dataset.mode = "";
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
document.getElementById("startBtn").addEventListener("click", (e) => {
  if (e.currentTarget.dataset.mode === "import") { show("settings"); return; }
  startStudy(false);
});
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
  const img = isImgCard(q);
  document.getElementById("qCat").textContent = catLabel(q.cat);
  document.getElementById("qNew").style.display = (!card || card.state === "new") ? "" : "none";
  document.getElementById("qText").style.display = img ? "none" : "";
  document.getElementById("qText").textContent = img ? "" : q.q;
  const qImg = document.getElementById("qImg");
  qImg.style.display = img ? "" : "none";
  if (img) showStoredImg(q.id + "_q", qImg);
  document.getElementById("oxRow").style.display = img ? "none" : "";
  document.getElementById("revealRow").style.display = img ? "" : "none";
  document.getElementById("answerArea").style.display = "none";
  const done = session.total - session.queue.length - 1;
  document.getElementById("progFill").style.width = `${(done / session.total) * 100}%`;
  document.getElementById("remainTxt").textContent = `残り ${session.queue.length + 1}`;
}
document.getElementById("btnO").addEventListener("click", () => answer(true));
document.getElementById("btnX").addEventListener("click", () => answer(false));

// 画像カード：答えを表示 → 自己評価（Anki方式）
document.getElementById("revealBtn").addEventListener("click", () => {
  if (!session || session.answered) return;
  session.answered = true;
  const q = questionById(session.current);
  const card = getCard(q.id);
  document.getElementById("resultBanner").style.display = "none";
  document.getElementById("expLabel").textContent = "解答";
  document.getElementById("expText").style.display = "none";
  const aImg = document.getElementById("aImg");
  aImg.style.display = "";
  showStoredImg(q.id + "_a", aImg);
  document.getElementById("revealRow").style.display = "none";
  document.getElementById("answerArea").style.display = "";
  const row = document.getElementById("rateRow");
  row.innerHTML = "";
  addRateBtn(row, "btn-hard", "もう一度", "この後再出題", () => gradeSelf(false, "again"));
  addRateBtn(row, "btn-hard", "難しい", fmtIv(previewIv(card, "hard")), () => gradeSelf(true, "hard"));
  addRateBtn(row, "btn-good", "普通", fmtIv(previewIv(card, "good")), () => gradeSelf(true, "good"));
  addRateBtn(row, "btn-easy", "簡単", fmtIv(previewIv(card, "easy")), () => gradeSelf(true, "easy"));
});
function gradeSelf(correct, g) {
  const q = questionById(session.current);
  const card = getCard(q.id);
  const wasNew = card.state === "new" && card.reps === 0;
  const firstSeen = !session.seen.has(q.id);
  session.seen.add(q.id);
  if (firstSeen) {
    if (correct) session.correct++; else session.wrong++;
    const log = todayLog();
    if (wasNew) log.n++; else log.r++;
    if (correct) log.c++; else log.w++;
  }
  if (correct) card.c++; else card.w++;
  grade(g);
}

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

  // 結果表示（画像カード表示後の状態をリセット）
  const banner = document.getElementById("resultBanner");
  banner.style.display = "";
  document.getElementById("expLabel").textContent = "解説";
  document.getElementById("expText").style.display = "";
  document.getElementById("aImg").style.display = "none";
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
  const textCount = store.custom.filter((q) => q.type !== "img").length;
  document.getElementById("customCount").textContent =
    textCount > 0 ? `追加済みの問題：${textCount}問` : "";
  const nImg = imgCards().length;
  document.getElementById("imgCount").textContent = nImg > 0 ? `追加済みの画像カード：${nImg}枚` : "";
  document.getElementById("imgDeleteBtn").style.display = nImg > 0 ? "" : "none";
  document.getElementById("imgDedupBtn").style.display = nImg > 0 ? "" : "none";
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

// ---------- 画像カード ----------
function imgCards() { return store.custom.filter((q) => q.type === "img"); }

// ペア追加（ファイル名順に 問題→解答 の2枚組）
document.getElementById("pairAddBtn").addEventListener("click", () => document.getElementById("pairFiles").click());
document.getElementById("pairFiles").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files).sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  e.target.value = "";
  if (files.length === 0) return;
  if (files.length % 2 !== 0) {
    toast(`画像が${files.length}枚（奇数）です。問題→解答の2枚1組になるよう選択してください`);
    return;
  }
  const cat = document.getElementById("imgCatSel").value;
  try {
    let added = 0, dup = 0, recat = 0;
    for (let i = 0; i < files.length; i += 2) {
      const r = await addImgCard(cat, files[i], files[i + 1]);
      if (r === "added") added++; else if (r === "recat") recat++; else dup++;
    }
    renderSettings();
    const parts = [`${added}枚追加`];
    if (recat) parts.push(`${recat}枚の分野を「${catLabel(cat)}」に修正`);
    if (dup) parts.push(`重複${dup}枚スキップ`);
    toast(`画像カード：${parts.join("・")}`);
  } catch (err) {
    toast("画像の保存に失敗しました（端末の空き容量をご確認ください）");
  }
});

// ZIP一括追加（無圧縮/deflate対応の最小ZIPリーダー）
async function readZipImages(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP形式を認識できません");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error("ZIPの読み取りに失敗しました");
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, method, csize, lho });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const out = [];
  for (const e of entries) {
    if (e.name.endsWith("/") || !/\.(jpe?g|png|webp|gif)$/i.test(e.name)) continue;
    const nl = dv.getUint16(e.lho + 26, true);
    const el = dv.getUint16(e.lho + 28, true);
    const start = e.lho + 30 + nl + el;
    const data = buf.subarray(start, start + e.csize);
    let blob;
    if (e.method === 0) {
      blob = new Blob([data], { type: "image/jpeg" });
    } else if (e.method === 8 && typeof DecompressionStream !== "undefined") {
      blob = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
    } else {
      continue;
    }
    out.push({ name: e.name.split("/").pop(), blob });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  return out;
}
document.getElementById("zipAddBtn").addEventListener("click", () => document.getElementById("zipFile").click());
document.getElementById("zipFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const cat = document.getElementById("imgCatSel").value;
  toast("ZIPを読み込んでいます…");
  try {
    const imgs = await readZipImages(file);
    if (imgs.length === 0) { toast("ZIP内に画像が見つかりませんでした"); return; }
    if (imgs.length % 2 !== 0) { toast(`画像が${imgs.length}枚（奇数）のため取り込めません`); return; }
    let added = 0, dup = 0, recat = 0;
    for (let i = 0; i < imgs.length; i += 2) {
      const r = await addImgCard(cat, imgs[i].blob, imgs[i + 1].blob);
      if (r === "added") added++; else if (r === "recat") recat++; else dup++;
      if ((i / 2 + 1) % 100 === 0) toast(`取り込み中… ${i / 2 + 1}/${imgs.length / 2}枚`);
    }
    renderSettings();
    renderHome();
    const parts = [`${added}枚追加`];
    if (recat) parts.push(`${recat}枚の分野を「${catLabel(cat)}」に修正`);
    if (dup) parts.push(`重複${dup}枚スキップ`);
    toast(`画像カード：${parts.join("・")}`);
  } catch (err) {
    toast("取り込みに失敗しました：" + (err && err.message ? err.message : "不明なエラー"));
  }
});

// 重複カードの一括削除
document.getElementById("imgDedupBtn").addEventListener("click", async () => {
  if (!confirm("同じ内容の画像カードを検出し、重複分を削除します（学習が進んでいる方を残します）。実行しますか？")) return;
  toast("重複を確認しています…");
  try {
    const removed = await dedupeImgCards((done, total) => toast(`確認中… ${done}/${total}枚`));
    renderSettings();
    renderHome();
    toast(removed > 0 ? `重複カードを${removed}枚削除しました` : "重複はありませんでした");
  } catch (err) {
    toast("重複の確認に失敗しました");
  }
});

// 学習画面：現在のカードを削除
document.getElementById("delCardBtn").addEventListener("click", async () => {
  if (!session || !session.current) return;
  const q = questionById(session.current);
  if (!q || !store.custom.some((c) => c.id === q.id)) { toast("このカードは削除できません"); return; }
  if (!confirm("表示中のカードを削除しますか？（元に戻せません）")) return;
  const id = q.id;
  await deleteCard(id);
  session.queue = session.queue.filter((x) => x !== id);
  session.seen.delete(id);
  toast("カードを削除しました");
  nextQuestion();
});

// 全削除
document.getElementById("imgDeleteBtn").addEventListener("click", async () => {
  if (!confirm("画像カードとその学習履歴をすべて削除します。よろしいですか？")) return;
  imgCards().forEach((q) => { delete store.cards[q.id]; });
  store.custom = store.custom.filter((q) => q.type !== "img");
  save();
  try { await idbClear(); } catch (e) {}
  renderSettings();
  toast("画像カードを削除しました");
});

// ---------- 切り出しツール ----------
const crop = { img: null, pendingQ: null, expecting: "q", count: 0, rect: null, dragStart: null };
const cropCanvas = document.getElementById("cropCanvas");
const cropStage = document.getElementById("cropStage");
const cropRectEl = document.getElementById("cropRect");

document.getElementById("cropStartBtn").addEventListener("click", () => document.getElementById("cropFile").click());
document.getElementById("cropNextPageBtn").addEventListener("click", () => document.getElementById("cropFile").click());
document.getElementById("cropFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(url);
    crop.img = img;
    cropCanvas.width = img.naturalWidth;
    cropCanvas.height = img.naturalHeight;
    cropCanvas.getContext("2d").drawImage(img, 0, 0);
    resetCropSelection();
    if (!document.getElementById("view-crop").classList.contains("active")) {
      crop.count = 0;
      crop.expecting = "q";
      crop.pendingQ = null;
      show("crop");
    }
    updateCropUI();
  };
  img.onerror = () => toast("画像を読み込めませんでした");
  img.src = url;
});
function resetCropSelection() {
  crop.rect = null;
  crop.dragStart = null;
  cropRectEl.style.display = "none";
  document.getElementById("cropSaveBtn").disabled = true;
}
function updateCropUI() {
  const step = document.getElementById("cropStep");
  const save_ = document.getElementById("cropSaveBtn");
  if (crop.expecting === "q") {
    step.textContent = "① 問題の部分をドラッグでなぞる";
    save_.textContent = "問題として保存";
  } else {
    step.textContent = "② 解答・解説の部分をドラッグでなぞる";
    save_.textContent = "解答として保存（カード完成）";
  }
  document.getElementById("cropInfo").textContent =
    `このセッションで追加：${crop.count}枚 ・ 分野：${catLabel(document.getElementById("imgCatSel").value)}`;
}
function stagePos(ev) {
  const r = cropCanvas.getBoundingClientRect();
  const x = Math.min(Math.max(ev.clientX - r.left, 0), r.width);
  const y = Math.min(Math.max(ev.clientY - r.top, 0), r.height);
  return { x, y, w: r.width, h: r.height };
}
cropStage.addEventListener("pointerdown", (ev) => {
  if (!crop.img) return;
  ev.preventDefault();
  cropStage.setPointerCapture(ev.pointerId);
  crop.dragStart = stagePos(ev);
});
cropStage.addEventListener("pointermove", (ev) => {
  if (!crop.dragStart) return;
  const p = stagePos(ev);
  const x = Math.min(crop.dragStart.x, p.x), y = Math.min(crop.dragStart.y, p.y);
  const w = Math.abs(p.x - crop.dragStart.x), h = Math.abs(p.y - crop.dragStart.y);
  Object.assign(cropRectEl.style, { display: "block", left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
  crop.rect = { x, y, w, h, viewW: p.w, viewH: p.h };
});
cropStage.addEventListener("pointerup", () => {
  crop.dragStart = null;
  if (crop.rect && crop.rect.w > 12 && crop.rect.h > 12) {
    document.getElementById("cropSaveBtn").disabled = false;
  }
});
document.getElementById("cropRetryBtn").addEventListener("click", resetCropSelection);
document.getElementById("cropSaveBtn").addEventListener("click", () => {
  if (!crop.rect || !crop.img) return;
  const scaleX = cropCanvas.width / crop.rect.viewW;
  const scaleY = cropCanvas.height / crop.rect.viewH;
  const sx = crop.rect.x * scaleX, sy = crop.rect.y * scaleY;
  const sw = Math.max(1, crop.rect.w * scaleX), sh = Math.max(1, crop.rect.h * scaleY);
  const tmp = document.createElement("canvas");
  tmp.width = sw; tmp.height = sh;
  tmp.getContext("2d").drawImage(cropCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  tmp.toBlob(async (blob) => {
    if (!blob) { toast("切り出しに失敗しました"); return; }
    if (crop.expecting === "q") {
      crop.pendingQ = blob;
      crop.expecting = "a";
      resetCropSelection();
      updateCropUI();
    } else {
      try {
        const r = await addImgCard(document.getElementById("imgCatSel").value, crop.pendingQ, blob);
        crop.pendingQ = null;
        crop.expecting = "q";
        resetCropSelection();
        if (r === "added") {
          crop.count++;
          toast(`カードを追加しました（${crop.count}枚目）`);
        } else if (r === "recat") {
          toast("既存の同じカードの分野を修正しました");
        } else {
          toast("同じ内容のカードが既にあるためスキップしました");
        }
        updateCropUI();
      } catch (err) {
        toast("保存に失敗しました（端末の空き容量をご確認ください）");
      }
    }
  }, "image/jpeg", 0.88);
});
document.getElementById("cropQuit").addEventListener("click", () => {
  if (crop.expecting === "a" && !confirm("問題画像だけ切り出した途中のカードは破棄されます。終了しますか？")) return;
  crop.img = null;
  crop.pendingQ = null;
  crop.expecting = "q";
  show("settings");
  if (crop.count > 0) toast(`画像カードを合計${crop.count}枚追加しました`);
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
