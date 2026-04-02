const state = {
  mode: "history",
  agents: [],
  sessions: [],
  historyAssistants: [],
  sessionMessageFallbacks: {},
  selectedAgentId: "",
  selectedSessionId: "",
  selectedSession: null,
  selectedHistoryAssistantId: "",
  selectedHistoryTopicId: "",
  selectedHistoryTopic: null,
  sending: false,
};

const HISTORY_REFRESH_INTERVAL_MS = 2500;
let historyRefreshTimer = null;
let historyRefreshInFlight = false;
let historyTreeRequestToken = 0;
let historyTopicRequestToken = 0;
let agentListRequestToken = 0;
let sessionListRequestToken = 0;
let sessionDetailRequestToken = 0;

const els = {
  shell: document.querySelector("#shell"),
  assistantPanel: document.querySelector("#assistantPanel"),
  sidebarPanel: document.querySelector(".sidebar"),
  conversationPanel: document.querySelector(".conversation"),
  assistantList: document.querySelector("#assistantList"),
  historyControls: document.querySelector("#historyControls"),
  listLabel: document.querySelector("#listLabel"),
  listTitle: document.querySelector("#listTitle"),
  healthBadge: document.querySelector("#healthBadge"),
  refreshAllButton: document.querySelector("#refreshAllButton"),
  modeSwitch: document.querySelector("#modeSwitch"),
  agentControls: document.querySelector("#agentControls"),
  agentSelect: document.querySelector("#agentSelect"),
  newSessionButton: document.querySelector("#newSessionButton"),
  sessionList: document.querySelector("#sessionList"),
  conversationLabel: document.querySelector("#conversationLabel"),
  conversationTitle: document.querySelector("#conversationTitle"),
  refreshSessionButton: document.querySelector("#refreshSessionButton"),
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  composerInput: document.querySelector("#composerInput"),
  composerHint: document.querySelector("#composerHint"),
  sendButton: document.querySelector("#sendButton"),
  backButton: document.querySelector("#backButton"),
};

const SCROLL_BOTTOM_THRESHOLD = 72;

function enterConversationFocus() {
  if (!isCompactLayout()) return;
  els.shell.classList.add("conversation-focus");
  document.body.classList.add("conversation-focus");
}

function exitConversationFocus() {
  els.shell.classList.remove("conversation-focus");
  document.body.classList.remove("conversation-focus");
}

els.backButton.addEventListener("click", () => {
  exitConversationFocus();
});

function setStatus(text, kind = "") {
  els.healthBadge.textContent = text;
  els.healthBadge.className = `status-pill ${kind}`.trim();
}

