(() => {
  "use strict";

  // ===== 設定 =====
  const CONFIG = {
    name: "AI",          // AI の名前（決まったらここを変更）
    lang: "ja-JP",
    rate: 1.05,          // 読み上げ速度
    pitch: 1.0,          // 声の高さ
    maxHistory: 40,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    body: document.body, statusText: $("statusText"), aiName: $("aiName"),
    float: $("orbFloat"), halo: $("halo"), ring: $("ring"),
    you: $("youText"), ai: $("aiText"), captions: $("captions"),
    mic: $("micBtn"), handsfree: $("handsfreeBtn"), logBtn: $("logBtn"),
    log: $("log"), logBody: $("logBody"), closeLog: $("closeLogBtn"), clear: $("clearBtn"),
    form: $("textForm"), input: $("textInput"), toast: $("toast"),
  };
  els.aiName.textContent = CONFIG.name;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // ===== 状態 =====
  const STATUS = { idle: "待機中", listening: "聞いています", thinking: "考えています", speaking: "話しています" };
  let state = "idle";
  let handsfree = false;
  let history = store.get("va.history", []);
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
  const FEMALE = /Kyoko|O-ren|Nanami|Haruka|Ayumi|Mizuki|Sayaka|Nana|Google 日本語|Shiori|Aoi|Mayu/i;
  const MALE = /Otoya|Hattori|Ichiro|Keita|Daichi|Naoki|Hiroshi/i;
  function pickVoice() {
    if (!synth) return;
    const ja = synth.getVoices().filter((v) => /^ja/i.test(v.lang));
    const score = (v) =>
      (FEMALE.test(v.name) ? 10 : 0) - (MALE.test(v.name) ? 20 : 0) +
      (/Premium|Enhanced|Natural|Neural|Online/i.test(v.name) ? 5 : 0);
    voice = ja.sort((a, b) => score(b) - score(a))[0] || null;
  }
  if (synth) { pickVoice(); synth.onvoiceschanged = pickVoice; }

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
    u.rate = CONFIG.rate;
    u.pitch = CONFIG.pitch;
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

  async function* apiStream(signal, retried = false) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-passcode": getPass() },
      body: JSON.stringify({ messages: history }),
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
    let full = "";
    try {
      let stream;
      try {
        stream = demoMode ? demoStream(text) : apiStream(ctl.signal);
        for await (const chunk of stream) {
          if (ctl.signal.aborted) break;
          full += chunk;
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
    history = history.slice(-CONFIG.maxHistory);
    while (history.length && history[0].role !== "user") history.shift();
    store.set("va.history", history);
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
    els.logBody.innerHTML = "";
    if (!history.length) { els.logBody.innerHTML = '<p class="msg" style="color:var(--muted)">まだ会話はありません。</p>'; return; }
    for (const m of history) {
      const d = document.createElement("div");
      d.className = "msg " + m.role;
      renderRich(d, m.content);
      els.logBody.appendChild(d);
    }
    els.logBody.scrollTop = els.logBody.scrollHeight;
  }

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
  els.logBtn.addEventListener("click", () => { renderLog(); els.log.hidden = false; });
  els.closeLog.addEventListener("click", () => (els.log.hidden = true));
  els.clear.addEventListener("click", () => {
    interrupt();
    history = []; saveHistory(); renderLog();
    els.you.textContent = ""; els.ai.textContent = "";
    setState("idle");
    toast("新しい会話を始めます");
  });
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = els.input.value;
    els.input.value = "";
    els.input.blur();
    send(v);
  });
  // PC：スペースキーで話しかける
  addEventListener("keydown", (e) => {
    if (e.code === "Space" && document.activeElement !== els.input && els.log.hidden) {
      e.preventDefault();
      if (!e.repeat) onMainAction();
    }
    if (e.key === "Escape") { interrupt(); if (state !== "listening") setState("idle"); }
  });

  // 前回の最後の返答を表示
  const lastAi = [...history].reverse().find((m) => m.role === "assistant");
  if (lastAi) renderRich(els.ai, lastAi.content);
  else els.ai.textContent = demoMode ? "デモモードです。マイクボタンか球体をタップして話しかけてください。" : "マイクボタンか球体をタップして話しかけてください。";
})();
