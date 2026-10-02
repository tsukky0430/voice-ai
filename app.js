(() => {
  "use strict";

  // ===== 設定 =====
  const CONFIG = {
    name: "AI",          // AI の名前（決まったらここを変更）
    lang: "ja-JP",
    rate: 1.05,          // 読み上げ速度の初期値（設定画面で変更可）
    pitch: 1.0,          // 声の高さの初期値（設定画面で変更可）
    sendChars: 120000,   // 1回に Claude へ送る会話の上限（文字数。古いものから省く）
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    body: document.body, statusText: $("statusText"), aiName: $("aiName"),
    float: $("orbFloat"), halo: $("halo"), ring: $("ring"),
    you: $("youText"), ai: $("aiText"), captions: $("captions"),
    mic: $("micBtn"), handsfree: $("handsfreeBtn"), threadTitle: $("threadTitle"),
    form: $("textForm"), input: $("textInput"), toast: $("toast"),
  };
  els.aiName.textContent = CONFIG.name;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; }
      catch { toast("この端末の保存容量がいっぱいです。古い会話を削除してください。", 5000); return false; }
    },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // ===== 会話（スレッド）の保存 =====
  // 一覧: va.threads = [{ id, title, source: "app" | "claude" | "paste", updated }]
  // 本文: va.t.<id> = [{ role, content }]
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let threads = store.get("va.threads", []);
  let currentId = store.get("va.current", null);
  let history = [];

  function saveIndex() { store.set("va.threads", threads); store.set("va.current", currentId); }
  function currentThread() { return threads.find((t) => t.id === currentId); }

  function createThread({ title = "", source = "app", messages = [] } = {}) {
    const t = { id: newId(), title, source, updated: Date.now() };
    threads.unshift(t);
    store.set("va.t." + t.id, messages);
    currentId = t.id;
    history = messages;
    saveIndex();
    return t;
  }

  function openThread(id) {
    const t = threads.find((x) => x.id === id);
    if (!t) return;
    currentId = id;
    history = store.get("va.t." + id, []);
    saveIndex();
  }

  function deleteThread(id) {
    threads = threads.filter((t) => t.id !== id);
    store.del("va.t." + id);
    if (currentId === id) {
      if (threads[0]) openThread(threads[0].id);
      else createThread();
    }
    saveIndex();
  }

  // 旧バージョン（会話が1つだけ）の履歴を引き継ぐ
  (() => {
    const old = store.get("va.history", null);
    if (old && old.length && !threads.length) {
      const first = old.find((m) => m.role === "user");
      createThread({ title: first ? first.content.slice(0, 30) : "", messages: old });
    }
    if (old) store.del("va.history");
    if (currentId && threads.some((t) => t.id === currentId)) openThread(currentId);
    else if (threads[0]) openThread(threads[0].id);
    else createThread();
  })();

  // ===== 状態 =====
  const STATUS = { idle: "待機中", listening: "聞いています", thinking: "考えています", speaking: "話しています" };
  let state = "idle";
  let handsfree = false;
  let demoMode = new URLSearchParams(location.search).has("demo") || window.VA_DEMO === true;

  function setState(s) {
    state = s;
    els.body.dataset.state = s;
    els.statusText.textContent = STATUS[s] + (demoMode ? "（デモ）" : "");
  }
  setState("idle");

  let toastTimer;
  function toast(msg, ms = 3200) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), ms);
  }

  // ===== 背景の星 =====
  const canvas = $("stars");
  const ctx = canvas.getContext("2d");
  let stars = [];
  function resizeStars() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(Math.min(160, (innerWidth * innerHeight) / 7000));
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * innerWidth, y: Math.random() * innerHeight,
      r: Math.random() * 1.2 + 0.2, a: Math.random() * 0.6 + 0.15,
      tw: Math.random() * 0.002 + 0.0006, ph: Math.random() * 6.28,
      vy: -(Math.random() * 0.006 + 0.002),
    }));
  }
  addEventListener("resize", resizeStars);
  resizeStars();

  // ===== 球体アニメーション =====
  let level = 0, bump = 0, last = performance.now(), starTick = 0;

  function speakEnvelope(t) {
    // 読み上げ中の「声の抑揚」を擬似的に作る
    const n = Math.sin(t * 0.021) * Math.sin(t * 0.0137 + 1.3) + Math.sin(t * 0.0071 + 0.4) * 0.5;
    return 0.42 + Math.abs(n) * 0.45;
  }

  function frame(t) {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;


    let target = 0;
    if (state === "listening") target = 0.22 + 0.12 * Math.sin(t * 0.004) + bump;
    else if (state === "speaking") target = speakEnvelope(t) + bump;
    else if (state === "thinking") target = 0.3 + 0.15 * Math.sin(t * 0.009);
    else target = 0.06 + 0.04 * Math.sin(t * 0.0012);
    bump *= Math.pow(0.02, dt);
    level += (target - level) * Math.min(1, dt * 9);

    // 浮遊（画像は回転させず、ゆっくり上下にただよう）
    const fy = Math.sin(t * 0.0009) * 14 + Math.sin(t * 0.0021) * 3;
    const fx = Math.sin(t * 0.0005) * 4;
    els.float.style.transform = `translate3d(${fx}px, ${fy}px, 0)`;

    // 背後の光だけ、状態に合わせて強弱をつける
    els.halo.style.transform = `translate3d(${fx}px, ${fy}px, 0) scale(${1 + level * 0.2})`;
    els.halo.style.opacity = (0.5 + level * 0.5).toFixed(3);

    if (state === "listening") {
      const p = (t % 1700) / 1700;
      els.ring.style.transform = `translate3d(${fx}px, ${fy}px, 0) scale(${0.85 + p * 0.35})`;
      els.ring.style.borderColor = `rgba(140, 215, 255, ${((1 - p) * 0.55).toFixed(3)})`;
    } else {
      els.ring.style.borderColor = "rgba(140, 215, 255, 0)";
    }

    // 星（30fps 程度で十分）
    if (t - starTick > 33) {
      starTick = t;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const s of stars) {
        s.y += s.vy * 33;
        if (s.y < -2) { s.y = innerHeight + 2; s.x = Math.random() * innerWidth; }
        const a = s.a * (0.6 + 0.4 * Math.sin(t * s.tw + s.ph));
        ctx.fillStyle = `rgba(190, 215, 255, ${a.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill();
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ===== 音声合成（読み上げ） =====
  const synth = window.speechSynthesis;
  let voice = null;
  const settings = Object.assign(
    { voiceURI: "", rate: CONFIG.rate, pitch: CONFIG.pitch, model: "claude-sonnet-5-5", effort: "" },
    store.get("va.settings", {})
  );
  const FEMALE = /Kyoko|O-ren|Nanami|Haruka|Ayumi|Mizuki|Sayaka|Nana|Google 日本語|Shiori|Aoi|Mayu/i;
  const MALE = /Otoya|Hattori|Ichiro|Keita|Daichi|Naoki|Hiroshi/i;
  function jaVoices() {
    if (!synth) return [];
    const score = (v) =>
      (FEMALE.test(v.name) ? 10 : 0) - (MALE.test(v.name) ? 20 : 0) +
      (/Premium|Enhanced|Natural|Neural|Online|拡張/i.test(v.name) ? 5 : 0);
    return synth.getVoices().filter((v) => /^ja/i.test(v.lang)).sort((a, b) => score(b) - score(a));
  }
  function pickVoice() {
    const list = jaVoices();
    voice = list.find((v) => v.voiceURI === settings.voiceURI) || list[0] || null;
    if (typeof renderVoiceOptions === "function") renderVoiceOptions();
  }
  if (synth) { pickVoice(); synth.addEventListener?.("voiceschanged", pickVoice); }

  let pendingUtter = 0;
  let streamDone = true;
  let unlocked = false;

  function unlockAudio() {
    // iPhone などで、最初のタップ時に読み上げを有効化しておく
    if (unlocked || !synth) return;
    unlocked = true;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    synth.speak(u);
  }

  function cleanForSpeech(s) {
    return s
      .replace(/`([^`]+)`/g, "$1")
      .replace(/https?:\/\/\S+/g, "リンク")
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
      .replace(/[*_~#|]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function speak(text) {
    const clean = cleanForSpeech(text);
    if (!clean || !synth) return;
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = CONFIG.lang;
    if (voice) u.voice = voice;
    u.rate = settings.rate;
    u.pitch = settings.pitch;
    u.onstart = () => { if (state !== "listening") setState("speaking"); };
    u.onboundary = () => { bump = Math.min(0.35, bump + 0.12); };
    const done = () => {
      pendingUtter = Math.max(0, pendingUtter - 1);
      if (pendingUtter === 0 && streamDone) onReplyFinished();
    };
    u.onend = done;
    u.onerror = done;
    pendingUtter++;
    synth.speak(u);
  }

  function stopSpeaking() {
    pendingUtter = 0;
    if (synth) synth.cancel();
  }

  // ストリーミング中の文章を、文ごとに区切って読み上げる（コードブロックは読まない）
  const speech = { pos: 0, inCode: false, saidCode: false };
  function resetSpeech() { speech.pos = 0; speech.inCode = false; speech.saidCode = false; }

  function flushSpeech(full, final) {
    while (speech.pos < full.length) {
      const rest = full.slice(speech.pos);
      if (speech.inCode) {
        const end = rest.indexOf("```");
        if (end < 0) return;
        const nl = rest.indexOf("\n", end + 3);
        speech.pos += nl < 0 ? rest.length : nl + 1;
        speech.inCode = false;
        continue;
      }
      const fence = rest.indexOf("```");
      const m = rest.match(/[。！？!?\n]/);
      const sEnd = m ? m.index + 1 : -1;
      if (fence >= 0 && (sEnd < 0 || fence < sEnd)) {
        speak(rest.slice(0, fence));
        if (!speech.saidCode) { speak("コードは画面に表示しています。"); speech.saidCode = true; }
        speech.pos += fence + 3;
        speech.inCode = true;
        continue;
      }
      if (sEnd >= 0) {
        speak(rest.slice(0, sEnd));
        speech.pos += sEnd;
        continue;
      }
      if (rest.length > 120) {
        const c = rest.lastIndexOf("、", 120);
        const cut = c > 20 ? c + 1 : 120;
        speak(rest.slice(0, cut));
        speech.pos += cut;
        continue;
      }
      if (final) { speak(rest); speech.pos = full.length; }
      return;
    }
  }

  function onReplyFinished() {
    if (state === "listening") return;
    setState("idle");
    if (handsfree) setTimeout(() => { if (state === "idle" && handsfree) startListening(); }, 350);
  }

  // ===== 音声認識 =====
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;

  function startListening() {
    if (!SR) {
      toast("このブラウザは音声入力に未対応です。Chrome か Safari をお使いください。文字入力は使えます。", 5000);
      els.input.focus();
      return;
    }
    interrupt();
    if (rec) return;
    let finalText = "", interim = "", errored = false;
    rec = new SR();
    rec.lang = CONFIG.lang;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      els.you.textContent = finalText + interim;
      bump = Math.min(0.4, bump + 0.15);
    };
    rec.onerror = (e) => {
      errored = true;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        toast(demoMode
          ? "このプレビューではマイクが使えません。下の文字入力で試してください。"
          : "マイクの使用が許可されていません。ブラウザの設定で許可してください。", 5000);
        setHandsfree(false);
      } else if (e.error === "network") {
        toast("音声認識の通信に失敗しました。");
      }
    };
    rec.onend = () => {
      rec = null;
      const text = (finalText || interim).trim();
      if (text) { send(text); return; }
      if (state === "listening") setState("idle");
      if (handsfree && !errored && !document.hidden) {
        setTimeout(() => { if (state === "idle" && handsfree) startListening(); }, 250);
      }
    };
    els.you.textContent = "";
    setState("listening");
    try { rec.start(); } catch { rec = null; setState("idle"); }
  }

  function stopListening() { if (rec) rec.stop(); }

  // 話している・考えている途中で割り込む
  let abortCtl = null;
  function interrupt() {
    if (abortCtl) { abortCtl.abort(); abortCtl = null; }
    stopSpeaking();
    streamDone = true;
  }

  // ===== Claude との通信 =====
  function getPass() { return store.get("va.passcode", ""); }

  async function* demoStream(text) {
    const reply = `「${text}」ですね。それが実現できたら、一番何が変わりそうですか？ ……と、本番ではこんなふうに問いかけながら考えを整理していきます。いまはデモなので、まだ Claude にはつながっていません。`;
    await new Promise((r) => setTimeout(r, 700));
    for (let i = 0; i < reply.length; i += 3) {
      yield reply.slice(i, i + 3);
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  // Claude に送る形に整える（同じ話者の連続をまとめ、古いものから文字数の上限まで）
  function buildPayload(msgs) {
    const out = [];
    for (const m of msgs) {
      const content = String(m.content || "").trim();
      if (!content) continue;
      const prev = out[out.length - 1];
      if (prev && prev.role === m.role) prev.content += "\n\n" + content;
      else out.push({ role: m.role, content });
    }
    let total = 0, start = out.length;
    while (start > 0 && total + out[start - 1].content.length <= CONFIG.sendChars) total += out[--start].content.length;
    if (start === out.length && out.length) start = out.length - 1;
    const sliced = out.slice(start);
    while (sliced.length && sliced[0].role !== "user") sliced.shift();
    return sliced;
  }

  async function* apiStream(signal, retried = false) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-passcode": getPass() },
      body: JSON.stringify({ messages: buildPayload(history), model: settings.model, effort: settings.effort }),
      signal,
    });
    if (res.status === 401 && !retried) {
      const p = window.prompt("合言葉（APP_PASSCODE）を入力してください");
      if (p) { store.set("va.passcode", p.trim()); yield* apiStream(signal, true); return; }
    }
    if (res.status === 404 || res.status === 405) throw Object.assign(new Error("no-api"), { noApi: true });
    if (!res.ok || !res.body) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield dec.decode(value, { stream: true });
    }
  }

  async function send(text) {
    text = text.trim();
    if (!text) return;
    interrupt();
    unlockAudio();
    history.push({ role: "user", content: text });
    els.you.textContent = text;
    els.ai.innerHTML = "";
    setState("thinking");
    resetSpeech();
    streamDone = false;
    const ctl = (abortCtl = new AbortController());
    let full = "", raw = "";
    try {
      let stream;
      try {
        stream = demoMode ? demoStream(text) : apiStream(ctl.signal);
        for await (const chunk of stream) {
          if (ctl.signal.aborted) break;
          // 本文のあとに「\u0000 + 使用量」が付いてくるので、本文だけを表示・読み上げる
          raw += chunk;
          const cut = raw.indexOf("\u0000");
          full = cut < 0 ? raw : raw.slice(0, cut);
          renderRich(els.ai, full);
          els.captions.scrollTop = els.captions.scrollHeight;
          flushSpeech(full, false);
        }
      } catch (err) {
        if (err.noApi || (err instanceof TypeError && !/^https?:$/.test(location.protocol))) {
          demoMode = true;
          toast("API が見つからないため、デモモードで動作します。");
          for await (const chunk of demoStream(text)) {
            if (ctl.signal.aborted) break;
            full += chunk;
            renderRich(els.ai, full);
            flushSpeech(full, false);
          }
        } else throw err;
      }
      if (ctl.signal.aborted) {
        if (full) history.push({ role: "assistant", content: full + "\n（ここでユーザーが割り込みました）" });
        else history.pop();
        saveHistory();
        return;
      }
      flushSpeech(full, true);
      const cut = raw.indexOf("\u0000");
      if (cut >= 0) { try { recordUsage(JSON.parse(raw.slice(cut + 1))); } catch {} }
      history.push({ role: "assistant", content: full || "（返答なし）" });
      saveHistory();
      streamDone = true;
      if (abortCtl === ctl) abortCtl = null;
      if (pendingUtter === 0) onReplyFinished();
    } catch (err) {
      if (ctl.signal.aborted) {
        if (full) history.push({ role: "assistant", content: full + "\n（ここでユーザーが割り込みました）" });
        else history.pop();
        saveHistory();
        return;
      }
      history.pop();
      streamDone = true;
      abortCtl = null;
      setState("idle");
      const msg = String(err.message || err).slice(0, 200);
      els.ai.textContent = "うまく通信できませんでした。";
      toast(msg, 6000);
      speak("すみません、うまく通信できませんでした。");
    }
  }

  function saveHistory() {
    const t = currentThread();
    if (!t) return;
    t.updated = Date.now();
    if (!t.title) {
      const first = history.find((m) => m.role === "user");
      if (first) t.title = first.content.replace(/\s+/g, " ").slice(0, 30);
    }
    threads = [t, ...threads.filter((x) => x.id !== t.id)];
    store.set("va.t." + t.id, history);
    saveIndex();
    showThreadTitle();
  }
  function showThreadTitle() {
    const t = currentThread();
    els.threadTitle.textContent = t && t.title ? t.title : "";
  }

  // ===== 表示（コードブロック対応） =====
  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function renderRich(el, text) {
    const parts = text.split("```");
    el.innerHTML = "";
    parts.forEach((p, i) => {
      if (i % 2 === 0) {
        if (p) el.appendChild(document.createTextNode(p.replace(/^\n+|\n+$/g, "")));
      } else {
        const code = p.replace(/^[\w+-]*\n/, "");
        const pre = document.createElement("pre");
        pre.innerHTML = esc(code);
        const b = document.createElement("button");
        b.className = "copy"; b.textContent = "コピー";
        b.onclick = (e) => {
          e.stopPropagation();
          navigator.clipboard?.writeText(code).then(() => { b.textContent = "コピーしました"; setTimeout(() => (b.textContent = "コピー"), 1500); });
        };
        pre.appendChild(b);
        el.appendChild(pre);
      }
    });
  }

  function renderLog() {
    const body = $("logBody");
    body.innerHTML = "";
    if (!history.length) { body.innerHTML = '<p class="msg" style="color:var(--muted)">まだ会話はありません。</p>'; return; }
    for (const m of history) {
      const d = document.createElement("div");
      d.className = "msg " + m.role;
      renderRich(d, m.content);
      body.appendChild(d);
    }
    requestAnimationFrame(() => (body.parentElement.parentElement.scrollTop = 1e9));
  }

  // 画面下の字幕を、今の会話の最後のやり取りにする
  function showLastExchange() {
    const lastAi = [...history].reverse().find((m) => m.role === "assistant");
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    els.you.textContent = lastUser ? lastUser.content.replace(/\s+/g, " ").slice(0, 80) : "";
    if (lastAi) renderRich(els.ai, lastAi.content);
    else els.ai.textContent = demoMode ? "デモモードです。マイクボタンか球体をタップして話しかけてください。" : "マイクボタンか球体をタップして話しかけてください。";
    els.captions.scrollTop = 0;
    showThreadTitle();
  }

  // ===== パネル（会話一覧・設定） =====
  const panels = { threads: $("threadsPanel"), settings: $("settingsPanel") };
  const views = ["threadsView", "pickView", "pasteView", "logView"];
  function openPanel(name) { panels[name].hidden = false; }
  function closePanels() { Object.values(panels).forEach((p) => (p.hidden = true)); }
  function anyPanelOpen() { return Object.values(panels).some((p) => !p.hidden); }
  function showView(id, title) {
    views.forEach((v) => ($(v).hidden = v !== id));
    $("threadsHeadTitle").textContent = title;
    panels.threads.querySelector(".panel-body").scrollTop = 0;
  }
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closePanels));

  const SOURCE = { app: "", claude: "claude.ai", paste: "貼り付け" };
  function fmtDate(ms) {
    const d = new Date(ms), now = new Date();
    const hm = d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === now.toDateString()) return "今日 " + hm;
    return d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" }) + " " + hm;
  }

  function renderThreads() {
    const ul = $("threadList");
    ul.innerHTML = "";
    for (const t of threads) {
      const count = (store.get("va.t." + t.id, []) || []).length;
      const li = document.createElement("li");
      if (t.id === currentId) li.className = "current";
      li.innerHTML = `<div class="t-main"><div class="t-title"></div><div class="t-meta"></div></div>
        <button class="view">ログ</button><button class="del">削除</button>`;
      li.querySelector(".t-title").textContent = t.title || "（無題の会話）";
      const meta = li.querySelector(".t-meta");
      if (t.id === currentId) meta.insertAdjacentHTML("beforeend", '<span class="badge now">いまの会話</span>');
      if (SOURCE[t.source]) meta.insertAdjacentHTML("beforeend", `<span class="badge">${SOURCE[t.source]}</span>`);
      meta.insertAdjacentText("beforeend", `${fmtDate(t.updated)} ・ ${count}件`);
      li.addEventListener("click", () => switchTo(t.id));
      li.querySelector(".view").addEventListener("click", (e) => {
        e.stopPropagation();
        openThread(t.id);
        showLastExchange();
        renderLog();
        showView("logView", t.title || "会話ログ");
      });
      li.querySelector(".del").addEventListener("click", (e) => {
        e.stopPropagation();
        if (li.dataset.confirm) {
          deleteThread(t.id);
          showLastExchange();
          renderThreads();
        } else {
          li.dataset.confirm = "1";
          e.target.textContent = "本当に削除";
          setTimeout(() => { if (li.isConnected) { delete li.dataset.confirm; e.target.textContent = "削除"; } }, 3000);
        }
      });
      ul.appendChild(li);
    }
  }

  function switchTo(id) {
    interrupt();
    if (rec) rec.abort();
    openThread(id);
    setState("idle");
    showLastExchange();
    closePanels();
    const t = currentThread();
    toast(`「${t.title || "無題の会話"}」の続きから話せます`);
  }

  // --- claude.ai の書き出しファイルから取り込む ---
  // claude.ai の「設定 → プライバシー → データを書き出す」で届く zip（または中の conversations.json）
  let exported = [];
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = () => rej(new Error("読み込みに失敗しました"));
      document.head.appendChild(s);
    });
  }
  async function readExport(file) {
    let text;
    if (/\.zip$/i.test(file.name) || file.type.includes("zip")) {
      if (!window.JSZip) await loadScript("https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js");
      const zip = await window.JSZip.loadAsync(file);
      const entry = Object.values(zip.files).find((f) => /(^|\/)conversations\.json$/i.test(f.name));
      if (!entry) throw new Error("zip の中に conversations.json が見つかりません");
      text = await entry.async("string");
    } else {
      text = await file.text();
    }
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : data.conversations || [];
    return list.map((c) => {
      const msgs = (c.chat_messages || c.messages || []).map((m) => {
        const role = /human|user/i.test(m.sender || m.role) ? "user" : "assistant";
        let content = m.text || "";
        if (!content && Array.isArray(m.content)) content = m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
        if (typeof m.content === "string" && !content) content = m.content;
        return { role, content: String(content || "").trim() };
      }).filter((m) => m.content);
      return { title: (c.name || "").trim() || "（無題の会話）", updated: Date.parse(c.updated_at || c.created_at) || 0, messages: msgs };
    }).filter((c) => c.messages.length).sort((a, b) => b.updated - a.updated);
  }

  function renderPick() {
    const q = $("pickSearch").value.trim().toLowerCase();
    const ul = $("pickList");
    ul.innerHTML = "";
    const items = exported.filter((c) => !q || c.title.toLowerCase().includes(q)).slice(0, 200);
    if (!items.length) { ul.innerHTML = '<li class="empty">見つかりませんでした</li>'; return; }
    for (const c of items) {
      const li = document.createElement("li");
      li.innerHTML = '<div class="t-main"><div class="t-title"></div><div class="t-meta"></div></div>';
      li.querySelector(".t-title").textContent = c.title;
      li.querySelector(".t-meta").textContent = `${c.updated ? fmtDate(c.updated) : ""} ・ ${c.messages.length}件`;
      li.addEventListener("click", () => {
        interrupt();
        const note = { role: "user", content: "（以下は、以前 claude.ai で行った会話の記録です。この続きを一緒に深めたいです。）" };
        createThread({ title: c.title, source: "claude", messages: [note, ...c.messages] });
        saveHistory();
        switchTo(currentId);
      });
      ul.appendChild(li);
    }
  }

  $("importFileBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    toast("読み込んでいます…", 8000);
    try {
      exported = await readExport(file);
      if (!exported.length) throw new Error("会話が見つかりませんでした");
      toast(`${exported.length}件の会話が見つかりました`);
      $("pickSearch").value = "";
      renderPick();
      showView("pickView", "取り込む会話を選ぶ");
    } catch (err) {
      toast("取り込めませんでした：" + (err.message || err), 6000);
    }
  });
  $("pickSearch").addEventListener("input", renderPick);
  $("pickBackBtn").addEventListener("click", () => { renderThreads(); showView("threadsView", "会話"); });

  // --- 貼り付けて取り込む ---
  $("importPasteBtn").addEventListener("click", () => {
    $("pasteTitle").value = ""; $("pasteText").value = "";
    showView("pasteView", "貼り付けて取り込む");
    setTimeout(() => $("pasteText").focus(), 50);
  });
  $("pasteBackBtn").addEventListener("click", () => { renderThreads(); showView("threadsView", "会話"); });
  $("pasteSaveBtn").addEventListener("click", () => {
    const text = $("pasteText").value.trim();
    if (!text) { toast("会話を貼り付けてください"); return; }
    const title = $("pasteTitle").value.trim() || text.replace(/\s+/g, " ").slice(0, 30);
    interrupt();
    createThread({
      title, source: "paste",
      messages: [
        { role: "user", content: "以下は、以前 Claude と行った会話の記録です。この内容を踏まえて、続きを一緒に深めてください。\n\n---\n" + text },
        { role: "assistant", content: "会話の内容を確認しました。続きからお話ししましょう。いま一番深めたいのは、どの部分ですか？" },
      ],
    });
    saveHistory();
    switchTo(currentId);
  });

  $("newThreadBtn").addEventListener("click", () => {
    interrupt();
    createThread();
    setState("idle");
    showLastExchange();
    closePanels();
    toast("新しい会話を始めます");
  });
  $("logBackBtn").addEventListener("click", () => { renderThreads(); showView("threadsView", "会話"); });
  $("threadsBtn").addEventListener("click", () => {
    renderThreads();
    showView("threadsView", "会話");
    openPanel("threads");
  });

  // ===== 使用量（このアプリが API に払った料金を、予算に対する割合で表示） =====
  const budget = Object.assign({ period: "month", yen: 3000, fx: 150 }, store.get("va.budget", {}));
  let usage = store.get("va.usage", null);
  const PERIOD_LABEL = { day: "今日", week: "今週", month: "今月" };
  const MODEL_LABEL = {
    "claude-fable-5-1": "Fable 5.1", "claude-opus-5-5": "Opus 5.5",
    "claude-sonnet-5-5": "Sonnet 5.5", "claude-haiku-4-5-20251001": "Haiku 4.5",
  };
  const MODEL_PRICE = {
    "claude-fable-5-1": [10, 50], "claude-opus-5-5": [4, 20],
    "claude-sonnet-5-5": [2, 10], "claude-haiku-4-5-20251001": [1, 5],
  };

  function periodStart(d = new Date()) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (budget.period === "week") x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    if (budget.period === "month") x.setDate(1);
    return x;
  }
  function nextReset() {
    const x = periodStart();
    if (budget.period === "day") x.setDate(x.getDate() + 1);
    else if (budget.period === "week") x.setDate(x.getDate() + 7);
    else x.setMonth(x.getMonth() + 1);
    return x;
  }
  function freshUsage() { return { start: periodStart().getTime(), usd: 0, input: 0, output: 0, requests: 0, last: null }; }
  function ensurePeriod() {
    if (!usage || usage.start !== periodStart().getTime()) { usage = freshUsage(); store.set("va.usage", usage); }
  }
  function recordUsage(u) {
    ensurePeriod();
    const before = pct();
    usage.usd += u.usd || 0;
    usage.input += (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
    usage.output += u.output || 0;
    usage.requests += 1;
    usage.last = { ...u, at: Date.now() };
    store.set("va.usage", usage);
    renderUsage();
    const after = pct();
    if (before < 80 && after >= 80 && after < 100) toast(`${PERIOD_LABEL[budget.period]}の予算の ${after}% を使いました`, 5000);
    if (before < 100 && after >= 100) toast(`${PERIOD_LABEL[budget.period]}の予算を使い切りました。設定でモデルを軽くするか、予算を見直してください。`, 7000);
  }
  function pct() {
    if (!usage || !budget.yen) return 0;
    return Math.round(((usage.usd * budget.fx) / budget.yen) * 100);
  }
  const yen = (usd) => "¥" + Math.round(usd * budget.fx).toLocaleString("ja-JP");
  const yenFine = (usd) => { const v = usd * budget.fx; return "¥" + (v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString("ja-JP")); };
  function resetText(long) {
    const r = nextReset();
    const hm = r.toLocaleTimeString("ja-JP", { hour: "numeric", minute: "2-digit" });
    const md = `${r.getMonth() + 1}/${r.getDate()}`;
    if (budget.period === "day") return long ? `${hm}にリセットされます` : `${hm}にリセット`;
    return long ? `${md} ${hm}にリセットされます` : `${md} ${hm}リセット`;
  }
  function renderUsage() {
    ensurePeriod();
    const p = pct();
    const state = p >= 100 ? "over" : p >= 80 ? "warn" : "ok";
    document.body.dataset.usage = state;
    $("usagePct").textContent = p + "%";
    $("usageBar").style.width = Math.min(100, p) + "%";
    $("usageReset").textContent = resetText(false);
    $("usagePeriodLabel").textContent = PERIOD_LABEL[budget.period];
    $("usagePct2").textContent = p + "%";
    $("usageBar2").style.width = Math.min(100, p) + "%";
    $("usageResetLong").textContent = resetText(true);
    $("usageYen").textContent = yen(usage.usd);
    $("usageBudget").textContent = "¥" + Number(budget.yen).toLocaleString("ja-JP");
    $("usageReq").textContent = usage.requests + "回";
    $("usageTok").textContent = `${usage.input.toLocaleString("ja-JP")} / ${usage.output.toLocaleString("ja-JP")}`;
    const L = usage.last;
    $("usageLast").textContent = L
      ? `直近の返事：${yenFine(L.usd)}（${MODEL_LABEL[L.model] || L.model}${L.effort ? "・" + L.effort : ""}、入力 ${((L.input || 0) + (L.cacheRead || 0) + (L.cacheWrite || 0)).toLocaleString("ja-JP")} / 出力 ${(L.output || 0).toLocaleString("ja-JP")} トークン）。会話が長くなるほど、1回の料金は上がります。`
      : "まだ記録がありません。";
  }
  function saveBudget() { store.set("va.budget", budget); usage = null; ensurePeriodKeep(); renderUsage(); }
  function ensurePeriodKeep() {
    // 期間の区切りを変えたときは、今の記録を新しい期間の始まりに合わせる
    const old = store.get("va.usage", null);
    usage = old ? { ...old, start: periodStart().getTime() } : freshUsage();
    store.set("va.usage", usage);
  }
  $("usageChip").addEventListener("click", () => {
    renderSettings(); openPanel("settings");
    $("usageSection").scrollIntoView({ block: "start" });
  });
  $("budgetPeriod").addEventListener("change", (e) => { budget.period = e.target.value; saveBudget(); });
  $("budgetYen").addEventListener("change", (e) => { budget.yen = Math.max(0, +e.target.value || 0); saveBudget(); });
  $("fxRate").addEventListener("change", (e) => { budget.fx = Math.min(400, Math.max(50, +e.target.value || 150)); saveBudget(); });
  $("usageResetBtn").addEventListener("click", (e) => {
    const b = e.target;
    if (!b.dataset.confirm) {
      b.dataset.confirm = "1"; b.textContent = "もう一度押すと 0 に戻します";
      setTimeout(() => { delete b.dataset.confirm; b.textContent = "使用量を 0 に戻す"; }, 3000);
      return;
    }
    usage = freshUsage(); store.set("va.usage", usage); renderUsage();
    delete b.dataset.confirm; b.textContent = "使用量を 0 に戻す";
    toast("使用量を 0 に戻しました");
  });
  setInterval(renderUsage, 60 * 1000); // 期間の切り替わりを反映
  renderUsage();

  // ===== モデル・エフォート =====
  function renderModel() {
    $("modelSel").value = settings.model;
    $("effortSel").value = settings.effort;
    const [pin, pout] = MODEL_PRICE[settings.model] || [0, 0];
    $("modelPrice").textContent =
      `料金の目安：入力 100万トークンあたり $${pin}（約${yen(pin)}）、出力 $${pout}（約${yen(pout)}）。` +
      (settings.model === "claude-fable-5-1" ? "考えてから話し始めるため、返事までに時間がかかります。" : "");
    const noEffort = settings.model === "claude-haiku-4-5-20251001";
    $("effortSel").disabled = noEffort;
    const def = settings.model === "claude-opus-5-5" ? "medium" : "high";
    $("effortHint").textContent = noEffort
      ? "Haiku 4.5 はエフォートの指定に対応していません。"
      : `「おまかせ」のときは ${def} になります。上げるほど深く考えますが、返事が遅くなり、料金も増えます。声の会話では low〜medium がおすすめです。`;
  }
  $("modelSel").addEventListener("change", (e) => { settings.model = e.target.value; store.set("va.settings", settings); renderModel(); toast(`${MODEL_LABEL[settings.model]} に切り替えました`); });
  $("effortSel").addEventListener("change", (e) => { settings.effort = e.target.value; store.set("va.settings", settings); renderModel(); });

  // ===== 設定（声・速さ・高さ・合言葉） =====
  function renderVoiceOptions() {
    const sel = $("voiceSel");
    if (!sel) return;
    const list = jaVoices();
    sel.innerHTML = "";
    const auto = new Option("おまかせ（女性の声を自動で選択）", "");
    sel.add(auto);
    for (const v of list) sel.add(new Option(v.name + (v.localService ? "" : "（オンライン）"), v.voiceURI));
    if (!list.length) sel.add(new Option("この端末には日本語の声が見つかりません", "", false, false));
    sel.value = list.some((v) => v.voiceURI === settings.voiceURI) ? settings.voiceURI : "";
  }
  function renderSettings() {
    renderVoiceOptions();
    $("rateIn").value = settings.rate;
    $("pitchIn").value = settings.pitch;
    $("rateOut").textContent = "×" + Number(settings.rate).toFixed(2);
    $("pitchOut").textContent = Number(settings.pitch).toFixed(2);
    $("passIn").value = getPass();
    renderModel();
    $("budgetPeriod").value = budget.period;
    $("budgetYen").value = budget.yen;
    $("fxRate").value = budget.fx;
    renderUsage();
  }
  function saveSettings() { store.set("va.settings", settings); pickVoice(); }
  $("voiceSel").addEventListener("change", (e) => { settings.voiceURI = e.target.value; saveSettings(); preview(); });
  $("rateIn").addEventListener("input", (e) => { settings.rate = +e.target.value; $("rateOut").textContent = "×" + settings.rate.toFixed(2); saveSettings(); });
  $("pitchIn").addEventListener("input", (e) => { settings.pitch = +e.target.value; $("pitchOut").textContent = settings.pitch.toFixed(2); saveSettings(); });
  $("rateIn").addEventListener("change", preview);
  $("pitchIn").addEventListener("change", preview);
  function preview() {
    unlockAudio();
    stopSpeaking();
    speak("こんにちは。この声と速さでお話しします。");
  }
  $("previewBtn").addEventListener("click", preview);
  $("resetVoiceBtn").addEventListener("click", () => {
    Object.assign(settings, { voiceURI: "", rate: CONFIG.rate, pitch: CONFIG.pitch });
    saveSettings(); renderSettings(); preview();
  });
  $("passSaveBtn").addEventListener("click", () => { store.set("va.passcode", $("passIn").value.trim()); toast("合言葉を保存しました"); });
  $("settingsBtn").addEventListener("click", () => { renderSettings(); openPanel("settings"); });

  // ===== ハンズフリー（画面を点けたまま、会話を続ける） =====
  let wakeLock = null;
  async function setHandsfree(on) {
    handsfree = on;
    els.handsfree.setAttribute("aria-pressed", String(on));
    if (on) {
      try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
      toast("ハンズフリー：返事のあと自動で聞き取りを再開します");
      if (state === "idle") startListening();
    } else {
      try { await wakeLock?.release(); } catch {}
      wakeLock = null;
    }
  }
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) { stopListening(); return; }
    if (handsfree && !wakeLock) { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} }
  });

  // ===== 操作 =====
  function onMainAction() {
    unlockAudio();
    if (state === "listening") stopListening();
    else startListening(); // 話している・考えている途中でも割り込んで聞き取りを開始
  }
  els.mic.addEventListener("click", onMainAction);
  $("stage").addEventListener("click", onMainAction);
  els.handsfree.addEventListener("click", () => { unlockAudio(); setHandsfree(!handsfree); });
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = els.input.value;
    els.input.value = "";
    els.input.blur();
    send(v);
  });
  // PC：スペースキーで話しかける
  addEventListener("keydown", (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
    if (e.code === "Space" && !typing && !anyPanelOpen()) {
      e.preventDefault();
      if (!e.repeat) onMainAction();
    }
    if (e.key === "Escape") {
      if (anyPanelOpen()) { closePanels(); return; }
      interrupt(); if (state !== "listening") setState("idle");
    }
  });

  // 前回の会話の最後のやり取りを表示
  showLastExchange();
})();
