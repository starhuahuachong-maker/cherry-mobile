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

const translations = {
  en: {
    // Header
    "hero.eyebrow": "Phone Console",
    "hero.subtitle": "Browse assistants, topics, and conversation history from your phone. Continue chatting on the go.",
    "mode.history": "History",
    "mode.agents": "Agents",
    "status.connecting": "Connecting",
    "status.connected": "Connected",
    "status.error": "Error",
    "status.unavailable": "Unavailable",
    "status.streaming": "streaming",
    "btn.refresh": "Refresh",

    // Assistant panel
    "panel.assistants.eyebrow": "Cherry History",
    "panel.assistants.title": "Assistants",
    "panel.agents.eyebrow": "Cherry Agent",

    // Sidebar
    "panel.topics.eyebrow": "Assistant Topics",
    "panel.topics.title": "Topics",
    "panel.sessions.title": "Sessions",
    "agent.label": "Agent",
    "btn.newSession": "New Session",

    // Conversation
    "btn.back": "← Back",
    "conv.selectTopic": "Select a topic",
    "conv.selectAssistant": "Select an assistant",
    "conv.selectSession": "Select a session",
    "btn.refreshTopic": "Refresh Topic",
    "btn.refreshCurrent": "Refresh",
    "conv.emptyState": "Conversation messages will appear here.",
    "composer.placeholder": "Continue this Cherry conversation",
    "composer.hint.sessionAuto": "If no session is selected, a new one will be created on send.",
    "composer.hint.noAgents": "No agents available. You can only browse history.",
    "btn.send": "Send",
    "btn.continue": "Continue",

    // History mode specifics
    "composer.placeholder.historyActive": "Continue this history topic",
    "composer.placeholder.historyInactive": "Open a history topic first",
    "composer.hint.historyActive": "Messages are sent through desktop Cherry — phone and desktop share the same conversation.",
    "composer.hint.historyInactive": "Open a topic first to continue chatting.",

    // Dynamic content
    "time.unknown": "Unknown time",
    "role.user": "You",
    "role.assistant": "Assistant",
    "role.system": "System",
    "role.tool": "Tool",
    "untitled.session": "Untitled Session",
    "untitled.assistant": "Untitled Assistant",
    "untitled.topic": "Untitled Topic",
    "empty.noAssistants": "No assistants found in Cherry.",
    "empty.selectAssistant": "Select an assistant first.",
    "empty.noTopics": "This assistant has no topics yet.",
    "empty.noAgents": "No agents available.",
    "empty.noAgentsOption": "No agents available",
    "empty.noSessions": "This agent has no sessions yet.",
    "empty.noMessages": "This session has no messages yet.",
    "empty.topicHistory": "Previous messages for this topic will appear here.",
    "empty.topicNoMessages": "This topic has no messages to display.",
    "empty.noTextBlocks": "(No parseable text blocks in this message)",
    "empty.loadingTopic": "Loading topic history…",
    "meta.topics": "topics",
    "meta.messages": "messages",
    "meta.noPreview": "No preview",
    "label.assistantPrefix": "Assistant",

    // Errors
    "error.agentNotFound": "Agent not found.",
    "error.streamNoBody": "Stream response has no readable body.",
    "error.sendFailed": "Send failed:",
    "error.openTopicFirst": "Open a history topic first.",
    "error.replyTimeout": "Timed out waiting for a reply. It may still be processing — try refreshing later.",
    "error.refreshFailed": "Refresh failed:",
    "error.createSessionFailed": "Failed to create session:",
    "error.initFailed": "Initialization failed:",

    // Session name
    "session.mobilePrefix": "Mobile",

    // Language toggle
    "lang.toggle": "中文",
  },
  zh: {
    "hero.eyebrow": "手机控制台",
    "hero.subtitle": "在手机上查看 Cherry 的助手、话题和历史正文，也能继续发消息。",
    "mode.history": "历史对话",
    "mode.agents": "Agent 会话",
    "status.connecting": "连接中",
    "status.connected": "已连接",
    "status.error": "异常",
    "status.unavailable": "不可用",
    "status.streaming": "回复中",
    "btn.refresh": "刷新",

    "panel.assistants.eyebrow": "Cherry History",
    "panel.assistants.title": "助手",
    "panel.agents.eyebrow": "Cherry Agent",

    "panel.topics.eyebrow": "助手话题",
    "panel.topics.title": "话题",
    "panel.sessions.title": "会话",
    "agent.label": "Agent",
    "btn.newSession": "新会话",

    "btn.back": "← 返回",
    "conv.selectTopic": "选择一个话题",
    "conv.selectAssistant": "选择一个助手",
    "conv.selectSession": "选择一个会话",
    "btn.refreshTopic": "刷新当前话题",
    "btn.refreshCurrent": "刷新当前",
    "conv.emptyState": "会话内容会显示在这里。",
    "composer.placeholder": "给当前 Cherry 会话继续发消息",
    "composer.hint.sessionAuto": "如果没选会话，发送时会自动创建一个新会话。",
    "composer.hint.noAgents": "当前没有可用 agent，只能浏览历史对话。",
    "btn.send": "发送",
    "btn.continue": "续聊",

    "composer.placeholder.historyActive": "基于这个历史话题继续聊",
    "composer.placeholder.historyInactive": "先打开一个历史话题，再继续聊",
    "composer.hint.historyActive": "会直接驱动桌面 Cherry 在这个真实话题里发送，手机和电脑看到的是同一份记录。",
    "composer.hint.historyInactive": "先点开一个具体话题，再继续聊。",

    "time.unknown": "未知时间",
    "role.user": "我",
    "role.assistant": "助手",
    "role.system": "系统",
    "role.tool": "工具",
    "untitled.session": "未命名会话",
    "untitled.assistant": "未命名助手",
    "untitled.topic": "未命名话题",
    "empty.noAssistants": "还没有读到 Cherry 里的助手。",
    "empty.selectAssistant": "先选择一个助手。",
    "empty.noTopics": "这个助手下面还没有话题。",
    "empty.noAgents": "当前没有可用 agent。",
    "empty.noAgentsOption": "暂无 agent",
    "empty.noSessions": "这个 agent 还没有会话。",
    "empty.noMessages": "这个会话还没有消息。",
    "empty.topicHistory": "这里会显示这个话题的旧对话内容。",
    "empty.topicNoMessages": "这个话题还没有可显示的消息。",
    "empty.noTextBlocks": "（这条消息没有可解析的文本块）",
    "empty.loadingTopic": "正在读取这个话题的历史正文。",
    "meta.topics": "个话题",
    "meta.messages": "条消息",
    "meta.noPreview": "暂无摘要",
    "label.assistantPrefix": "助手",

    "error.agentNotFound": "没有找到 agent。",
    "error.streamNoBody": "流式响应没有可读数据。",
    "error.sendFailed": "发送失败：",
    "error.openTopicFirst": "先打开一个历史话题。",
    "error.replyTimeout": "等待回复超时，可能还在后台处理中。稍后刷新试试。",
    "error.refreshFailed": "刷新失败：",
    "error.createSessionFailed": "创建会话失败：",
    "error.initFailed": "初始化失败：",

    "session.mobilePrefix": "手机会话",

    "lang.toggle": "EN",
  },
};