function dateValue(value) {
  const parsed = new Date(value ?? 0).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatDate(value) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function roleLabel(role) {
  return (
    {
      user: "我",
      assistant: "助手",
      system: "系统",
      tool: "工具",
    }[role] ?? role
  );
}

function createTextMessage(role, text) {
  return {
    role,
    content: {
      blocks: [{ content: String(text ?? "") }],
    },
  };
}

function getSessionFallbackMessages(sessionId) {
  return Array.isArray(state.sessionMessageFallbacks[sessionId]) ? state.sessionMessageFallbacks[sessionId] : [];
}

function setSessionFallbackMessages(sessionId, messages) {
  if (!sessionId) return;
  if (Array.isArray(messages) && messages.length) {
    state.sessionMessageFallbacks[sessionId] = messages;
    return;
  }
  delete state.sessionMessageFallbacks[sessionId];
}

function isCompactLayout() {
  return window.matchMedia("(max-width: 980px)").matches;
}

function scrollPanelIntoView(panel) {
  if (!panel || !isCompactLayout()) return;
  window.requestAnimationFrame(() => {
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function captureMessageScrollState() {
  const { scrollTop, scrollHeight, clientHeight } = els.messages;
  const gapFromBottom = Math.max(0, scrollHeight - clientHeight - scrollTop);
  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    gapFromBottom,
    nearBottom: gapFromBottom <= SCROLL_BOTTOM_THRESHOLD,
  };
}

function restoreMessageScrollState(snapshot, { forceTop = false, forceBottom = false } = {}) {
  if (forceTop) {
    els.messages.scrollTop = 0;
    return;
  }

  if (forceBottom || !snapshot || snapshot.nearBottom) {
    els.messages.scrollTop = els.messages.scrollHeight;
    return;
  }

  const nextTop = Math.max(0, els.messages.scrollHeight - els.messages.clientHeight - snapshot.gapFromBottom);
  els.messages.scrollTop = nextTop;
}

function setConversationHeader(label, title) {
  els.conversationLabel.textContent = label;
  els.conversationTitle.textContent = title;
}

function updateActionAvailability() {
  const agentReady = Boolean(state.agents.length && state.selectedAgentId);
  const historyReady = Boolean(state.selectedHistoryTopic);

  if (state.mode === "history") {
    els.sendButton.textContent = "续聊";
    els.sendButton.disabled = state.sending || !historyReady;
    els.composerInput.disabled = state.sending || !historyReady;
    els.composerInput.placeholder = state.selectedHistoryTopic
      ? "基于这个历史话题继续聊"
      : "先打开一个历史话题，再继续聊";
    els.composerHint.textContent = historyReady
      ? "会直接驱动桌面 Cherry 在这个真实话题里发送，手机和电脑看到的是同一份记录。"
      : "先点开一个具体话题，再继续聊。";
  } else {
    els.sendButton.textContent = "发送";
    els.sendButton.disabled = state.sending || !agentReady;
    els.composerInput.disabled = state.sending || !agentReady;
    els.composerInput.placeholder = "给当前 Cherry 会话继续发消息";
    els.composerHint.textContent = agentReady
      ? "如果没选会话，发送时会自动创建一个新会话。"
      : "当前没有可用 agent，只能浏览历史对话。";
  }

  els.agentSelect.disabled = state.sending || !agentReady;
  els.newSessionButton.disabled = state.sending || !agentReady;
  els.refreshAllButton.disabled = state.sending;
  els.refreshSessionButton.disabled = state.sending;
  for (const button of els.modeSwitch.querySelectorAll(".mode-button")) {
    button.disabled = state.sending;
  }
  for (const button of els.assistantList.querySelectorAll("button")) {
    button.disabled = state.sending;
  }
  for (const button of els.sessionList.querySelectorAll("button")) {
    button.disabled = state.sending;
  }
}

function updateModeUI() {
  for (const button of els.modeSwitch.querySelectorAll(".mode-button")) {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  }

  els.shell.className = `shell ${state.mode}-mode`;
  els.assistantPanel.classList.toggle("hidden", state.mode !== "history");
  els.historyControls.classList.toggle("hidden", state.mode !== "history");
  els.agentControls.classList.toggle("hidden", state.mode !== "agents");
  els.composer.classList.remove("hidden");
  els.refreshSessionButton.textContent = state.mode === "history" ? "刷新当前话题" : "刷新当前";
  updateActionAvailability();
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text || `${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error || parsed?.message || message;
    } catch {}
    throw new Error(message);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function refreshHealth() {
  try {
    const health = await api("/health");
    setStatus(health.status === "ok" ? "已连接" : "异常", health.status === "ok" ? "ok" : "bad");
  } catch (error) {
    console.error(error);
    setStatus("不可用", "bad");
  }
}

function getSelectedAgent() {
  return state.agents.find((agent) => agent.id === state.selectedAgentId) ?? null;
}

function getSelectedHistoryAssistant() {
  return state.historyAssistants.find((assistant) => assistant.id === state.selectedHistoryAssistantId) ?? null;
}

function sortedTopics(assistant) {
  return [...(assistant?.topics ?? [])].sort(
    (left, right) => dateValue(right.updatedAt ?? right.createdAt) - dateValue(left.updatedAt ?? left.createdAt),
  );
}

function sessionLabel(session) {
  return session.name?.trim() || "未命名会话";
}

function normalizeSessions(sessions) {
  return [...sessions].sort(
    (left, right) => dateValue(right.updated_at ?? right.created_at) - dateValue(left.updated_at ?? left.created_at),
  );
}

function renderConversationEmpty(text) {
  els.messages.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.innerHTML = `<p>${escapeHtml(text)}</p>`;
  els.messages.append(empty);
}

function renderMessageBubble(role, text, meta = "", streaming = false) {
  const article = document.createElement("article");
  article.className = `message ${role}`.trim();
  article.innerHTML = `
    <span class="message-role">${escapeHtml(roleLabel(role))}${meta ? ` · ${escapeHtml(meta)}` : ""}${
      streaming ? " · streaming" : ""
    }</span>
    <pre class="message-content">${escapeHtml(text || "")}</pre>
  `;
  return article;
}

function renderAssistantList() {
  els.assistantList.innerHTML = "";

  if (!state.historyAssistants.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state compact";
    empty.innerHTML = "<p>还没有读到 Cherry 里的助手。</p>";
    els.assistantList.append(empty);
    return;
  }

  for (const assistant of state.historyAssistants) {
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = state.sending;
    button.className = `assistant-card ${assistant.id === state.selectedHistoryAssistantId ? "active" : ""}`.trim();
    button.innerHTML = `
      <span class="assistant-emoji">${escapeHtml(assistant.emoji || "😀")}</span>
      <span class="assistant-copy">
        <span class="assistant-name">${escapeHtml(assistant.name || "未命名助手")}</span>
        <span class="assistant-meta">${escapeHtml(String(assistant.topics?.length ?? 0))} 个话题</span>
      </span>
    `;
    button.addEventListener("click", async () => {
      if (state.sending) return;
      if (assistant.id === state.selectedHistoryAssistantId) return;
      state.selectedHistoryAssistantId = assistant.id;
      state.selectedHistoryTopic = null;
      state.selectedHistoryTopicId = sortedTopics(assistant)[0]?.id ?? "";
      renderAssistantList();
      renderHistoryTopics();
      updateActionAvailability();
      scrollPanelIntoView(els.sidebarPanel);
      if (isCompactLayout()) {
        showHistoryHeader();
        renderHistoryMessages();
        return;
      }
      if (state.selectedHistoryTopicId) {
        await loadHistoryTopic(state.selectedHistoryTopicId);
      } else {
        showHistoryHeader();
        renderHistoryMessages();
      }
    });
    els.assistantList.append(button);
  }
}

function renderHistoryTopics() {
  const assistant = getSelectedHistoryAssistant();
  const topics = sortedTopics(assistant);

  els.listLabel.textContent = assistant ? `助手 · ${assistant.name}` : "Cherry History";
  els.listTitle.textContent = "话题";
  els.sessionList.innerHTML = "";

  if (!assistant) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<p>先选择一个助手。</p>";
    els.sessionList.append(empty);
    return;
  }

  if (!topics.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<p>这个助手下面还没有话题。</p>";
    els.sessionList.append(empty);
    return;
  }

  for (const topic of topics) {
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = state.sending;
    button.className = `session-card ${topic.id === state.selectedHistoryTopicId ? "active" : ""}`.trim();
    button.innerHTML = `
      <span class="session-title">${escapeHtml(topic.name || "未命名话题")}</span>
      <span class="session-meta">${escapeHtml(formatDate(topic.updatedAt || topic.createdAt))} · ${escapeHtml(
        String(topic.messageCount ?? 0),
      )} 条消息</span>
      <span class="session-meta">${escapeHtml(topic.preview || "暂无摘要")}</span>
    `;
    button.addEventListener("click", () => {
      if (state.sending) return;
      loadHistoryTopic(topic.id);
    });
    els.sessionList.append(button);
  }
}

function renderAgentOptions() {
  els.agentSelect.innerHTML = "";

  if (!state.agents.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无 agent";
    els.agentSelect.append(option);
    els.agentSelect.disabled = true;
    updateActionAvailability();
    return;
  }

  els.agentSelect.disabled = false;
  for (const agent of state.agents) {
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = agent.name || agent.id;
    els.agentSelect.append(option);
  }
  els.agentSelect.value = state.selectedAgentId;
  updateActionAvailability();
}

function renderSessions() {
  els.listLabel.textContent = "Cherry Agent";
  els.listTitle.textContent = "会话";
  els.sessionList.innerHTML = "";

  if (!state.agents.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<p>当前没有可用 agent。</p>";
    els.sessionList.append(empty);
    return;
  }

  if (!state.sessions.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<p>这个 agent 还没有会话。</p>";
    els.sessionList.append(empty);
    return;
  }

  for (const session of state.sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = state.sending;
    button.className = `session-card ${session.id === state.selectedSessionId ? "active" : ""}`.trim();
    button.innerHTML = `
      <span class="session-title">${escapeHtml(sessionLabel(session))}</span>
      <span class="session-meta">${escapeHtml(formatDate(session.updated_at || session.created_at))}</span>
    `;
    button.addEventListener("click", () => {
      if (state.sending) return;
      loadSession(session.id);
    });
    els.sessionList.append(button);
  }
}

function showHistoryHeader() {
  const assistant = getSelectedHistoryAssistant();
  const topic = state.selectedHistoryTopic;

  if (!assistant) {
    setConversationHeader("History", "选择一个助手");
    return;
  }

  if (!topic) {
    setConversationHeader(`${assistant.emoji || "😀"} ${assistant.name}`, "选择一个话题");
    return;
  }

  setConversationHeader(
    `${assistant.emoji || "😀"} ${assistant.name} · ${formatDate(topic.updatedAt || topic.createdAt)}`,
    topic.name || "未命名话题",
  );
}

function extractMessageText(message) {
  const blocks = message?.content?.blocks;
  if (Array.isArray(blocks) && blocks.length) {
    const text = blocks
      .map((block) => {
        if (typeof block?.content === "string") return block.content;
        if (Array.isArray(block?.content)) {
          return block.content.map((item) => item?.text || "").join("");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
    if (text) return text;
  }

  if (typeof message?.content === "string") return message.content;

  const nested = message?.content?.message?.content;
  if (typeof nested === "string") return nested;
  if (Array.isArray(nested)) {
    const text = nested.map((item) => item?.text || "").filter(Boolean).join("");
    if (text) return text;
  }

  return JSON.stringify(message?.content ?? {}, null, 2);
}

function extractStreamErrorText(payload) {
  const candidates = [
    payload?.error?.message,
    payload?.message,
    payload?.providerMetadata?.raw?.result,
    payload?.providerMetadata?.raw?.message?.content?.[0]?.text,
    payload?.rawValue?.raw?.message?.content?.[0]?.text,
  ];

  return candidates.find((value) => typeof value === "string" && value.trim())?.trim() ?? "";
}

function renderAgentMessages(extraAssistant = null, options = {}) {
  const messages = state.selectedSession?.messages ?? [];
  const scrollState = captureMessageScrollState();
  els.messages.innerHTML = "";

  if (!messages.length && !extraAssistant) {
    renderConversationEmpty("这个会话还没有消息。");
    return;
  }

  for (const message of messages) {
    els.messages.append(renderMessageBubble(message.role, extractMessageText(message)));
  }

  if (extraAssistant) {
    els.messages.append(renderMessageBubble("assistant", extraAssistant, "", true));
  }

  restoreMessageScrollState(scrollState, {
    forceBottom: options.forceBottom ?? Boolean(extraAssistant),
  });
}

function renderHistoryMessages(options = {}) {
  const topic = state.selectedHistoryTopic;
  const scrollState = captureMessageScrollState();
  els.messages.innerHTML = "";

  if (!topic) {
    renderConversationEmpty("这里会显示这个话题的旧对话内容。");
    return;
  }

  const messages = [...(topic.messages ?? [])].sort(
    (left, right) => dateValue(left.createdAt) - dateValue(right.createdAt),
  );

  if (!messages.length) {
    renderConversationEmpty("这个话题还没有可显示的消息。");
    return;
  }

  for (const message of messages) {
    const text = String(message.content || "").trim() || "（这条消息没有可解析的文本块）";
    els.messages.append(renderMessageBubble(message.role, text, formatDate(message.createdAt)));
  }

  restoreMessageScrollState(scrollState, {
    forceTop: options.forceTop ?? false,
    forceBottom: options.forceBottom ?? false,
  });
  updateActionAvailability();
}

function pickDefaultHistorySelection() {
  if (!state.historyAssistants.length) {
    state.selectedHistoryAssistantId = "";
    state.selectedHistoryTopicId = "";
    state.selectedHistoryTopic = null;
    return;
  }

  if (!state.historyAssistants.some((assistant) => assistant.id === state.selectedHistoryAssistantId)) {
    const preferred = state.historyAssistants
      .flatMap((assistant) =>
        sortedTopics(assistant).map((topic) => ({
          assistantId: assistant.id,
          topicId: topic.id,
          messageCount: topic.messageCount ?? 0,
          updatedAt: topic.updatedAt ?? topic.createdAt,
        })),
      )
      .sort((left, right) => {
        if ((right.messageCount > 0) !== (left.messageCount > 0)) {
          return Number(right.messageCount > 0) - Number(left.messageCount > 0);
        }
        return dateValue(right.updatedAt) - dateValue(left.updatedAt);
      })[0];

    state.selectedHistoryAssistantId = preferred?.assistantId ?? state.historyAssistants[0].id;
    state.selectedHistoryTopicId = preferred?.topicId ?? "";
    state.selectedHistoryTopic = null;
  }

  const assistant = getSelectedHistoryAssistant();
  const topics = sortedTopics(assistant);
  if (!topics.some((topic) => topic.id === state.selectedHistoryTopicId)) {
    state.selectedHistoryTopicId = topics[0]?.id ?? "";
    state.selectedHistoryTopic = null;
  }
}

async function loadHistoryTree() {
  const requestId = ++historyTreeRequestToken;
  const data = await api("/cherry/history/tree");
  if (requestId !== historyTreeRequestToken) return data;
  state.historyAssistants = data.assistants ?? [];
  pickDefaultHistorySelection();
  renderAssistantList();
  renderHistoryTopics();
}

async function loadHistoryTopic(topicId) {
  return loadHistoryTopicWithOptions(topicId);
}

async function loadHistoryTopicWithOptions(topicId, options = {}) {
  if (!topicId) {
    historyTopicRequestToken += 1;
    state.selectedHistoryTopicId = "";
    state.selectedHistoryTopic = null;
    renderHistoryTopics();
    showHistoryHeader();
    renderHistoryMessages({ forceTop: true });
    return;
  }

  state.selectedHistoryTopicId = topicId;
  renderHistoryTopics();
  showHistoryHeader();
  if (!options.silent) {
    renderConversationEmpty("正在读取这个话题的历史正文。");
  }

  const requestId = ++historyTopicRequestToken;
  const data = await api(`/cherry/history/topics/${encodeURIComponent(topicId)}`);
  if (requestId !== historyTopicRequestToken || state.selectedHistoryTopicId !== topicId) {
    return data;
  }
  state.selectedHistoryAssistantId = data.assistantId || state.selectedHistoryAssistantId;
  state.selectedHistoryTopic = data;
  renderAssistantList();
  renderHistoryTopics();
  showHistoryHeader();
  renderHistoryMessages({
    forceTop: options.forceTop ?? !options.silent,
    forceBottom: options.forceBottom ?? false,
  });
  updateActionAvailability();
  if (!options.silent) {
    enterConversationFocus();
    scrollPanelIntoView(els.conversationPanel);
  }
  return data;
}

async function refreshSelectedHistoryTopic(options = {}) {
  if (!state.selectedHistoryTopicId) return null;
  const topicId = state.selectedHistoryTopicId;
  const requestId = ++historyTopicRequestToken;

  const [tree, topic] = await Promise.all([
    api("/cherry/history/tree"),
    api(`/cherry/history/topics/${encodeURIComponent(topicId)}`),
  ]);
  if (requestId !== historyTopicRequestToken || state.selectedHistoryTopicId !== topicId) {
    return topic;
  }

  state.historyAssistants = tree.assistants ?? [];
  state.selectedHistoryAssistantId = topic.assistantId || state.selectedHistoryAssistantId;
  state.selectedHistoryTopic = topic;
  pickDefaultHistorySelection();
  renderAssistantList();
  renderHistoryTopics();
  showHistoryHeader();
  renderHistoryMessages({
    forceTop: options.forceTop ?? false,
    forceBottom: options.forceBottom ?? false,
  });
  return topic;
}

function ensureHistoryRefreshLoop() {
  if (historyRefreshTimer) return;
  historyRefreshTimer = window.setInterval(async () => {
    if (historyRefreshInFlight || document.hidden) return;
    if (state.mode !== "history" || !state.selectedHistoryTopicId || state.sending) return;

    historyRefreshInFlight = true;
    try {
      await refreshSelectedHistoryTopic();
    } catch (error) {
      console.debug("history refresh skipped", error);
    } finally {
      historyRefreshInFlight = false;
    }
  }, HISTORY_REFRESH_INTERVAL_MS);
}

async function loadAgents() {
  const requestId = ++agentListRequestToken;
  const data = await api("/v1/agents");
  if (requestId !== agentListRequestToken) return data;
  state.agents = data.data ?? [];

  if (!state.selectedAgentId || !state.agents.some((agent) => agent.id === state.selectedAgentId)) {
    state.selectedAgentId = state.agents[0]?.id ?? "";
  }

  renderAgentOptions();
}

async function loadSessions() {
  const requestId = ++sessionListRequestToken;
  const agentId = state.selectedAgentId;
  if (!state.selectedAgentId) {
    state.sessions = [];
    state.selectedSessionId = "";
    state.selectedSession = null;
    renderSessions();
    return;
  }

  const data = await api(`/v1/agents/${encodeURIComponent(agentId)}/sessions?limit=100`);
  if (requestId !== sessionListRequestToken || state.selectedAgentId !== agentId) {
    return data;
  }
  state.sessions = normalizeSessions(data.data ?? []);

  if (!state.sessions.some((session) => session.id === state.selectedSessionId)) {
    state.selectedSessionId = state.sessions[0]?.id ?? "";
  }

  renderSessions();
}

function showAgentHeader(session = state.selectedSession) {
  if (!session) {
    setConversationHeader("Session", "选择一个会话");
    return;
  }

  setConversationHeader(formatDate(session.updated_at || session.created_at), sessionLabel(session));
}

async function loadSession(sessionId) {
  if (!sessionId) {
    sessionDetailRequestToken += 1;
    state.selectedSessionId = "";
    state.selectedSession = null;
    renderSessions();
    showAgentHeader();
    renderAgentMessages(null, { forceBottom: true });
    return;
  }

  state.selectedSessionId = sessionId;
  renderSessions();
  const requestId = ++sessionDetailRequestToken;
  const agentId = state.selectedAgentId;

  const session = await api(
    `/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
  );
  if (
    requestId !== sessionDetailRequestToken ||
    state.selectedSessionId !== sessionId ||
    state.selectedAgentId !== agentId
  ) {
    return session;
  }
  const persistedMessages = Array.isArray(session?.messages) ? session.messages : [];
  const fallbackMessages = getSessionFallbackMessages(sessionId);
  const effectiveMessages = persistedMessages.length ? persistedMessages : fallbackMessages;

  if (persistedMessages.length) {
    setSessionFallbackMessages(sessionId, []);
  }

  state.selectedSession = effectiveMessages === persistedMessages ? session : { ...session, messages: effectiveMessages };
  showAgentHeader(state.selectedSession);
  renderAgentMessages(null, { forceBottom: true });
  updateActionAvailability();
  enterConversationFocus();
  scrollPanelIntoView(els.conversationPanel);
  return state.selectedSession;
}

async function loadAgentWorkspace() {
  try {
    await loadAgents();
    await loadSessions();
    return true;
  } catch (error) {
    console.error(error);
    state.agents = [];
    state.sessions = [];
    state.selectedAgentId = "";
    state.selectedSessionId = "";
    state.selectedSession = null;
    renderAgentOptions();
    renderSessions();
    return false;
  }
}

async function createSession(name = "") {
  const agent = getSelectedAgent();
  if (!agent) throw new Error("没有找到 agent。");

  const sessionName =
    name.trim() ||
    `手机会话 ${new Date().toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  const payload = {
    name: sessionName,
    model: agent.model,
    accessible_paths: agent.accessible_paths ?? [],
  };

  const session = await api(`/v1/agents/${encodeURIComponent(agent.id)}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  await loadSessions();
  await loadSession(session.id);
  return session;
}

function createHistoryMessage(role, text, topic) {
  return {
    id: `mobile-${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    assistantId: topic?.assistantId || state.selectedHistoryAssistantId,
    topicId: topic?.id || state.selectedHistoryTopicId,
    createdAt: new Date().toISOString(),
    status: role === "assistant" && text === "..." ? "streaming" : "success",
    content: String(text ?? ""),
  };
}

async function streamMessage(path, body, onEvent) {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
  if (!response.body) {
    throw new Error("流式响应没有可读数据。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamError = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");

    while (buffer.includes("\n\n")) {
      const splitAt = buffer.indexOf("\n\n");
      const rawEvent = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);

      const dataLines = [];
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        dataLines.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
      }
      const json = dataLines.join("\n").trim();
      if (!json) continue;
      try {
        const payload = JSON.parse(json);
        if (
          !streamError &&
          (payload?.type === "error" || (payload?.type === "finish" && payload?.providerMetadata?.raw?.is_error))
        ) {
          streamError = extractStreamErrorText(payload);
        }
        onEvent(payload);
      } catch (error) {
        console.warn("Failed to parse SSE event", error, json);
      }
    }
  }

  return { error: streamError };
}

function setSending(isSending) {
  state.sending = isSending;
  updateActionAvailability();
}

async function refreshAll() {
  await Promise.all([refreshHealth(), loadHistoryTree()]);
  await loadAgentWorkspace();

  if (state.mode === "history") {
    if (state.selectedHistoryTopicId) {
      await loadHistoryTopic(state.selectedHistoryTopicId);
    } else {
      showHistoryHeader();
      renderHistoryMessages({ forceTop: true });
    }
    return;
  }

  if (state.selectedSessionId) {
    await loadSession(state.selectedSessionId);
  } else {
    showAgentHeader();
    renderAgentMessages(null, { forceBottom: true });
  }
}

async function sendToCurrentSession(displayContent, outgoingContent = displayContent) {
  const agentId = state.selectedAgentId;
  let sessionId = "";
  let fallbackMessages = [];
  try {
    setSending(true);

    if (!state.selectedSessionId) {
      const createdSession = await createSession(displayContent.slice(0, 24));
      sessionId = createdSession.id;
    }

    sessionId ||= state.selectedSessionId;
    const existingMessages =
      state.selectedSessionId === sessionId && Array.isArray(state.selectedSession?.messages) && state.selectedSession.messages.length
        ? state.selectedSession.messages
        : getSessionFallbackMessages(sessionId);
    fallbackMessages = [...existingMessages, createTextMessage("user", displayContent)];
    state.selectedSession = {
      ...(state.selectedSession ?? {}),
      messages: fallbackMessages,
    };
    setSessionFallbackMessages(sessionId, fallbackMessages);
    els.composerInput.value = "";
    renderAgentMessages("...");

    let streamedAssistantText = "";
    let streamedErrorText = "";

    const streamResult = await streamMessage(
      `/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
      { content: outgoingContent },
      (payload) => {
        if (payload.type === "text-delta" && typeof payload.text === "string") {
          streamedAssistantText += payload.text;
          renderAgentMessages(streamedAssistantText || "...");
        }
        if (payload.type === "raw") {
          const rawText = payload?.rawValue?.raw?.message?.content?.[0]?.text;
          if (rawText && !streamedAssistantText) {
            streamedAssistantText = rawText;
            renderAgentMessages(streamedAssistantText);
          }
        }
        if (
          !streamedErrorText &&
          (payload?.type === "error" || (payload?.type === "finish" && payload?.providerMetadata?.raw?.is_error))
        ) {
          streamedErrorText = extractStreamErrorText(payload);
          if (!streamedAssistantText && streamedErrorText) {
            renderAgentMessages(`发送失败：${streamedErrorText}`);
          }
        }
      },
    );

    streamedErrorText ||= streamResult.error;

    const displayedMessages = [...fallbackMessages];
    if (streamedAssistantText) {
      displayedMessages.push(createTextMessage("assistant", streamedAssistantText));
    }
    if (streamedErrorText && (!streamedAssistantText || !streamedAssistantText.includes(streamedErrorText))) {
      displayedMessages.push(createTextMessage("system", `发送失败：${streamedErrorText}`));
    }

    setSessionFallbackMessages(sessionId, displayedMessages);
    state.selectedSession = {
      ...(state.selectedSession ?? {}),
      messages: displayedMessages,
    };
    renderAgentMessages(null, { forceBottom: true });

    const refreshedSession = await loadSession(sessionId);
    const hasPersistedMessages = Boolean(refreshedSession?.messages?.length);

    if (!hasPersistedMessages && displayedMessages.length) {
      state.selectedSession = {
        ...(state.selectedSession ?? {}),
        messages: displayedMessages,
      };
      renderAgentMessages(null, { forceBottom: true });
    }

    return !streamedErrorText;
  } catch (error) {
    console.error(error);
    const errorText = String(error.message || error);
    const failedMessages = [...fallbackMessages];
    if (errorText) {
      failedMessages.push(createTextMessage("system", `发送失败：${errorText}`));
    }

    if (sessionId && failedMessages.length) {
      setSessionFallbackMessages(sessionId, failedMessages);
      state.selectedSession = {
        ...(state.selectedSession ?? {}),
        messages: failedMessages,
      };
      renderAgentMessages(null, { forceBottom: true });
    } else if (state.selectedSessionId) {
      await loadSession(state.selectedSessionId);
      alert(`发送失败：${errorText}`);
    } else {
      alert(`发送失败：${errorText}`);
    }
    return false;
  } finally {
    setSending(false);
  }
}

async function handleHistorySend(content) {
  const topic = state.selectedHistoryTopic;
  if (!topic) {
    throw new Error("先打开一个历史话题。");
  }
  const topicId = topic.id;

  setSending(true);
  try {
    els.composerInput.value = "";

    const updated = await api(`/cherry/history/topics/${encodeURIComponent(topicId)}/continue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

    if (state.mode === "history" && state.selectedHistoryTopicId === topicId) {
      state.selectedHistoryTopic = updated;
      renderHistoryMessages({ forceBottom: true });
      scrollPanelIntoView(els.conversationPanel);
    }

    const pollDeadline = Date.now() + 180000;
    let timedOut = true;
    while (Date.now() < pollDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (state.mode !== "history" || state.selectedHistoryTopicId !== topicId) {
        timedOut = false;
        break;
      }
      try {
        const refreshed = await api(`/cherry/history/topics/${encodeURIComponent(topicId)}`);
        if (state.mode !== "history" || state.selectedHistoryTopicId !== topicId) {
          timedOut = false;
          break;
        }
        const hasStreaming = (refreshed.messages ?? []).some((m) => m.status === "streaming");
        const hasError = (refreshed.messages ?? []).some((m) => m.status === "error");
        state.selectedHistoryTopic = refreshed;
        renderHistoryMessages({ forceBottom: true });
        if (!hasStreaming || hasError) {
          timedOut = false;
          break;
        }
      } catch {
        timedOut = false;
        break;
      }
    }
    if (timedOut) {
      alert("等待回复超时，可能还在后台处理中。稍后刷新试试。");
    }
  } finally {
    setSending(false);
  }
}

async function handleSend(event) {
  event.preventDefault();

  const content = els.composerInput.value.trim();
  if (!content || state.sending) return;

  try {
    if (state.mode === "history") {
      await handleHistorySend(content);
      return;
    }

    await sendToCurrentSession(content, content);
  } catch (error) {
    console.error(error);
    alert(`发送失败：${String(error.message || error)}`);
  }
}

els.agentSelect.addEventListener("change", async () => {
  if (state.sending) return;
  state.selectedAgentId = els.agentSelect.value;
  state.selectedSessionId = "";
  state.selectedSession = null;
  await loadSessions();
  if (state.selectedSessionId) {
    await loadSession(state.selectedSessionId);
  } else {
    showAgentHeader();
    renderAgentMessages();
  }
});

els.modeSwitch.addEventListener("click", async (event) => {
  const button = event.target.closest(".mode-button");
  if (state.sending || !button || button.dataset.mode === state.mode) return;

  exitConversationFocus();
  state.mode = button.dataset.mode;
  updateModeUI();

  if (state.mode === "history") {
    renderAssistantList();
    renderHistoryTopics();
    if (state.selectedHistoryTopicId) {
      await loadHistoryTopic(state.selectedHistoryTopicId);
    } else {
      showHistoryHeader();
      renderHistoryMessages();
    }
    return;
  }

  await loadAgentWorkspace();
  if (state.selectedSessionId) {
    await loadSession(state.selectedSessionId);
  } else {
    showAgentHeader();
    renderAgentMessages();
  }
});

els.refreshAllButton.addEventListener("click", async () => {
  if (state.sending) return;
  try {
    await refreshAll();
  } catch (error) {
    console.error(error);
    alert(`刷新失败：${String(error.message || error)}`);
  }
});

els.refreshSessionButton.addEventListener("click", async () => {
  if (state.sending) return;
  try {
    if (state.mode === "history") {
      await loadHistoryTree();
      if (state.selectedHistoryTopicId) {
        await loadHistoryTopic(state.selectedHistoryTopicId);
      } else {
        showHistoryHeader();
        renderHistoryMessages();
      }
      return;
    }

    if (state.selectedSessionId) {
      await loadSession(state.selectedSessionId);
    } else {
      showAgentHeader();
      renderAgentMessages();
    }
  } catch (error) {
    console.error(error);
    alert(`刷新失败：${String(error.message || error)}`);
  }
});

els.newSessionButton.addEventListener("click", async () => {
  if (state.sending) return;
  try {
    await createSession();
  } catch (error) {
    console.error(error);
    alert(`创建会话失败：${String(error.message || error)}`);
  }
});

els.composer.addEventListener("submit", handleSend);

async function init() {
  updateModeUI();
  renderAssistantList();
  renderHistoryTopics();
  showHistoryHeader();
  renderHistoryMessages();

  try {
    await refreshAll();
    ensureHistoryRefreshLoop();
  } catch (error) {
    console.error(error);
    alert(`初始化失败：${String(error.message || error)}`);
  }
}

document.addEventListener("visibilitychange", async () => {
  if (document.hidden || state.mode !== "history" || !state.selectedHistoryTopicId || state.sending) return;
  try {
    await refreshSelectedHistoryTopic();
  } catch (error) {
    console.debug("history refresh on visibility failed", error);
  }
});

init();
