/* =========================================================================
   AI Doubt — a study assistant that sits beside the lecture.
   -------------------------------------------------------------------------
   Two brains, honestly labelled:
     · Instant help (built in, offline): how this site works, study tactics,
       and revision questions generated from *your own notes & bookmarks*
       on this lecture. No network, no key, no pretence of being an LLM.
     · Your AI (optional): paste your own OpenAI-compatible or Gemini API
       key and answers come from that model, with this lecture's title,
       chapter, your position and your notes as context. The key is stored
       only in this browser and sent only to the endpoint you chose.
   ========================================================================= */

const params = new URLSearchParams(location.search);
const lectureId = params.get("id") || "";
const log = document.getElementById("aiLog");
const input = document.getElementById("aiInput");
const sendBtn = document.getElementById("aiSend");
const KEY_STORE = "arsvibe.ai";

const context = () => {
  let notes = [];
  try { notes = JSON.parse(localStorage.getItem(`notes:${lectureId}`) || "[]"); } catch { /* none */ }
  return {
    title: params.get("title") || document.getElementById("lectureTitle")?.textContent || "this lecture",
    subject: params.get("subject") || "",
    notes: Array.isArray(notes) ? notes : [],
  };
};

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function addMsg(who, text) {
  if (!log) return null;
  const row = document.createElement("div");
  row.className = `ai-msg ${who}`;
  row.innerHTML = `<span class="ai-who">${who === "me" ? "You" : "🤖 Assistant"}</span><p>${esc(text)}</p>`;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return row;
}

/* ------------------------- the offline brain ------------------------- */
function instantAnswer(q) {
  const text = q.toLowerCase();
  const ctx = context();
  if (/download|offline|save/.test(text)) {
    return "To watch offline: open Downloads in the menu, pick the batch and lecture, and it saves inside the site. PDFs (notes/DPPs) can be kept from the Class notes & DPPs card beside the player.";
  }
  if (/dpp|practice|test/.test(text)) {
    return "For practice: the Class notes & DPPs card beside the player lists this chapter's DPPs, and Batches → DPP Tests runs them as timed, auto-marked tests. Attempt the DPP right after the lecture, while the method is warm.";
  }
  if (/note|bookmark|revise|revision/.test(text)) {
    if (ctx.notes.length) {
      const lines = ctx.notes.slice(0, 6).map((n) => `• ${Math.floor(n.t / 60)}:${String(Math.floor(n.t % 60)).padStart(2, "0")} — ${n.text || "bookmark"}`).join("\n");
      return `Your revision list for this lecture:\n${lines}\nSay each one aloud without looking — the ones you cannot say are the ones to rewatch.`;
    }
    return "You have no notes on this lecture yet. Use the 📝 My notes card: pause at the moment that matters, write what clicked. Those timestamps become your revision list — and dots on the scrubber.";
  }
  if (/speed|fast|slow|1\.5|2x/.test(text)) {
    return "Playback speed lives in the player's speed menu (and holding the screen boosts to 2x). Revision passes work well at 1.5–1.75x; first watches at 1–1.25x. Your speed choice is remembered.";
  }
  if (/quality|buffer|stuck|loading/.test(text)) {
    return "If it buffers: the chip above the player shows seconds buffered ahead — Zero-Buffer keeps minutes in hand. Drop one quality level manually if your network dips; the player also steps down by itself before it stalls.";
  }
  if (/summary|summarise|summarize|explain/.test(text)) {
    return ctx.notes.length
      ? `From your own notes on “${ctx.title}”: the spine of this lecture is ${ctx.notes.map((n) => `“${n.text || "bookmark"}”`).slice(0, 4).join(", ")}. Connect your AI key below and I will write a full explanation from this.`
      : `I can summarise properly once your AI key is connected (below) — it will read this lecture's title, chapter and your notes. Offline, the fastest summary is yours: write 3 timestamped notes, then say the lecture back in 60 seconds.`;
  }
  if (/question|quiz|mcq/.test(text)) {
    const topics = ctx.notes.map((n) => n.text).filter(Boolean).slice(0, 3);
    return topics.length
      ? `Self-test from your notes:\n${topics.map((t, i) => `${i + 1}. Explain “${t}” without looking, then name one case where it fails.`).join("\n")}\nThen run the chapter DPP for marked questions.`
      : "Add two or three timestamped notes first (📝 My notes), then ask me again — I will turn them into self-test questions. Meanwhile the chapter DPP is one tap away in the attachments card.";
  }
  if (/^(hi|hello|hey)\b/.test(text)) {
    return `Hi! You are watching “${ctx.title}”. Ask me how to download, revise with your notes, run DPPs — or connect your AI key below and ask anything about the topic.`;
  }
  return "Offline, I am best at: this site (downloads, notes, DPPs, player), and turning your timestamped notes into revision lists and self-tests. For deep topic answers, connect your own AI key below — it answers with this lecture as context.";
}

