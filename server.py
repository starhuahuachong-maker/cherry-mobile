#!/usr/bin/env python3
from __future__ import annotations

import copy
import json
import mimetypes
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

from cherry_history import get_persist_state, get_snapshot


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
CHERRY_UI_SCRIPT = ROOT / "cherry_ui.swift"
CHERRY_BASE_URL = os.environ.get("CHERRY_BASE_URL", "http://127.0.0.1:23333").rstrip("/")
CHERRY_LOG_DIR = Path.home() / "Library/Application Support/CherryStudio/logs"
CHERRY_HISTORY_DIR = Path.home() / "Library/Application Support/CherryStudio/Data/Files"
HOST = os.environ.get("CHERRY_MOBILE_HOST", "127.0.0.1")
PORT = int(os.environ.get("CHERRY_MOBILE_PORT", "8765"))
API_KEY_PATTERN = re.compile(r"cs-sk-[A-Za-z0-9-]+")
THINKING_RE = re.compile(r"<(?:antml:)?thinking>.*?</(?:antml:)?thinking>", re.IGNORECASE | re.DOTALL)
KEY_CACHE: dict[str, object] = {"signature": None, "value": None}
CONTINUATIONS_FILE = ROOT / "data" / "continuations.json"
CONTINUATIONS_LOCK = threading.Lock()
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}
SESSION_COOKIE_NAME = "cherry_mobile_session"
SESSION_TOKEN = os.environ.get("CHERRY_MOBILE_SESSION_TOKEN") or secrets.token_urlsafe(32)
ALLOWED_PROXY_PREFIXES = ("/health", "/v1/agents")
DESKTOP_SEND_LOCK = threading.Lock()
MAX_REQUEST_BODY_BYTES = int(os.environ.get("CHERRY_MOBILE_MAX_BODY_BYTES", str(1024 * 1024)))


def latest_log_signature() -> tuple[tuple[str, int], ...]:
    paths = sorted(CHERRY_LOG_DIR.glob("app.*.log"), key=lambda path: path.stat().st_mtime_ns, reverse=True)
    return tuple((path.name, path.stat().st_mtime_ns) for path in paths[:5])


def load_cherry_api_key() -> str:
    env_key = os.environ.get("CHERRY_API_KEY")
    if env_key:
        return env_key

    signature = latest_log_signature()
    if KEY_CACHE["signature"] == signature and KEY_CACHE["value"]:
        return str(KEY_CACHE["value"])

    paths = sorted(CHERRY_LOG_DIR.glob("app.*.log"), key=lambda path: path.stat().st_mtime_ns, reverse=True)
    for path in paths:
        matches = API_KEY_PATTERN.findall(path.read_text(errors="ignore"))
        if matches:
            KEY_CACHE["signature"] = signature
            KEY_CACHE["value"] = matches[-1]
            return matches[-1]

    raise RuntimeError("Cherry Studio API key not found. Open Cherry Studio and enable its API server first.")


def guess_mime_type(path: Path) -> str:
    mime_type, _ = mimetypes.guess_type(path.name)
    if mime_type:
        return mime_type
    return "application/octet-stream"


def history_title(content: str, fallback: str) -> str:
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            line = line.lstrip("#").strip()
        return line[:120] or fallback
    return fallback


