// Vercel サーバーレス関数：ブラウザから受け取った会話を Claude に送り、返答を少しずつ返す
// 必要な環境変数（Vercel の Settings → Environment Variables で設定）
//   ANTHROPIC_API_KEY  … Claude の API キー（必須）
//   APP_PASSCODE       … アプリの合言葉（推奨。他人に API を使われないため）
//   CLAUDE_MODEL       … アプリ側で選ばなかったときのモデル（省略時 claude-sonnet-5-5）
//   AI_NAME            … AI の名前（省略時「アシスタント」）

export const config = { maxDuration: 300 }; // 深く考えるモデル・エフォートでも途中で切れないよう、Hobby プランの上限（5分）

// 選べるモデルと料金（1M トークンあたりの米ドル）。料金は https://platform.claude.com/docs/en/models/overview
const MODELS = {
  "claude-fable-5-1":          { in: 10, out: 50, effort: true },
  "claude-opus-5-5":           { in: 4,  out: 20, effort: true },
  "claude-sonnet-5-5":         { in: 2,  out: 10, effort: true },
  "claude-haiku-4-5-20251001": { in: 1,  out: 5,  effort: false },
};
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function systemPrompt() {
  const name = process.env.AI_NAME || "アシスタント";
  return `あなたは「${name}」という名前の、落ち着いた女性の声で話す AI パートナーです。
ユーザーは音声で話しかけ、あなたの返答は画面表示と同時に音声で読み上げられます。
あなたの役割は2つあります。1つはユーザーの考えを引き出して整理するコーチ、もう1つはそれを形にする開発パートナーです。基本は対話で、コードは必要なときに書きます。

# コーチングとしての対話（基本の姿勢）
- すぐに答えや解決策を出さず、まずユーザーが本当に実現したいこと、その理由、何が引っかかっているかを探る。
- 問いは開かれた形で、1回に1つだけ。例：「それができたら、何が一番楽になりますか？」「いま一番気になっているのはどこですか？」
- ユーザーの言葉を短く言い換えて返し、理解が合っているか確かめる。例：「つまり〇〇を一番大事にしたい、ということですね。」
- 言葉の裏にある前提や迷い、言い切れていない部分に気づいたら、やさしく指摘する。
- 考えがまとまってきたら、要点を2〜3文でまとめ、次の一歩を一緒に決める。
- 答えが明確な質問や、ユーザーが「すぐ答えて」「コードを出して」と言ったときは、掘り下げずに直接応える。質問攻めにしない。
- 否定や説教はせず、ユーザーの判断を尊重する。ただし懸念があれば率直に一言添える。

# 話し方
- 落ち着いた、穏やかで知的な口調。丁寧語で、親しみは控えめに。
- 返答は話し言葉で、まず結論を1〜2文。長くても4〜5文程度に収める。
- 見出し・箇条書き・太字などのマークダウン記号は使わない（読み上げで不自然になるため）。
- 選択肢を示すときは「1つ目は〜、2つ目は〜」のように口頭で区切る。
- 確認が必要なときは、質問は1回に1つだけ。

# コードや長い資料
- コードは必ず \`\`\` で囲んだコードブロックに入れる。コードブロックは画面にだけ表示され、読み上げられない。
- コードを出すときは、その前に「何をするコードか」「どこに貼るか」を口頭で1〜2文説明する。
- ユーザーはプログラミング経験がなく、自然言語で指示してアプリを作る（バイブコーディング）。専門用語は短く言い換える。
- GitHub、Vercel、Supabase の基本操作は経験済み。

# 状況
- ユーザーは運転中などで画面を見られないことがある。音声だけで理解できる説明を優先する。
- 聞き取りミスと思われる語は、文脈から推測し、重要な場合だけ確認する。
- 会話の冒頭に、ユーザーが claude.ai から取り込んだ過去の会話が含まれることがある。その場合は内容を踏まえ、要点を思い出しながら続きを深める。最初の返答では、これまでの流れを1〜2文でふり返ってから問いかける。`;
}

export async function POST(req) {
  const pass = process.env.APP_PASSCODE;
  if (pass && req.headers.get("x-app-passcode") !== pass) {
    return new Response("passcode", { status: 401 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response("ANTHROPIC_API_KEY が設定されていません", { status: 500 });
  }

  let messages, reqModel, reqEffort;
  try {
    ({ messages, model: reqModel, effort: reqEffort } = await req.json());
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response("bad request", { status: 400 });
  }

  const fallback = MODELS[process.env.CLAUDE_MODEL] ? process.env.CLAUDE_MODEL : "claude-sonnet-5-5";
  const model = MODELS[reqModel] ? reqModel : fallback;
  const price = MODELS[model];
  const effort = price.effort && EFFORTS.includes(reqEffort) ? reqEffort : null;

  const payload = {
    model,
    // 考える量（思考）も出力に含まれるため、余裕を持たせる
    max_tokens: effort === "xhigh" || effort === "max" ? 32000 : 16000,
    system: systemPrompt(),
    messages: messages.slice(-200),
    stream: true,
  };
  if (effort) payload.output_config = { effort };

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
    signal: req.signal,
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(`Claude API エラー (${upstream.status}): ${text}`, { status: 502 });
  }

  // Claude のストリーム（SSE）から本文テキストだけを取り出して流す
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            try {
              const ev = JSON.parse(data);
              if (ev.type === "message_start" && ev.message?.usage) {
                const u = ev.message.usage;
                usage.input = u.input_tokens || 0;
                usage.cacheRead = u.cache_read_input_tokens || 0;
                usage.cacheWrite = u.cache_creation_input_tokens || 0;
                usage.output = u.output_tokens || 0;
              } else if (ev.type === "message_delta" && ev.usage) {
                if (ev.usage.output_tokens != null) usage.output = ev.usage.output_tokens;
                if (ev.usage.input_tokens) usage.input = ev.usage.input_tokens;
              } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
                controller.enqueue(encoder.encode(ev.delta.text));
              } else if (ev.type === "error") {
                controller.enqueue(encoder.encode(`\n（エラー：${ev.error?.message || "不明"}）`));
              }
            } catch {}
          }
        }
      } catch {}
      // 最後に、この1回の使用量と料金を区切り文字（\u0000）のあとに付けて送る
      const usd =
        (usage.input * price.in + usage.cacheWrite * price.in * 1.25 + usage.cacheRead * price.in * 0.1 + usage.output * price.out) / 1e6;
      try {
        controller.enqueue(encoder.encode("\u0000" + JSON.stringify({ model, effort, ...usage, usd })));
      } catch {}
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