/* --------------------------- your AI brain ---------------------------- */
function aiConfig() {
  try { return JSON.parse(localStorage.getItem(KEY_STORE) || "{}"); } catch { return {}; }
}
async function askModel(q) {
  const cfg = aiConfig();
  const base = (cfg.base || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = cfg.model || "gpt-4o-mini";
  const ctx = context();
  const video = document.getElementById("video");
  const at = video ? `${Math.floor(video.currentTime / 60)}:${String(Math.floor(video.currentTime % 60)).padStart(2, "0")}` : "";
  const system = `You are a patient study tutor inside a lecture player. The student is watching "${ctx.title}" (subject id: ${ctx.subject}) at ${at}. Their timestamped notes: ${ctx.notes.map((n) => `[${Math.floor(n.t / 60)}:${String(Math.floor(n.t % 60)).padStart(2, "0")}] ${n.text}`).join("; ") || "none"}. Answer concisely, teach the concept, and end with one check question.`;
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: q },
      ],
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`The AI endpoint answered ${res.status} — check the key, model and base URL.`);
  const data = await res.json().catch(() => null);
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("The AI endpoint answered without text.");
  return text;
}

async function ask(q) {
  const question = (q ?? input?.value ?? "").trim();
  if (!question) return;
  addMsg("me", question);
  if (input) input.value = "";
  if (aiConfig().key) {
    const pending = addMsg("ai", "Thinking…");
    try {
      const answer = await askModel(question);
      if (pending) pending.querySelector("p").textContent = answer;
    } catch (err) {
      if (pending) pending.querySelector("p").textContent = `${err.message}\n\n(Offline answer instead) ${instantAnswer(question)}`;
    }
  } else {
    addMsg("ai", instantAnswer(question));
  }
  log && (log.scrollTop = log.scrollHeight);
}

if (log && input) {
  addMsg("ai", instantAnswer("hi"));
  sendBtn?.addEventListener("click", () => ask());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); ask(); }
  });
  document.querySelectorAll("[data-ai-ask]").forEach((b) =>
    b.addEventListener("click", () => ask(b.dataset.aiAsk))
  );

  /* settings: key lives in this browser only */
  const saveBtn = document.getElementById("aiSave");
  const baseEl = document.getElementById("aiBase");
  const keyEl = document.getElementById("aiKey");
  const modelEl = document.getElementById("aiModel");
  const cfg = aiConfig();
  if (baseEl) baseEl.value = cfg.base || "";
  if (modelEl) modelEl.value = cfg.model || "";
  if (keyEl) keyEl.value = cfg.key ? "••••••••" : "";
  saveBtn?.addEventListener("click", () => {
    const next = {
      base: baseEl?.value.trim() || "",
      model: modelEl?.value.trim() || "",
      key: keyEl && keyEl.value !== "••••••••" ? keyEl.value.trim() : cfg.key || "",
    };
    try { localStorage.setItem(KEY_STORE, JSON.stringify(next)); } catch { /* ignore */ }
    addMsg("ai", next.key ? "Your AI is connected — ask anything about this lecture." : "Key cleared — I am back to instant offline help.");
  });
}