def history_excerpt(content: str) -> str:
    collapsed = " ".join(part.strip() for part in content.splitlines() if part.strip())
    return collapsed[:180]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def later_iso(value: str, milliseconds: int = 1) -> str:
    base = datetime.fromisoformat(value.replace("Z", "+00:00"))
    shifted = base.timestamp() + milliseconds / 1000
    return datetime.fromtimestamp(shifted, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def desktop_topic_button_title(topic: dict[str, object]) -> str:
    topic_name = str(topic.get("name") or "").strip()
    stamp = str(topic.get("updatedAt") or topic.get("createdAt") or "").strip()
    if not topic_name or not stamp:
        return topic_name

    try:
        moment = datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return topic_name

    return f"{topic_name} {moment.strftime('%Y/%m/%d %H:%M')}"


def topic_preview(messages: list[dict[str, object]]) -> str:
    for message in reversed(messages):
        content = str(message.get("content") or "").strip()
        if content:
            return content[:120]
    return ""


def _read_json_file(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def load_continuations() -> dict[str, object]:
    with CONTINUATIONS_LOCK:
        payload = _read_json_file(CONTINUATIONS_FILE)
    topics = payload.get("topics")
    if not isinstance(topics, dict):
        return {"topics": {}}
    return {"topics": topics}


def save_continuations(payload: dict[str, object]) -> None:
    CONTINUATIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp_path = CONTINUATIONS_FILE.with_suffix(".tmp")
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    with CONTINUATIONS_LOCK:
        temp_path.write_text(body, encoding="utf-8")
        temp_path.replace(CONTINUATIONS_FILE)


def load_merged_snapshot() -> dict[str, object]:
    snapshot = copy.deepcopy(get_snapshot())
    continuations = load_continuations()
    cont_topics = continuations.get("topics") or {}

    for topic_id, cont_messages in cont_topics.items():
        if not isinstance(cont_messages, list) or not cont_messages:
            continue
        topic = snapshot.get("topics", {}).get(topic_id)
        if not topic:
            continue
        existing_ids = {str(m.get("id") or "") for m in (topic.get("messages") or [])}
        for msg in cont_messages:
            if str(msg.get("id") or "") not in existing_ids:
                topic.setdefault("messages", []).append(msg)
        topic["messages"] = sorted(topic.get("messages") or [], key=lambda m: str(m.get("createdAt") or ""))
        topic["messageCount"] = len(topic["messages"])

    return overlay_pending_snapshot(snapshot)


def request_token_from_headers(headers: object) -> str:
    if not headers:
        return ""

    cookie_header = getattr(headers, "get", lambda *_args, **_kwargs: None)("Cookie")
    if cookie_header:
        cookie = SimpleCookie()
        cookie.load(cookie_header)
        morsel = cookie.get(SESSION_COOKIE_NAME)
        if morsel and morsel.value:
            return morsel.value

    direct_token = getattr(headers, "get", lambda *_args, **_kwargs: None)("X-Cherry-Mobile-Token")
    if isinstance(direct_token, str) and direct_token.strip():
        return direct_token.strip()

    auth = getattr(headers, "get", lambda *_args, **_kwargs: None)("Authorization")
    if isinstance(auth, str) and auth.startswith("Bearer "):
        return auth[7:].strip()

    return ""


def is_authenticated(headers: object) -> bool:
    token = request_token_from_headers(headers)
    if not token:
        return False
    return secrets.compare_digest(token, SESSION_TOKEN)


def pending_reply_for_topic(topic_id: str) -> dict[str, object] | None:
    with PENDING_REPLIES_LOCK:
        payload = PENDING_REPLIES.get(topic_id)
        return copy.deepcopy(payload) if payload else None


def clear_pending_reply(topic_id: str) -> None:
    with PENDING_REPLIES_LOCK:
        PENDING_REPLIES.pop(topic_id, None)


def mark_pending_reply_error(topic_id: str, error_text: str) -> None:
    with PENDING_REPLIES_LOCK:
        pending = PENDING_REPLIES.get(topic_id)
        if not pending:
            return
        pending["status"] = "error"
        pending["error"] = error_text
        pending["updatedAt"] = now_iso()


def topic_has_real_user_message(topic: dict[str, object], pending: dict[str, object]) -> bool:
    baseline_ids = {str(item) for item in pending.get("baselineIds") or []}
    expected_text = str(pending.get("userText") or "").strip()
    if not expected_text:
        return False

    for message in topic.get("messages") or []:
        if str(message.get("id") or "") in baseline_ids:
            continue
        if str(message.get("role") or "") != "user":
            continue
        if sanitize_history_text("user", message.get("content")) == expected_text:
            return True
    return False


def topic_with_pending_overlay(topic: dict[str, object], pending: dict[str, object]) -> dict[str, object]:
    result = copy.deepcopy(topic)
    messages = list(result.get("messages") or [])
    user_message = copy.deepcopy(pending.get("userMessage") or {})
    user_created_at = str(user_message.get("createdAt") or now_iso())

    if user_message and not topic_has_real_user_message(result, pending):
        messages.append(user_message)

    if pending.get("status") == "pending":
        assistant_message = build_history_message("assistant", result, "正在回复…", later_iso(user_created_at, 200))
        assistant_message["status"] = "streaming"
        messages.append(assistant_message)
    elif pending.get("status") == "error":
        assistant_message = build_history_message(
            "assistant",
            result,
            f"发送失败：{str(pending.get('error') or '未知错误')}",
            later_iso(user_created_at, 200),
        )
        assistant_message["status"] = "error"
        messages.append(assistant_message)

    messages.sort(key=lambda item: (str(item.get("createdAt") or ""), str(item.get("id") or "")))
    result["messages"] = messages
    result["messageCount"] = len(messages)
    result["preview"] = topic_preview(messages)
    if messages:
        result["updatedAt"] = str(messages[-1].get("createdAt") or result.get("updatedAt") or result.get("createdAt") or "")
    return result


def overlay_pending_snapshot(snapshot: dict[str, object]) -> dict[str, object]:
    with PENDING_REPLIES_LOCK:
        pending_items = {topic_id: copy.deepcopy(entry) for topic_id, entry in PENDING_REPLIES.items()}

    if not pending_items:
        return snapshot

    topics = snapshot.get("topics")
    if isinstance(topics, dict):
        for topic_id, pending in pending_items.items():
            topic = topics.get(topic_id)
            if isinstance(topic, dict):
                topics[topic_id] = topic_with_pending_overlay(topic, pending)

    assistants = snapshot.get("assistants")
    if isinstance(assistants, list):
        for assistant in assistants:
            if not isinstance(assistant, dict):
                continue
            assistant_topics = assistant.get("topics")
            if not isinstance(assistant_topics, list):
                continue
            updated_topics = []
            for topic in assistant_topics:
                if not isinstance(topic, dict):
                    updated_topics.append(topic)
                    continue
                topic_id = str(topic.get("id") or "")
                pending = pending_items.get(topic_id)
                updated_topics.append(topic_with_pending_overlay(topic, pending) if pending else topic)
            assistant["topics"] = updated_topics

    return snapshot


def split_api_keys(raw_value: object) -> list[str]:
    if not isinstance(raw_value, str):
        return []
    return [candidate.strip() for candidate in raw_value.split(",") if candidate.strip()]


def provider_lookup(persist_state: dict[str, object]) -> dict[str, dict[str, object]]:
    llm_state = persist_state.get("llm") or {}
    providers = llm_state.get("providers") if isinstance(llm_state, dict) else None
    if not isinstance(providers, list):
        return {}
    return {str(provider.get("id")): provider for provider in providers if isinstance(provider, dict) and provider.get("id")}


def assistant_lookup(persist_state: dict[str, object]) -> dict[str, dict[str, object]]:
    assistants_state = persist_state.get("assistants") or {}
    assistants = assistants_state.get("assistants") if isinstance(assistants_state, dict) else None
    if not isinstance(assistants, list):
        return {}
    return {str(assistant.get("id")): assistant for assistant in assistants if isinstance(assistant, dict) and assistant.get("id")}


def sanitize_history_text(role: str, text: object) -> str:
    cleaned = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if role == "assistant" and cleaned:
        cleaned = THINKING_RE.sub("", cleaned).strip()
    return cleaned


def anthropic_messages_for_topic(topic: dict[str, object], user_text: str, context_count: int) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    history = list(topic.get("messages") or [])
    history.sort(key=lambda item: (str(item.get("createdAt") or ""), str(item.get("id") or "")))
    window_size = max(6, min(48, context_count * 2 if context_count > 0 else 12))

    for message in history[-window_size:]:
        role = str(message.get("role") or "")
        if role not in {"user", "assistant"}:
            continue
        content = sanitize_history_text(role, message.get("content"))
        if not content:
            continue
        messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": user_text.strip()})
    return messages


def extract_anthropic_text(payload: dict[str, object]) -> str:
    parts: list[str] = []
    for block in payload.get("content") or []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append(str(block["text"]))
    return "\n\n".join(part.strip() for part in parts if part.strip()).strip()


def parse_provider_error(payload: bytes, fallback: str) -> str:
    if not payload:
        return fallback
    try:
        data = json.loads(payload.decode("utf-8", "replace"))
    except json.JSONDecodeError:
        return payload.decode("utf-8", "replace").strip() or fallback

    error = data.get("error")
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        return str(error["message"])
    if isinstance(data.get("message"), str):
        return str(data["message"])
    return fallback


def anthropic_max_tokens(settings: dict[str, object]) -> int:
    if settings.get("enableMaxTokens") and isinstance(settings.get("maxTokens"), int):
        return max(256, min(int(settings["maxTokens"]), 8192))
    return 4096


def call_anthropic_provider(
    provider: dict[str, object],
    model_id: str,
    system_prompt: str,
    messages: list[dict[str, str]],
    settings: dict[str, object],
) -> str:
    api_host = str(provider.get("apiHost") or "").rstrip("/")
    if not api_host:
        raise RuntimeError("Anthropic provider 缺少 API Host。")

    api_keys = split_api_keys(provider.get("apiKey"))
    if not api_keys:
        raise RuntimeError("Anthropic provider 没有可用 API key。")

    payload: dict[str, object] = {
        "model": model_id,
        "max_tokens": anthropic_max_tokens(settings),
        "messages": messages,
    }
    if system_prompt.strip():
        payload["system"] = system_prompt.strip()
    if settings.get("enableTemperature"):
        payload["temperature"] = settings.get("temperature")
    if settings.get("enableTopP"):
        payload["top_p"] = settings.get("topP")

    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    last_error = "Anthropic 请求失败。"

    for index, api_key in enumerate(api_keys):
        request = urllib.request.Request(
            f"{api_host}/v1/messages",
            data=encoded,
            headers={
                "Content-Type": "application/json",
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=3600) as response:
                payload = json.loads(response.read().decode("utf-8"))
                text = extract_anthropic_text(payload)
                if text:
                    return text
                raise RuntimeError("Anthropic 返回了空内容。")
        except urllib.error.HTTPError as exc:
            body = exc.read()
            last_error = parse_provider_error(body, f"Anthropic 请求失败（HTTP {exc.code}）")
            if exc.code in {401, 403, 429} and index + 1 < len(api_keys):
                continue
            raise RuntimeError(last_error) from exc
        except urllib.error.URLError as exc:
            last_error = f"Anthropic 请求失败：{exc.reason}"
            if index + 1 < len(api_keys):
                continue
            raise RuntimeError(last_error) from exc

    raise RuntimeError(last_error)


def build_history_message(role: str, topic: dict[str, object], content: str, created_at: str | None = None) -> dict[str, object]:
    return {
        "id": str(uuid4()),
        "role": role,
        "assistantId": str(topic.get("assistantId") or ""),
        "topicId": str(topic.get("id") or ""),
        "createdAt": created_at or now_iso(),
        "status": "success",
        "content": content,
        "blockIds": [],
        "source": "mobile",
    }


def drive_desktop_cherry_send(assistant_name: str, topic: dict[str, object], user_text: str) -> None:
    topic_name = str(topic.get("name") or "").strip()
    if not assistant_name:
        raise RuntimeError("没有找到这个话题对应的助手名称。")
    if not topic_name:
        raise RuntimeError("这个话题缺少标题，暂时无法在桌面 Cherry 里定位。")

    payload = {
        "assistant": assistant_name,
        "topic": topic_name,
        "topicButtonTitle": desktop_topic_button_title(topic),
        "content": user_text,
    }

    try:
        completed = subprocess.run(
            ["swift", str(CHERRY_UI_SCRIPT)],
            input=json.dumps(payload, ensure_ascii=False),
            text=True,
            capture_output=True,
            timeout=45,
            check=False,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("系统里没有可用的 `swift` 命令，没法驱动桌面 Cherry。") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("驱动桌面 Cherry 发送消息超时了。") from exc

    if completed.returncode != 0:
        message = (completed.stderr or completed.stdout or "").strip() or "驱动桌面 Cherry 发送消息失败。"
        raise RuntimeError(message)


def wait_for_real_topic_reply(
    topic_id: str,
    baseline_ids: set[str],
    user_text: str,
    timeout: float = 180.0,
) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    expected = user_text.strip()
    latest_topic: dict[str, object] | None = None

    while time.monotonic() < deadline:
        snapshot = get_snapshot()
        topic = snapshot.get("topics", {}).get(topic_id)
        if topic:
            latest_topic = topic
            messages = list(topic.get("messages") or [])
            new_messages = [message for message in messages if str(message.get("id") or "") not in baseline_ids]
            matched_user = None
            for message in new_messages:
                if str(message.get("role") or "") != "user":
                    continue
                if sanitize_history_text("user", message.get("content")) == expected:
                    matched_user = message
                    break

            if matched_user is not None:
                user_created_at = str(matched_user.get("createdAt") or "")
                for message in new_messages:
                    if str(message.get("role") or "") != "assistant":
                        continue
                    content = sanitize_history_text("assistant", message.get("content"))
                    if not content:
                        continue
                    if not user_created_at or str(message.get("createdAt") or "") >= user_created_at:
                        return topic
        time.sleep(0.35)

    if latest_topic:
        raise RuntimeError("桌面 Cherry 已收到消息，但在等待真实回复时超时。")
    raise RuntimeError("桌面 Cherry 发送后，手机端暂时还没读到这个话题。")


def _build_context_messages(topic: dict[str, object], user_text: str) -> list[dict[str, str]]:
    messages = []
    history = list(topic.get("messages") or [])
    history.sort(key=lambda m: (str(m.get("createdAt") or ""), str(m.get("id") or "")))

    for msg in history[-12:]:
        role = str(msg.get("role") or "")
        if role not in {"user", "assistant"}:
            continue
        content = sanitize_history_text(role, msg.get("content"))
        if content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": user_text.strip()})
    return messages


def call_cherry_api_direct(
    topic: dict[str, object],
    user_text: str,
    assistant: dict[str, object],
    persist_state: dict[str, object],
) -> str:
    """Fallback: call LLM API directly when desktop UI drive fails."""
    model_raw = assistant.get("model") or {}
    if isinstance(model_raw, dict):
        provider_id = str(model_raw.get("provider") or "")
        model_id = str(model_raw.get("id") or "")
    else:
        provider_id = ""
        model_id = str(model_raw)

    messages = _build_context_messages(topic, user_text)
    system_prompt = str(assistant.get("prompt") or "").strip()
    settings = assistant.get("settings") or {}
    if not isinstance(settings, dict):
        settings = {}

    providers = provider_lookup(persist_state)

    # Try Anthropic provider directly if the model is Anthropic
    if provider_id == "anthropic":
        provider = providers.get("anthropic")
        if provider:
            return call_anthropic_provider(provider, model_id, system_prompt, messages, settings)

    # Try OpenRouter fallback for any model
    openrouter = providers.get("openrouter")
    if openrouter:
        api_host = str(openrouter.get("apiHost") or "").rstrip("/")
        api_keys = split_api_keys(openrouter.get("apiKey"))
        if api_host and api_keys:
            or_model = f"anthropic/{model_id}" if provider_id == "anthropic" else model_id
            payload: dict[str, object] = {
                "model": or_model,
                "messages": messages,
                "max_tokens": anthropic_max_tokens(settings),
            }
            if system_prompt:
                payload["messages"] = [{"role": "system", "content": system_prompt}] + messages
            encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            request = urllib.request.Request(
                f"{api_host}/chat/completions",
                data=encoded,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_keys[0]}",
                },
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=3600) as response:
                data = json.loads(response.read().decode("utf-8"))
                choices = data.get("choices") or []
                if choices:
                    return str(choices[0].get("message", {}).get("content") or "").strip()

    raise RuntimeError("没有可用的 API provider 来降级发送。")


def save_continuation_messages(topic_id: str, messages: list[dict[str, object]]) -> None:
    with CONTINUATIONS_LOCK:
        payload = _read_json_file(CONTINUATIONS_FILE)
        topics = payload.get("topics")
        if not isinstance(topics, dict):
            topics = {}
            payload["topics"] = topics
        existing = topics.get(topic_id) or []
        if not isinstance(existing, list):
            existing = []
        existing.extend(messages)
        topics[topic_id] = existing
        CONTINUATIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp_path = CONTINUATIONS_FILE.with_suffix(".tmp")
        temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp_path.replace(CONTINUATIONS_FILE)


def remove_continuation_messages(topic_id: str, message_ids: set[str]) -> None:
    """Remove specific continuation messages (e.g. after desktop drive succeeds)."""
    with CONTINUATIONS_LOCK:
        payload = _read_json_file(CONTINUATIONS_FILE)
        topics = payload.get("topics")
        if not isinstance(topics, dict):
            return
        existing = topics.get(topic_id)
        if not isinstance(existing, list):
            return
        topics[topic_id] = [m for m in existing if str(m.get("id") or "") not in message_ids]
        if not topics[topic_id]:
            del topics[topic_id]
        CONTINUATIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp_path = CONTINUATIONS_FILE.with_suffix(".tmp")
        temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp_path.replace(CONTINUATIONS_FILE)


PENDING_REPLIES: dict[str, dict[str, object]] = {}
PENDING_REPLIES_LOCK = threading.Lock()


def _async_reply_worker(topic_id: str, topic: dict[str, object], user_text: str, baseline_ids: set[str]) -> None:
    try:
        persist_state = get_persist_state()
        assistant = assistant_lookup(persist_state).get(str(topic.get("assistantId") or ""))
        if not assistant:
            raise RuntimeError("没有找到助手配置。")

        with DESKTOP_SEND_LOCK:
            drive_desktop_cherry_send(str(assistant.get("name") or ""), topic, user_text)

        wait_for_real_topic_reply(topic_id, baseline_ids, user_text)
        clear_pending_reply(topic_id)
    except Exception as exc:
        mark_pending_reply_error(topic_id, str(exc))


def continue_history_topic(topic_id: str, user_text: str) -> dict[str, object]:
    raw_snapshot = copy.deepcopy(get_snapshot())
    raw_topic = raw_snapshot.get("topics", {}).get(topic_id)
    if not raw_topic:
        raise KeyError("History topic not found")

    with PENDING_REPLIES_LOCK:
        existing = PENDING_REPLIES.get(topic_id)
        if existing and existing.get("status") == "pending":
            raise RuntimeError("这个话题上一条消息还在发送中。")
        if existing and existing.get("status") == "error":
            PENDING_REPLIES.pop(topic_id, None)

    snapshot = load_merged_snapshot()
    topic = snapshot.get("topics", {}).get(topic_id)
    if not topic:
        raise KeyError("History topic not found")

    user_msg = build_history_message("user", topic, user_text.strip())
    baseline_ids = {str(message.get("id") or "") for message in (raw_topic.get("messages") or [])}
    pending = {
        "topicId": topic_id,
        "userText": user_text.strip(),
        "userMessage": user_msg,
        "baselineIds": sorted(baseline_ids),
        "status": "pending",
        "startedAt": now_iso(),
    }
    with PENDING_REPLIES_LOCK:
        PENDING_REPLIES[topic_id] = pending

    worker = threading.Thread(
        target=_async_reply_worker,
        args=(topic_id, raw_topic, user_text.strip(), baseline_ids),
        daemon=True,
    )
    worker.start()

    return topic_with_pending_overlay(topic, pending)


class CherryMobileHandler(BaseHTTPRequestHandler):
    server_version = "CherryMobile/1.0"
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        if self.handle_local_api(send_body=True):
            return
        if self.path.startswith("/api"):
            self.proxy_request(send_body=True)
            return
        self.serve_static(send_body=True)

    def do_HEAD(self) -> None:
        if self.handle_local_api(send_body=False):
            return
        if self.path.startswith("/api"):
            self.proxy_request(send_body=False)
            return
        self.serve_static(send_body=False)

    def do_POST(self) -> None:
        if self.handle_local_api(send_body=True):
            return
        if self.path.startswith("/api"):
            self.proxy_request(send_body=True)
            return
        self.send_error(404, "Not found")

    def do_DELETE(self) -> None:
        if self.path.startswith("/api"):
            self.proxy_request(send_body=True)
            return
        self.send_error(404, "Not found")

    def append_common_headers(self) -> None:
        self.send_header("Connection", "close")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")

    def append_session_cookie(self) -> None:
        self.send_header("Set-Cookie", f"{SESSION_COOKIE_NAME}={SESSION_TOKEN}; HttpOnly; Path=/; SameSite=Strict")

    def ensure_api_auth(self, send_body: bool = True) -> bool:
        if is_authenticated(self.headers):
            return True
        self.send_json(401, {"error": "Authentication required."}, send_body=send_body)
        return False

    def handle_local_api(self, send_body: bool) -> bool:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/") and not self.ensure_api_auth(send_body=send_body):
            return True
        if parsed.path.startswith("/api/cherry/history/topics/") and parsed.path.endswith("/continue"):
            if self.command != "POST":
                self.send_error(405, "Method not allowed")
                return True

            topic_id = urllib.parse.unquote(parsed.path.removeprefix("/api/cherry/history/topics/").removesuffix("/continue"))
            try:
                body = self.read_json_body()
                user_text = str(body.get("content") or "").strip()
                if not user_text:
                    self.send_json(400, {"error": "content is required"}, send_body=send_body)
                    return True
                topic = continue_history_topic(topic_id, user_text)
            except json.JSONDecodeError:
                self.send_json(400, {"error": "Invalid JSON body"}, send_body=send_body)
                return True
            except ValueError as exc:
                self.send_json(413, {"error": str(exc)}, send_body=send_body)
                return True
            except KeyError:
                self.send_json(404, {"error": "History topic not found"}, send_body=send_body)
                return True
            except RuntimeError as exc:
                status = 409 if "还在发送中" in str(exc) else 502
                self.send_json(status, {"error": str(exc)}, send_body=send_body)
                return True
            except Exception as exc:  # noqa: BLE001
                self.send_json(500, {"error": f"Failed to continue Cherry history topic: {exc}"}, send_body=send_body)
                return True

            self.send_json(200, topic, send_body=send_body)
            return True

        if parsed.path == "/api/cherry/history/tree":
            try:
                snapshot = load_merged_snapshot()
            except Exception as exc:  # noqa: BLE001
                self.send_json(500, {"error": f"Failed to load Cherry history tree: {exc}"}, send_body=send_body)
                return True

            self.send_json(200, {"assistants": snapshot.get("assistants", [])}, send_body=send_body)
            return True

        if parsed.path.startswith("/api/cherry/history/topics/"):
            topic_id = urllib.parse.unquote(parsed.path.removeprefix("/api/cherry/history/topics/"))
            try:
                snapshot = load_merged_snapshot()
            except Exception as exc:  # noqa: BLE001
                self.send_json(500, {"error": f"Failed to load Cherry history topic: {exc}"}, send_body=send_body)
                return True

            topic = snapshot.get("topics", {}).get(topic_id)
            if not topic:
                self.send_json(404, {"error": "History topic not found"}, send_body=send_body)
                return True

            self.send_json(200, topic, send_body=send_body)
            return True

        if parsed.path == "/api/history/files":
            files = []
            for path in sorted(CHERRY_HISTORY_DIR.glob("*.md"), key=lambda item: item.stat().st_mtime_ns, reverse=True):
                content = path.read_text(errors="ignore")
                files.append(
                    {
                        "id": path.name,
                        "title": history_title(content, path.stem),
                        "excerpt": history_excerpt(content),
                        "updated_at": datetime.fromtimestamp(path.stat().st_mtime).isoformat(),
                        "size": path.stat().st_size,
                    }
                )
            self.send_json(200, {"files": files}, send_body=send_body)
            return True

        if parsed.path.startswith("/api/history/files/"):
            file_name = urllib.parse.unquote(parsed.path.removeprefix("/api/history/files/"))
            candidate = (CHERRY_HISTORY_DIR / file_name).resolve()
            history_root = CHERRY_HISTORY_DIR.resolve()
            if history_root not in candidate.parents or not candidate.is_file():
                self.send_json(404, {"error": "History file not found"}, send_body=send_body)
                return True

            content = candidate.read_text(errors="ignore")
            payload = {
                "id": candidate.name,
                "title": history_title(content, candidate.stem),
                "updated_at": datetime.fromtimestamp(candidate.stat().st_mtime).isoformat(),
                "size": candidate.stat().st_size,
                "content": content,
            }
            self.send_json(200, payload, send_body=send_body)
            return True

        return False

    def read_json_body(self) -> dict[str, object]:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length > MAX_REQUEST_BODY_BYTES:
            raise ValueError("Request body too large")
        raw = self.rfile.read(content_length) if content_length else b"{}"
        if not raw:
            return {}
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise json.JSONDecodeError("Body must be a JSON object", raw.decode("utf-8", "ignore"), 0)
        return data

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Allow", "GET, HEAD, POST, DELETE, OPTIONS")
        self.append_common_headers()
        self.end_headers()

    def serve_static(self, send_body: bool) -> None:
        parsed = urllib.parse.urlparse(self.path)
        relative_path = parsed.path.lstrip("/") or "index.html"
        candidate = (STATIC_DIR / relative_path).resolve()
        static_root = STATIC_DIR.resolve()

        if static_root not in candidate.parents and candidate != static_root:
            self.send_error(404, "Not found")
            return
        if not candidate.is_file():
            self.send_error(404, "Not found")
            return

        content = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", guess_mime_type(candidate))
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.append_session_cookie()
        self.append_common_headers()
        self.end_headers()
        if send_body:
            self.wfile.write(content)

    def proxy_request(self, send_body: bool) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if not self.ensure_api_auth(send_body=send_body):
            return

        upstream_path = parsed.path[len("/api") :] or "/"
        if not any(upstream_path == prefix or upstream_path.startswith(f"{prefix}/") for prefix in ALLOWED_PROXY_PREFIXES):
            self.send_json(404, {"error": "Unsupported API path."}, send_body=send_body)
            return
        upstream_url = f"{CHERRY_BASE_URL}{upstream_path}"
        if parsed.query:
            upstream_url = f"{upstream_url}?{parsed.query}"

        try:
            api_key = load_cherry_api_key()
        except RuntimeError as exc:
            self.send_json(503, {"error": str(exc)}, send_body=send_body)
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length > MAX_REQUEST_BODY_BYTES:
            self.send_json(413, {"error": "Request body too large"}, send_body=send_body)
            return
        body = self.rfile.read(content_length) if content_length else None
        headers = {"Authorization": f"Bearer {api_key}"}

        for header in ("Content-Type", "Accept", "Cache-Control", "Last-Event-ID"):
            value = self.headers.get(header)
            if value:
                headers[header] = value

        request = urllib.request.Request(upstream_url, data=body, headers=headers, method=self.command)

        try:
            with urllib.request.urlopen(request, timeout=3600) as response:
                self.send_response(response.status)
                for header, value in response.headers.items():
                    lower = header.lower()
                    if lower in HOP_BY_HOP_HEADERS:
                        continue
                    if lower == "content-length" and response.headers.get_content_type() == "text/event-stream":
                        continue
                    self.send_header(header, value)
                self.append_common_headers()
                self.end_headers()

                if send_body:
                    while True:
                        chunk = response.read(8192)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            self.send_response(exc.code)
            content_type = exc.headers.get("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.append_common_headers()
            self.end_headers()
            if send_body:
                self.wfile.write(payload)
        except urllib.error.URLError as exc:
            self.send_json(502, {"error": f"Cherry Studio API unavailable: {exc.reason}"}, send_body=send_body)

    def send_json(self, status: int, payload: object, send_body: bool = True) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.append_common_headers()
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write(f"[CherryMobile] {self.address_string()} - {fmt % args}\n")


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), CherryMobileHandler)
    print(f"Cherry mobile server listening on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
