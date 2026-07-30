export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <title>Pi Anywhere</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <p class="eyebrow">PI ANYWHERE</p>
        <h1>Your main Pi session</h1>
      </div>
      <p id="connection" class="connection" aria-live="polite">Connecting…</p>
    </header>

    <section id="pairing-error" class="notice hidden" role="alert"></section>
    <nav id="timeline-filters" class="timeline-toolbar" aria-label="Timeline filter">
      <button type="button" class="timeline-filter active" data-filter="all" aria-pressed="true">All</button>
      <button type="button" class="timeline-filter" data-filter="chat" aria-pressed="false">Chat</button>
      <button type="button" class="timeline-filter" data-filter="activity" aria-pressed="false">Commands & edits</button>
    </nav>
    <section id="messages" class="messages" aria-live="polite" aria-label="Session timeline"></section>

    <form id="composer" class="composer">
      <label class="sr-only" for="message-input">Message Pi</label>
      <textarea id="message-input" rows="3" maxlength="12000" placeholder="Message your Pi session…"></textarea>
      <div class="composer-actions">
        <label class="delivery-label" for="delivery">When Pi is busy</label>
        <select id="delivery">
          <option value="followUp" selected>Queue after current work</option>
          <option value="steer">Steer after current tool calls</option>
        </select>
        <button id="send" type="submit">Send</button>
      </div>
    </form>
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>`;

export const PAGE_CSS = `:root {
  color-scheme: dark;
  --bg: #0b1020;
  --panel: #141b31;
  --panel-2: #1b2542;
  --border: #2a385d;
  --text: #e9edff;
  --muted: #9daaca;
  --accent: #73a5ff;
  --success: #5fd6a8;
  --warning: #ffc469;
  --danger: #ff8295;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; background: radial-gradient(circle at top, #18264c 0, var(--bg) 42rem); color: var(--text); }
button, textarea, select, input { font: inherit; }
button, select, textarea, input { border-radius: 10px; }
button { cursor: pointer; border: 0; background: var(--accent); color: #081126; font-weight: 750; padding: .7rem 1rem; }
button:disabled { cursor: wait; opacity: .55; }
textarea, select, input[type="text"] { border: 1px solid var(--border); background: #0e152a; color: var(--text); padding: .7rem; }
textarea:focus, select:focus, input:focus, button:focus { outline: 3px solid color-mix(in srgb, var(--accent) 60%, transparent); outline-offset: 2px; }

.shell { width: min(900px, 100%); margin: 0 auto; padding: max(1rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom)); min-height: 100dvh; display: flex; flex-direction: column; gap: 1rem; }
header { position: sticky; top: 0; z-index: 5; display: flex; align-items: start; justify-content: space-between; gap: 1rem; padding: .7rem .25rem; background: linear-gradient(180deg, var(--bg) 80%, transparent); }
.eyebrow { margin: 0 0 .15rem; color: var(--accent); font-size: .72rem; font-weight: 800; letter-spacing: .14em; }
h1 { margin: 0; font-size: clamp(1.25rem, 5vw, 1.7rem); }
.connection { margin: .2rem 0 0; font-size: .85rem; color: var(--muted); text-align: right; }
.connection.ok { color: var(--success); }
.connection.warn { color: var(--warning); }
.connection.error { color: var(--danger); }

.timeline-toolbar { position: sticky; top: 4.9rem; z-index: 4; align-self: flex-start; display: flex; gap: .35rem; padding: .35rem; border: 1px solid var(--border); border-radius: 999px; background: color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter: blur(12px); }
.timeline-filter { padding: .45rem .7rem; border: 1px solid transparent; border-radius: 999px; background: transparent; color: var(--muted); font-size: .78rem; font-weight: 750; }
.timeline-filter.active { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: #20365e; color: var(--text); }
.messages { flex: 1 1 auto; display: flex; min-height: 20rem; flex-direction: column; gap: .75rem; overflow-wrap: anywhere; }
.timeline-item.filtered-out { display: none !important; }
.message { max-width: min(88%, 43rem); padding: .8rem .9rem; border: 1px solid var(--border); border-radius: 14px; background: var(--panel); box-shadow: 0 8px 20px #00000020; }
.message.user { align-self: flex-end; background: #1d365f; border-color: #3b639b; }
.message.assistant { align-self: flex-start; }
.message .role { display: block; margin-bottom: .35rem; color: var(--muted); font-size: .72rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.message pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 0; }
.empty { color: var(--muted); padding: 2rem .25rem; text-align: center; }

.activity { width: min(100%, 48rem); align-self: stretch; padding: .8rem .9rem; border: 1px solid #34476f; border-left: 4px solid var(--accent); border-radius: 12px; background: #10182c; box-shadow: 0 6px 18px #0000001c; }
.activity.command { border-left-color: var(--accent); }
.activity.edit { border-left-color: #b792ff; }
.activity.subagent { border-left-color: var(--warning); background: #1b1b2d; }
.activity.failed { border-color: color-mix(in srgb, var(--danger) 70%, var(--border)); border-left-color: var(--danger); }
.activity-head { display: flex; justify-content: space-between; gap: .7rem; align-items: flex-start; }
.activity-title { margin: 0; font-size: .94rem; line-height: 1.35; }
.activity-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .3rem; }
.activity-badge { padding: .18rem .42rem; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); font-size: .66rem; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap; }
.activity-badge.running { color: var(--warning); }
.activity-badge.done { color: var(--success); }
.activity-badge.failed { color: var(--danger); }
.activity-detail, .activity-path { margin: .45rem 0 0; color: var(--muted); font-size: .82rem; white-space: pre-wrap; }
.activity-path code { color: #c4d7ff; }
.activity-command { margin: .65rem 0 0; padding: .65rem .75rem; overflow-x: auto; border: 1px solid #2e4269; border-radius: 9px; background: #090f1e; color: #dce7ff; font: .78rem/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.activity details { margin-top: .6rem; border-top: 1px solid #293858; padding-top: .5rem; }
.activity summary { cursor: pointer; color: var(--accent); font-size: .8rem; font-weight: 750; }
.activity-diff, .activity-task { max-height: 28rem; margin: .55rem 0 0; padding: .65rem .75rem; overflow: auto; border-radius: 8px; background: #080d19; color: var(--muted); font: .75rem/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre; }
.diff-line { display: block; min-width: max-content; }
.diff-line.add { color: #81e6b8; background: #14332780; }
.diff-line.remove { color: #ff9bac; background: #3a172080; }
.diff-line.hunk { color: #a9c7ff; }

.notice, .question { border-radius: 14px; border: 1px solid var(--border); background: var(--panel); padding: 1rem; }
.notice { border-color: color-mix(in srgb, var(--danger) 55%, var(--border)); color: #ffd8df; }
.question { align-self: flex-start; max-width: min(88%, 43rem); border-color: color-mix(in srgb, var(--warning) 65%, var(--border)); background: #2a2632; }
.question.answered { border-color: color-mix(in srgb, var(--success) 55%, var(--border)); background: #172b2d; }
.question h2 { margin: 0 0 .35rem; font-size: 1.05rem; }
.question .question-state { margin: .8rem 0 0; color: var(--success); font-size: .9rem; }
.question .context { color: var(--muted); white-space: pre-wrap; margin: .5rem 0 .8rem; }
.question .options { display: grid; gap: .55rem; margin: .75rem 0; }
.option { display: flex; gap: .65rem; align-items: start; padding: .7rem; border: 1px solid var(--border); border-radius: 10px; background: #151629; }
.option input { margin-top: .2rem; accent-color: var(--accent); }
.option strong, .option small { display: block; }
.option small { color: var(--muted); margin-top: .2rem; }
.question label.field { display: grid; gap: .35rem; color: var(--muted); font-size: .85rem; margin: .75rem 0; }
.question textarea, .question input[type="text"] { width: 100%; min-height: 3.25rem; resize: vertical; }
.question .answer-actions { display: flex; justify-content: flex-end; gap: .75rem; margin-top: .85rem; }

.composer { position: sticky; bottom: 0; display: grid; gap: .65rem; padding-top: .5rem; background: linear-gradient(transparent, var(--bg) 16%); }
.composer textarea { width: 100%; min-height: 5.5rem; resize: vertical; }
.composer-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: .55rem; }
.delivery-label { color: var(--muted); font-size: .82rem; }
.hidden { display: none; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@media (max-width: 540px) {
  .shell { padding-inline: .7rem; }
  header { align-items: center; }
  .connection { max-width: 9rem; }
  .timeline-toolbar { top: 4.5rem; max-width: 100%; overflow-x: auto; }
  .timeline-filter { white-space: nowrap; }
  .message { max-width: 94%; }
  .activity-head { display: grid; }
  .activity-badges { justify-content: flex-start; }
  .composer-actions { justify-content: stretch; }
  .delivery-label { width: 100%; }
  .composer select { flex: 1; min-width: 0; }
}
`;

export const PAGE_JS = String.raw`(() => {
  "use strict";

  const clientStorageKey = "pi-anywhere-client-token";
  const pairStorageKey = "pi-anywhere-pair-token";
  const messages = document.getElementById("messages");
  const connection = document.getElementById("connection");
  const pairingError = document.getElementById("pairing-error");
  const timelineFilters = document.getElementById("timeline-filters");
  const composer = document.getElementById("composer");
  const messageInput = document.getElementById("message-input");
  const delivery = document.getElementById("delivery");
  const sendButton = document.getElementById("send");

  // Keep the paired-device credential through browser restarts. It is still
  // scoped to this origin and expires server-side when Anywhere stops.
  let clientToken = localStorage.getItem(clientStorageKey) || "";
  let cursor = 0;
  let activeQuestionId = "";
  let activeQuestionCard = null;
  const completedQuestionIds = new Set();
  const renderedMessages = new Map();
  const renderedActivities = new Map();
  const activityStates = new Map();
  let timelineFilter = "all";

  function setConnection(text, kind) {
    connection.textContent = text;
    connection.className = "connection" + (kind ? " " + kind : "");
  }

  function showPairingError(text) {
    pairingError.textContent = text;
    pairingError.classList.remove("hidden");
    composer.classList.add("hidden");
  }

  function getFragmentPairToken() {
    const token = window.location.hash.replace(/^#/, "").trim();
    if (!token) return "";
    // Try a newly supplied bootstrap secret first, but retain a valid stored
    // device credential if this is merely an old bookmarked pairing URL.
    sessionStorage.setItem(pairStorageKey, token);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return token;
  }

  async function rawRequest(path, options, token) {
    const headers = new Headers((options && options.headers) || {});
    headers.set("Authorization", "Bearer " + token);
    if (options && options.body) headers.set("Content-Type", "application/json");
    const response = await fetch(path, Object.assign({}, options || {}, { headers: headers, cache: "no-store" }));
    const body = await response.json().catch(() => ({ error: "The server returned an invalid response." }));
    if (!response.ok) throw new Error(body.error || "Request failed.");
    return body;
  }

  async function pair() {
    const pairToken = sessionStorage.getItem(pairStorageKey) || getFragmentPairToken();
    if (!pairToken) {
      if (clientToken) return true;
      showPairingError("This page needs a fresh /Anywhere pairing link. Run /Anywhere pair in Pi, then open the new link on this phone.");
      return false;
    }
    setConnection("Pairing this phone…", "warn");
    try {
      const body = await rawRequest("/api/pair", { method: "POST", body: "{}" }, pairToken);
      clientToken = body.token || "";
      if (!clientToken) throw new Error("Pairing did not return a device token.");
      localStorage.setItem(clientStorageKey, clientToken);
      sessionStorage.removeItem(pairStorageKey);
      return true;
    } catch (error) {
      sessionStorage.removeItem(pairStorageKey);
      // An old, consumed pairing URL is harmless when this device is already
      // paired: retain the remembered device credential and reconnect.
      if (clientToken) return true;
      showPairingError(error instanceof Error ? error.message : "Pairing failed. Run /Anywhere pair for a new link.");
      return false;
    }
  }

  async function api(path, options) {
    if (!clientToken) throw new Error("This phone is not paired.");
    return rawRequest(path, options, clientToken);
  }

  function scrollMessages() {
    window.requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
  }

  function ensureEmptyState() {
    const empty = messages.querySelector(".empty");
    if (empty) empty.remove();
  }

  function applyTimelineFilter(node) {
    if (!node || !node.classList.contains("timeline-item")) return;
    const visible = timelineFilter === "all" || node.dataset.timelineKind === timelineFilter || node.dataset.timelineKind === "question";
    node.classList.toggle("filtered-out", !visible);
  }

  function markTimelineItem(node, kind) {
    node.classList.add("timeline-item");
    node.dataset.timelineKind = kind;
    applyTimelineFilter(node);
  }

  function setTimelineFilter(next) {
    timelineFilter = next;
    timelineFilters.querySelectorAll(".timeline-filter").forEach((button) => {
      const active = button.dataset.filter === next;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    messages.querySelectorAll(".timeline-item").forEach(applyTimelineFilter);
  }

  function makeMessage(id, role) {
    let node = renderedMessages.get(id);
    if (node) return node;
    ensureEmptyState();
    node = document.createElement("article");
    node.className = "message " + role;
    node.dataset.messageId = id;
    markTimelineItem(node, "chat");
    const label = document.createElement("span");
    label.className = "role";
    label.textContent = role === "user" ? "You" : "Pi";
    const text = document.createElement("pre");
    text.className = "text";
    node.append(label, text);
    messages.append(node);
    renderedMessages.set(id, node);
    return node;
  }

  function setMessage(event) {
    if (!event || !event.id || !event.role) return;
    const node = makeMessage(String(event.id), event.role);
    const text = node.querySelector(".text");
    text.textContent = event.text || "";
    scrollMessages();
  }

  function appendDelta(event) {
    if (!event || !event.id) return;
    const node = makeMessage(String(event.id), "assistant");
    const text = node.querySelector(".text");
    text.textContent += event.text || "";
    scrollMessages();
  }

  function renderDiff(pre, diff) {
    pre.replaceChildren();
    String(diff || "").split("\n").forEach((line) => {
      const row = document.createElement("span");
      row.className = "diff-line";
      if (line.startsWith("+") && !line.startsWith("+++")) row.classList.add("add");
      else if (line.startsWith("-") && !line.startsWith("---")) row.classList.add("remove");
      else if (line.startsWith("@@")) row.classList.add("hunk");
      row.textContent = line;
      pre.append(row, document.createTextNode("\n"));
    });
  }

  function detailBlock(label, value, className) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = label;
    const pre = document.createElement("pre");
    pre.className = className;
    pre.textContent = value;
    details.append(summary, pre);
    return details;
  }

  function renderActivity(event) {
    const incoming = event && event.activity;
    if (!incoming || !incoming.id) return;
    ensureEmptyState();
    const id = String(incoming.id);
    const activity = Object.assign({}, activityStates.get(id) || {}, incoming);
    activityStates.set(id, activity);

    let node = renderedActivities.get(id);
    if (!node) {
      node = document.createElement("article");
      node.dataset.activityId = id;
      markTimelineItem(node, "activity");
      messages.append(node);
      renderedActivities.set(id, node);
    }

    const state = activity.phase === "end" ? (activity.isError ? "failed" : "done") : "running";
    node.className = "activity timeline-item " + (activity.category || "tool") + " " + state;
    node.dataset.timelineKind = "activity";
    applyTimelineFilter(node);
    node.replaceChildren();

    const head = document.createElement("div");
    head.className = "activity-head";
    const title = document.createElement("h2");
    title.className = "activity-title";
    title.textContent = activity.label || activity.toolName || "Tool activity";
    const badges = document.createElement("div");
    badges.className = "activity-badges";
    const source = document.createElement("span");
    source.className = "activity-badge";
    source.textContent = activity.source === "subagent" ? (activity.agent || "subagent") : "main Pi";
    const category = document.createElement("span");
    category.className = "activity-badge";
    category.textContent = activity.category || "tool";
    const status = document.createElement("span");
    status.className = "activity-badge " + state;
    status.textContent = state;
    badges.append(source, category, status);
    head.append(title, badges);
    node.append(head);

    if (activity.detail) {
      const detail = document.createElement("p");
      detail.className = "activity-detail";
      detail.textContent = activity.detail;
      node.append(detail);
    }
    if (activity.path) {
      const path = document.createElement("p");
      path.className = "activity-path";
      const code = document.createElement("code");
      code.textContent = activity.path;
      path.append(code);
      node.append(path);
    }
    if (activity.command) {
      const command = document.createElement("pre");
      command.className = "activity-command";
      command.textContent = activity.command;
      node.append(command);
    }
    if (activity.task) node.append(detailBlock("Delegated task", activity.task, "activity-task"));
    if (activity.diff) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "View change preview";
      const diff = document.createElement("pre");
      diff.className = "activity-diff";
      renderDiff(diff, activity.diff);
      details.append(summary, diff);
      node.append(details);
    }
    scrollMessages();
  }

  function completeQuestion(note) {
    if (!activeQuestionCard) return;
    const card = activeQuestionCard;
    card.querySelectorAll("input, textarea, button").forEach((field) => { field.disabled = true; });
    const state = document.createElement("p");
    state.className = "question-state";
    state.textContent = note;
    card.append(state);
    card.classList.add("answered");
    completedQuestionIds.add(activeQuestionId);
    activeQuestionId = "";
    activeQuestionCard = null;
  }

  function renderQuestion(question) {
    if (!question) {
      if (activeQuestionCard) completeQuestion("Question completed.");
      return;
    }
    if (activeQuestionId === question.id || completedQuestionIds.has(question.id)) return;
    if (activeQuestionCard) completeQuestion("A newer question replaced this one.");
    activeQuestionId = question.id;
    const questionCard = document.createElement("article");
    questionCard.className = "question";
    questionCard.dataset.questionId = question.id;
    markTimelineItem(questionCard, "question");
    activeQuestionCard = questionCard;
    ensureEmptyState();
    messages.append(questionCard);

    const title = document.createElement("h2");
    title.textContent = "Pi needs your answer";
    const prompt = document.createElement("p");
    prompt.textContent = question.question || "Question";
    questionCard.append(title, prompt);

    if (question.context) {
      const context = document.createElement("p");
      context.className = "context";
      context.textContent = question.context;
      questionCard.append(context);
    }

    const choices = [];
    if (Array.isArray(question.options) && question.options.length > 0) {
      const options = document.createElement("div");
      options.className = "options";
      const type = question.allowMultiple ? "checkbox" : "radio";
      for (const option of question.options) {
        const label = document.createElement("label");
        label.className = "option";
        const input = document.createElement("input");
        input.type = type;
        input.name = "anywhere-option";
        input.value = option.title;
        const copy = document.createElement("span");
        const strong = document.createElement("strong");
        strong.textContent = option.title;
        copy.append(strong);
        if (option.description) {
          const small = document.createElement("small");
          small.textContent = option.description;
          copy.append(small);
        }
        label.append(input, copy);
        options.append(label);
        choices.push(input);
      }
      questionCard.append(options);
    }

    let freeform;
    if (question.allowFreeform) {
      const label = document.createElement("label");
      label.className = "field";
      label.textContent = "Or write a response";
      freeform = document.createElement("textarea");
      freeform.maxLength = 12000;
      freeform.rows = 3;
      freeform.placeholder = "Your answer…";
      label.append(freeform);
      questionCard.append(label);
    }

    let comment;
    if (question.allowComment) {
      const label = document.createElement("label");
      label.className = "field";
      label.textContent = "Optional comment";
      comment = document.createElement("textarea");
      comment.maxLength = 12000;
      comment.rows = 2;
      comment.placeholder = "Extra context for Pi…";
      label.append(comment);
      questionCard.append(label);
    }

    const actions = document.createElement("div");
    actions.className = "answer-actions";
    const answerButton = document.createElement("button");
    answerButton.type = "button";
    answerButton.textContent = "Submit answer";
    answerButton.addEventListener("click", async () => {
      const custom = freeform ? freeform.value.trim() : "";
      const selected = choices.filter((choice) => choice.checked).map((choice) => choice.value);
      let answer;
      if (custom) {
        answer = { kind: "freeform", text: custom };
      } else if (selected.length > 0) {
        answer = { kind: "selection", selections: selected, comment: comment ? comment.value.trim() : "" };
      } else {
        setConnection("Select an option or write an answer first.", "warn");
        return;
      }
      answerButton.disabled = true;
      try {
        await api("/api/questions/" + encodeURIComponent(question.id) + "/answer", {
          method: "POST",
          body: JSON.stringify(answer),
        });
        setConnection("Answer sent to Pi.", "ok");
        completeQuestion("Answer sent to Pi.");
      } catch (error) {
        setConnection(error instanceof Error ? error.message : "Could not send that answer.", "error");
        answerButton.disabled = false;
      }
    });
    actions.append(answerButton);
    questionCard.append(actions);
    scrollMessages();
  }

  function applyState(state) {
    for (const event of state.events || []) {
      if (event.kind === "message") setMessage(event);
      if (event.kind === "message_delta") appendDelta(event);
      if (event.kind === "activity") renderActivity(event);
      if (event.kind === "status" && event.text) setConnection(event.text, event.level || "");
    }
    if (typeof state.cursor === "number") cursor = state.cursor;
    renderQuestion(state.question || null);
    if (state.question) setConnection("Pi is waiting for your answer.", "warn");
    else if (state.agent) setConnection("Pi is working…", "warn");
    else setConnection("Connected", "ok");
  }

  async function poll() {
    try {
      const state = await api("/api/state?since=" + encodeURIComponent(String(cursor)), { method: "GET" });
      applyState(state);
      window.setTimeout(poll, state.agent || state.question ? 650 : 1300);
    } catch (error) {
      setConnection(error instanceof Error ? error.message : "Connection lost. Retrying…", "error");
      window.setTimeout(poll, 2500);
    }
  }

  timelineFilters.addEventListener("click", (event) => {
    const button = event.target.closest(".timeline-filter");
    if (button && button.dataset.filter) setTimelineFilter(button.dataset.filter);
  });

  composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = messageInput.value.trim();
    if (!text) return;
    sendButton.disabled = true;
    try {
      await api("/api/messages", {
        method: "POST",
        body: JSON.stringify({ text: text, delivery: delivery.value }),
      });
      messageInput.value = "";
      setConnection("Message sent to Pi.", "ok");
    } catch (error) {
      setConnection(error instanceof Error ? error.message : "Could not send that message.", "error");
    } finally {
      sendButton.disabled = false;
      messageInput.focus();
    }
  });

  async function start() {
    getFragmentPairToken();
    if (!(await pair())) return;
    messages.append(Object.assign(document.createElement("p"), { className: "empty", textContent: "Messages from this phone session will appear here." }));
    setConnection("Connected", "ok");
    poll();
  }

  start().catch((error) => showPairingError(error instanceof Error ? error.message : "Could not start Pi Anywhere."));
})();`;