let currentLang = localStorage.getItem("cherry-mobile-lang") || "en";

function t(key) {
  return translations[currentLang]?.[key] ?? translations.en[key] ?? key;
}

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem("cherry-mobile-lang", lang);
  applyStaticI18n();
  updateModeUI();
  renderAssistantList();
  renderHistoryTopics();
  showHistoryHeader();
  if (state.mode === "history") {
    renderHistoryMessages();
  } else {
    renderAgentMessages();
  }
}

function applyStaticI18n() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  const langBtn = document.querySelector("#langToggle");
  if (langBtn) langBtn.textContent = t("lang.toggle");
}

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
  if (!value) return t("time.unknown");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(currentLang === "zh" ? "zh-CN" : "en-US", {
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
  return t("role." + role) ?? role;
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
    els.sendButton.textContent = t("btn.continue");
    els.sendButton.disabled = state.sending || !historyReady;
    els.composerInput.disabled = state.sending || !historyReady;
    els.composerInput.placeholder = state.selectedHistoryTopic
      ? t("composer.placeholder.historyActive")
      : t("composer.placeholder.historyInactive");
    els.composerHint.textContent = historyReady
      ? t("composer.hint.historyActive")
      : t("composer.hint.historyInactive");
  } else {
    els.sendButton.textContent = t("btn.send");
    els.sendButton.disabled = state.sending || !agentReady;
    els.composerInput.disabled = state.sending || !agentReady;
    els.composerInput.placeholder = t("composer.placeholder");
    els.composerHint.textContent = agentReady
      ? t("composer.hint.sessionAuto")
      : t("composer.hint.noAgents");
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
  els.refreshSessionButton.textContent = state.mode === "history" ? t("btn.refreshTopic") : t("btn.refreshCurrent");
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
    setStatus(health.status === "ok" ? t("status.connected") : t("status.error"), health.status === "ok" ? "ok" : "bad");
  } catch (error) {
    console.error(error);
    setStatus(t("status.unavailable"), "bad");
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
  return session.name?.trim() || t("untitled.session");
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
      streaming ? ` · ${t("status.streaming")}` : ""
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
    empty.innerHTML = `<p>${escapeHtml(t("empty.noAssistants"))}</p>`;
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
        <span class="assistant-name">${escapeHtml(assistant.name || t("untitled.assistant"))}</span>
        <span class="assistant-meta">${escapeHtml(String(assistant.topics?.length ?? 0))} ${escapeHtml(t("meta.topics"))}</span>
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

  els.listLabel.textContent = assistant ? `${t("label.assistantPrefix")} · ${assistant.name}` : t("panel.assistants.eyebrow");
  els.listTitle.textContent = t("panel.topics.title");
  els.sessionList.innerHTML = "";

  if (!assistant) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `<p>${escapeHtml(t("empty.selectAssistant"))}</p>`;
    els.sessionList.append(empty);
    return;
  }

  if (!topics.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `<p>${escapeHtml(t("empty.noTopics"))}</p>`;
    els.sessionList.append(empty);
    return;
  }

  for (const topic of topics) {
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = state.sending;
    button.className = `session-card ${topic.id === state.selectedHistoryTopicId ? "active" : ""}`.trim();
    button.innerHTML = `
      <span class="session-title">${escapeHtml(topic.name || t("untitled.topic"))}</span>
      <span class="session-meta">${escapeHtml(formatDate(topic.updatedAt || topic.createdAt))} · ${escapeHtml(
        String(topic.messageCount ?? 0),
      )} ${escapeHtml(t("meta.messages"))}</span>
      <span class="session-meta">${escapeHtml(topic.preview || t("meta.noPreview"))}</span>
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
    option.textContent = t("empty.noAgentsOption");
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
  els.listLabel.textContent = t("panel.agents.eyebrow");
  els.listTitle.textContent = t("panel.sessions.title");
  els.sessionList.innerHTML = "";

  if (!state.agents.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `<p>${escapeHtml(t("empty.noAgents"))}</p>`;
    els.sessionList.append(empty);
    return;
  }

  if (!state.sessions.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `<p>${escapeHtml(t("empty.noSessions"))}</p>`;
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
    setConversationHeader(t("mode.history"), t("conv.selectAssistant"));
    return;
  }

  if (!topic) {
    setConversationHeader(`${assistant.emoji || "😀"} ${assistant.name}`, t("conv.selectTopic"));
    return;
  }

  setConversationHeader(
    `${assistant.emoji || "😀"} ${assistant.name} · ${formatDate(topic.updatedAt || topic.createdAt)}`,
    topic.name || t("untitled.topic"),
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
    renderConversationEmpty(t("empty.noMessages"));
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
    renderConversationEmpty(t("empty.topicHistory"));
    return;
  }

  const messages = [...(topic.messages ?? [])].sort(
    (left, right) => dateValue(left.createdAt) - dateValue(right.createdAt),
  );

  if (!messages.length) {
    renderConversationEmpty(t("empty.topicNoMessages"));
    return;
  }

  for (const message of messages) {
    const text = String(message.content || "").trim() || t("empty.noTextBlocks");
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
    renderConversationEmpty(t("empty.loadingTopic"));
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
    setConversationHeader(t("panel.sessions.title"), t("conv.selectSession"));
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
  if (!agent) throw new Error(t("error.agentNotFound"));

  const sessionName =
    name.trim() ||
    `${t("session.mobilePrefix")} ${new Date().toLocaleTimeString(currentLang === "zh" ? "zh-CN" : "en-US", {
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
    throw new Error(t("error.streamNoBody"));
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
            renderAgentMessages(`${t("error.sendFailed")}${streamedErrorText}`);
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
      displayedMessages.push(createTextMessage("system", `${t("error.sendFailed")}${streamedErrorText}`));
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
      failedMessages.push(createTextMessage("system", `${t("error.sendFailed")}${errorText}`));
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
      alert(`${t("error.sendFailed")}${errorText}`);
    } else {
      alert(`${t("error.sendFailed")}${errorText}`);
    }
    return false;
  } finally {
    setSending(false);
  }
}

async function handleHistorySend(content) {
  const topic = state.selectedHistoryTopic;
  if (!topic) {
    throw new Error(t("error.openTopicFirst"));
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
      alert(t("error.replyTimeout"));
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
    alert(`${t("error.sendFailed")}${String(error.message || error)}`);
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
    alert(`${t("error.refreshFailed")}${String(error.message || error)}`);
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
    alert(`${t("error.refreshFailed")}${String(error.message || error)}`);
  }
});

els.newSessionButton.addEventListener("click", async () => {
  if (state.sending) return;
  try {
    await createSession();
  } catch (error) {
    console.error(error);
    alert(`${t("error.createSessionFailed")} ${String(error.message || error)}`);
  }
});

els.composer.addEventListener("submit", handleSend);

document.querySelector("#langToggle")?.addEventListener("click", () => {
  setLang(currentLang === "en" ? "zh" : "en");
});

async function init() {
  applyStaticI18n();
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
    alert(`${t("error.initFailed")} ${String(error.message || error)}`);
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
