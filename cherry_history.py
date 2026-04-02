from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent
LOCAL_STORAGE_DIR = Path.home() / "Library/Application Support/CherryStudio/Local Storage/leveldb"
INDEXEDDB_DIR = Path.home() / "Library/Application Support/CherryStudio/IndexedDB/file__0.indexeddb.leveldb"
EXTRACTOR = ROOT / "extract_persist.js"

UUID_BYTES_RE = re.compile(rb"[0-9a-f-]{36}")
BLOCK_ID_RE = re.compile(rb'"\$([0-9a-f-]{36})')
TOPIC_CONTAINER_RE = re.compile(rb'o"\x02id"\$([0-9a-f-]{36})"\x08messages[Aa]')
BLOCK_OBJECT_RE = re.compile(rb'o"\x02id"\$([0-9a-f-]{36})"\tmessageId"\$([0-9a-f-]{36})')
UNUSUAL_TEXT_RUN_RE = re.compile(r"[^\x09\x0A\x0D\x20-\x7E\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]{6,}")
STATUS_RANK = {"error": 0, "pending": 1, "processing": 2, "streaming": 3, "success": 4}
TEXT_BLOCK_TYPES = {"main_text", "thinking", "translation", "error"}
LEGACY_ROLE_VALUES = {"user", "assistant", "system", "tool"}
CONTENT_MARKERS = (b'content"', b"contentc", b"content\x00c")
UTF16_CONTENT_MARKERS = {b"contentc", b"content\x00c"}
SNAPSHOT_CACHE: dict[str, object] = {"signature": None, "value": None}
PERSIST_CACHE: dict[str, object] = {"signature": None, "value": None}
SNAPSHOT_CACHE_LOCK = threading.Lock()
PERSIST_CACHE_LOCK = threading.Lock()
FILE_READ_RETRIES = 3
FILE_READ_RETRY_DELAY_SEC = 0.05


def _iter_leveldb_files(path: Path) -> list[Path]:
    try:
        candidates = list(path.glob("*"))
    except OSError:
        return []
    return sorted(
        [candidate for candidate in candidates if candidate.suffix in {".ldb", ".log"}],
        key=lambda candidate: candidate.name,
    )


def _signature_for_files(files: list[Path]) -> tuple[tuple[str, int, int], ...]:
    entries: list[tuple[str, int, int]] = []
    for path in files:
        try:
            stat = path.stat()
        except OSError:
            continue
        entries.append((path.name, stat.st_size, stat.st_mtime_ns))
    return tuple(entries)


def _read_bytes_with_retries(path: Path) -> bytes | None:
    for attempt in range(FILE_READ_RETRIES):
        try:
            return path.read_bytes()
        except OSError:
            if attempt + 1 >= FILE_READ_RETRIES:
                return None
            time.sleep(FILE_READ_RETRY_DELAY_SEC)
    return None


def storage_signature() -> tuple[tuple[str, int, int], ...]:
    files = _iter_leveldb_files(LOCAL_STORAGE_DIR) + _iter_leveldb_files(INDEXEDDB_DIR)
    return _signature_for_files(files)


def local_storage_signature() -> tuple[tuple[str, int, int], ...]:
    files = _iter_leveldb_files(LOCAL_STORAGE_DIR)
    return _signature_for_files(files)


def _read_marker_value(data: bytes, marker: bytes, start: int, limit: int) -> str | None:
    idx = data.find(marker, start, limit)
    if idx == -1:
        return None
    pos = idx + len(marker)
    end = data.find(b'"', pos, limit)
    if end == -1:
        return None
    return data[pos:end].decode("latin1", "ignore")


def _read_len_prefixed_value(data: bytes, marker: bytes, start: int, limit: int) -> str | None:
    idx = data.find(marker, start, limit)
    if idx == -1:
        return None
    pos = idx + len(marker)
    if pos >= limit:
        return None
    length = data[pos]
    raw = data[pos + 1 : pos + 1 + length]
    return raw.decode("latin1", "ignore")


def _parse_varint(data: bytes, start: int) -> tuple[int | None, int]:
    value = 0
    shift = 0
    pos = start
    while pos < len(data):
        byte = data[pos]
        value |= (byte & 0x7F) << shift
        pos += 1
        if byte < 0x80:
            return value, pos
        shift += 7
    return None, start


def _is_common_text_char(char: str) -> bool:
    codepoint = ord(char)
    if char in "\n\r\t":
        return True
    if 0x20 <= codepoint <= 0x7E:
        return True
    if 0x3000 <= codepoint <= 0x303F:
        return True
    if 0x4E00 <= codepoint <= 0x9FFF:
        return True
    if 0xFF00 <= codepoint <= 0xFFEF:
        return True
    return False


def _trim_text_boundary(text: str, index: int) -> str:
    cut = index
    floor = max(0, index - 160)
    while cut > floor and text[cut - 1] not in "\n。！？.!?：:；;)]}> ":
        cut -= 1
    cleaned = text[:cut].rstrip()
    return cleaned or text[:index].rstrip()


def _clean_block_content(text: str) -> str:
    cleaned = text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(cleaned) < 160:
        return cleaned

    cutoff_candidates: list[int] = []

    unusual_match = UNUSUAL_TEXT_RUN_RE.search(cleaned)
    if unusual_match and unusual_match.start() > 120:
        cutoff_candidates.append(unusual_match.start())

    window = 48
    for idx in range(124, max(124, len(cleaned) - window), 4):
        chunk = cleaned[idx : idx + window]
        if not chunk:
            break
        ratio = sum(_is_common_text_char(char) for char in chunk) / len(chunk)
        if ratio < 0.72:
            cutoff_candidates.append(idx)
            break

    if not cutoff_candidates:
        return cleaned

    return _trim_text_boundary(cleaned, min(cutoff_candidates))


def _find_blocks_section(data: bytes, start: int, limit: int) -> int:
    upper_idx = data.find(b"blocksA", start, limit)
    lower_idx = data.find(b"blocksa", start, limit)
    if upper_idx == -1:
        return lower_idx
    if lower_idx == -1:
        return upper_idx
    return min(upper_idx, lower_idx)


def _find_content_marker(data: bytes, start: int, limit: int) -> tuple[int, bytes] | tuple[int, None]:
    first_idx = -1
    marker_used: bytes | None = None

    for marker in CONTENT_MARKERS:
        idx = data.find(marker, start, limit)
        if idx != -1 and (first_idx == -1 or idx < first_idx):
            first_idx = idx
            marker_used = marker

    return first_idx, marker_used


def _looks_utf16le_payload(raw_content: bytes) -> bool:
    if len(raw_content) < 8 or len(raw_content) % 2:
        return False
    sample = raw_content[: min(len(raw_content), 128)]
    if not sample:
        return False
    zero_bytes = sum(1 for byte in sample[1::2] if byte == 0)
    return zero_bytes >= max(4, len(sample[1::2]) // 4)


def _decode_block_content(raw_content: bytes, marker_used: bytes | None) -> str:
    if not raw_content:
        return ""

    if marker_used in UTF16_CONTENT_MARKERS or _looks_utf16le_payload(raw_content):
        decoded = raw_content.decode("utf-16le", "replace")
    else:
        decoded = raw_content.decode("utf-8", "replace")

    return _clean_block_content(decoded)


def _node_binary() -> str:
    for candidate in (
        shutil.which("node"),
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/bin/node",
    ):
        if candidate and Path(candidate).exists():
            return candidate
    raise RuntimeError("Node.js binary not found for Cherry history extraction")


def _load_assistants_state() -> dict[str, object]:
    return get_persist_state()["assistants"]  # type: ignore[return-value]


def _read_persist_outer() -> dict[str, object]:
    try:
        result = subprocess.run(
            [_node_binary(), str(EXTRACTOR), "--outer"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Timed out while reading Cherry Studio local storage") from exc
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or "Failed to read Cherry Studio local storage"
        raise RuntimeError(message)
    output = result.stdout.strip()
    if not output:
        raise RuntimeError("Cherry Studio local storage reader returned no data")
    try:
        payload = json.loads(output)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Failed to parse Cherry Studio local storage output") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("Cherry Studio local storage reader returned an unexpected payload")
    return payload


def _parse_persist_value(value: object) -> object:
    if not isinstance(value, str):
        return value
    if not value:
        return {}
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def get_persist_state() -> dict[str, object]:
    signature = local_storage_signature()
    with PERSIST_CACHE_LOCK:
        if PERSIST_CACHE["signature"] == signature and PERSIST_CACHE["value"]:
            return PERSIST_CACHE["value"]  # type: ignore[return-value]

    try:
        outer = _read_persist_outer()
    except Exception:
        with PERSIST_CACHE_LOCK:
            cached = PERSIST_CACHE["value"]
        if cached:
            return cached  # type: ignore[return-value]
        raise

    parsed = {key: _parse_persist_value(value) for key, value in outer.items()}
    persist_state = {
        "assistants": parsed.get("assistants") or {},
        "llm": parsed.get("llm") or {},
        "codeTools": parsed.get("codeTools") or {},
        "openclaw": parsed.get("openclaw") or {},
        "raw": outer,
    }
    with PERSIST_CACHE_LOCK:
        PERSIST_CACHE["signature"] = signature
        PERSIST_CACHE["value"] = persist_state
    return persist_state


def _parse_indexeddb() -> tuple[dict[str, dict[str, object]], dict[str, dict[str, object]]]:
    messages: dict[str, dict[str, object]] = {}
    blocks: dict[str, dict[str, object]] = {}
    marker = b'o"\x02id"$'

    for file_index, path in enumerate(_iter_leveldb_files(INDEXEDDB_DIR)):
        data = _read_bytes_with_retries(path)
        if data is None:
            continue
        start = 0

        while True:
            pos = data.find(marker, start)
            if pos == -1:
                break

            id_start = pos + len(marker)
            entity_id = data[id_start : id_start + 36]
            if not UUID_BYTES_RE.fullmatch(entity_id):
                start = pos + 1
                continue

            entity_id_text = entity_id.decode()
            entity_end = id_start + 36
            window_end = min(len(data), pos + 16000)

            role_idx = data.find(b'role"', entity_end, min(window_end, entity_end + 40))
            if role_idx != -1:
                role_pos = role_idx + len(b'role"')
                role_length = data[role_pos]
                role = data[role_pos + 1 : role_pos + 1 + role_length].decode("latin1", "ignore")
                topic_id = _read_marker_value(data, b'topicId"$', entity_end, window_end)
                assistant_id = _read_marker_value(data, b'assistantId"$', entity_end, window_end)
                created_at = _read_marker_value(data, b'createdAt"\x18', entity_end, window_end)
                status = _read_len_prefixed_value(data, b'status"', entity_end, window_end)
                blocks_idx = _find_blocks_section(data, entity_end, window_end)

                if topic_id and assistant_id and created_at and status and blocks_idx != -1:
                    stop_candidates = []
                    for stop_marker in (b'modelId"', b'askId"', b'metricso', b'citationReferences', marker):
                        stop_idx = data.find(stop_marker, blocks_idx + 7, window_end)
                        if stop_idx != -1:
                            stop_candidates.append(stop_idx)
                    blocks_limit = min(stop_candidates) if stop_candidates else window_end
                    block_ids = [match.decode() for match in BLOCK_ID_RE.findall(data[blocks_idx:blocks_limit])]
                    candidate = {
                        "id": entity_id_text,
                        "role": role,
                        "topicId": topic_id,
                        "assistantId": assistant_id,
                        "createdAt": created_at,
                        "status": status,
                        "blockIds": block_ids,
                        "_rank": (STATUS_RANK.get(status, -1), len(block_ids), file_index, pos),
                    }
                    previous = messages.get(entity_id_text)
                    if previous is None or candidate["_rank"] >= previous["_rank"]:
                        messages[entity_id_text] = candidate

            message_idx = data.find(b'messageId"$', entity_end, min(window_end, entity_end + 40))
            if message_idx != -1:
                message_id = _read_marker_value(data, b'messageId"$', entity_end, window_end)
                block_type = _read_len_prefixed_value(data, b'type"', entity_end, window_end)
                created_at = _read_marker_value(data, b'createdAt"\x18', entity_end, window_end)
                status = _read_len_prefixed_value(data, b'status"', entity_end, window_end)
                content_idx, content_marker = _find_content_marker(data, entity_end, window_end)

                if message_id and block_type and created_at and status and content_idx != -1:
                    content_length, content_start = _parse_varint(data, content_idx + len(content_marker or b""))
                    if content_length is not None and 0 <= content_length <= len(data) - content_start:
                        raw_content = data[content_start : content_start + content_length]
                        content = _decode_block_content(raw_content, content_marker)
                        candidate = {
                            "id": entity_id_text,
                            "messageId": message_id,
                            "type": block_type,
                            "createdAt": created_at,
                            "status": status,
                            "content": content,
                            "_rank": (STATUS_RANK.get(status, -1), len(content), file_index, pos),
                        }
                        previous = blocks.get(entity_id_text)
                        if previous is None or candidate["_rank"] >= previous["_rank"]:
                            blocks[entity_id_text] = candidate

            start = pos + 1

    return messages, blocks


def _blocks_by_message_id(raw_blocks: dict[str, dict[str, object]]) -> dict[str, list[dict[str, object]]]:
    mapping: dict[str, list[dict[str, object]]] = {}

    for block in raw_blocks.values():
        mapping.setdefault(str(block["messageId"]), []).append(block)

    for block_list in mapping.values():
        block_list.sort(key=lambda item: (str(item["createdAt"]), str(item["id"])))

    return mapping


def _join_block_content(blocks: list[dict[str, object]]) -> str:
    return "\n\n".join(
        str(block["content"]).strip()
        for block in blocks
        if block.get("type") in TEXT_BLOCK_TYPES and str(block.get("content") or "").strip()
    ).strip()


def _legacy_content_suggests_assistant(content: str) -> bool:
    stripped = content.lstrip()
    return bool(
        content
        and (
            "</thinking>" in content
            or stripped.startswith("<thinking>")
            or stripped.startswith("#")
            or stripped.startswith("---")
            or stripped.startswith("```")
        )
    )


def _infer_legacy_role(exact_role: str | None, data: bytes, content: str) -> str | None:
    head = data[:512]

    if _legacy_content_suggests_assistant(content):
        return "assistant"
    if exact_role in LEGACY_ROLE_VALUES:
        return exact_role
    if b"askId" in head:
        return "assistant"
    if b"modelId" in head or b"assistantId" in data[:160]:
        return "user"
    if content:
        return "user"
    return None


def _extract_legacy_block_ids(data: bytes) -> list[str]:
    blocks_idx = _find_blocks_section(data, 0, len(data))
    if blocks_idx == -1:
        return []

    stop_candidates = []
    for stop_marker in (b'modelId"', b'askId"', b'metricso', b'citationReferences', b'role"', b'o"\x02id"$'):
        stop_idx = data.find(stop_marker, blocks_idx + 7)
        if stop_idx != -1:
            stop_candidates.append(stop_idx)

    blocks_limit = min(stop_candidates) if stop_candidates else len(data)
    return [match.decode() for match in BLOCK_ID_RE.findall(data[blocks_idx:blocks_limit])]


def _created_within_topic_range(created_at: str | None, topic_meta: dict[str, object]) -> bool:
    created = str(created_at or "")
    if not created:
        return False

    lower = str(topic_meta.get("createdAt") or "")
    upper = str(topic_meta.get("updatedAt") or "")

    if lower and created < lower:
        return False
    if upper and created > upper:
        return False
    return True


def _legacy_topic_lookup(assistants_state: dict[str, object]) -> dict[str, dict[str, object]]:
    lookup: dict[str, dict[str, object]] = {}

    for assistant in assistants_state.get("assistants", []):
        for topic in assistant.get("topics", []) or []:
            topic_id = str(topic["id"])
            lookup[topic_id] = {
                "id": topic_id,
                "assistantId": str(topic.get("assistantId") or assistant["id"]),
                "name": str(topic.get("name") or "未命名话题"),
                "createdAt": topic.get("createdAt"),
                "updatedAt": topic.get("updatedAt"),
            }

    return lookup


def _parse_legacy_topic_messages(
    assistants_state: dict[str, object],
    raw_blocks: dict[str, dict[str, object]],
) -> dict[str, dict[str, object]]:
    topic_lookup = _legacy_topic_lookup(assistants_state)
    if not topic_lookup:
        return {}

    blocks_by_message_id = _blocks_by_message_id(raw_blocks)
    block_message_ids = set(blocks_by_message_id)
    legacy_messages: dict[str, dict[str, object]] = {}

    for file_index, path in enumerate(_iter_leveldb_files(INDEXEDDB_DIR)):
        data = _read_bytes_with_retries(path)
        if data is None:
            continue
        containers = [
            (match.start(), match.group(1).decode())
            for match in TOPIC_CONTAINER_RE.finditer(data)
            if match.group(1).decode() in topic_lookup
        ]
        if not containers:
            continue

        containers.sort()
        block_starts = [match.start() for match in BLOCK_OBJECT_RE.finditer(data)]

        for idx, (pos, topic_id) in enumerate(containers):
            end_candidates = []

            if idx + 1 < len(containers):
                end_candidates.append(containers[idx + 1][0])

            next_block = next((block_pos for block_pos in block_starts if block_pos > pos + 64), None)
            if next_block is not None:
                end_candidates.append(next_block)

            chunk_end = min(end_candidates) if end_candidates else len(data)
            chunk = data[pos:chunk_end]
            topic_meta = topic_lookup[topic_id]

            candidate_positions: list[tuple[int, str, str]] = []
            first_role_idx = chunk.find(b'role"')
            if first_role_idx != -1:
                prefix = chunk[max(0, first_role_idx - 96) : first_role_idx]
                prefix_ids = [match.group().decode() for match in UUID_BYTES_RE.finditer(prefix)]
                if prefix_ids:
                    first_message_id = prefix_ids[-1]
                    message_pos = chunk.find(first_message_id.encode())
                    if message_pos != -1:
                        candidate_positions.append((message_pos, first_message_id, "first"))

            for match in UUID_BYTES_RE.finditer(chunk):
                message_id = match.group().decode()
                if message_id in block_message_ids:
                    candidate_positions.append((match.start(), message_id, "block"))

            ordered_candidates: list[tuple[int, str, str]] = []
            seen_message_ids: set[str] = set()
            for candidate in sorted(candidate_positions):
                if candidate[1] in seen_message_ids:
                    continue
                seen_message_ids.add(candidate[1])
                ordered_candidates.append(candidate)

            for candidate_index, (candidate_pos, message_id, source) in enumerate(ordered_candidates):
                slice_end = (
                    ordered_candidates[candidate_index + 1][0]
                    if candidate_index + 1 < len(ordered_candidates)
                    else len(chunk)
                )
                candidate_slice = chunk[candidate_pos:slice_end]
                candidate_blocks = blocks_by_message_id.get(message_id, [])
                content = _join_block_content(candidate_blocks)
                exact_role = _read_len_prefixed_value(candidate_slice, b'role"', 0, min(len(candidate_slice), 32))
                role = _infer_legacy_role(exact_role, candidate_slice, content)
                created_at = _read_marker_value(candidate_slice, b'createdAt"\x18', 0, min(len(candidate_slice), 256))
                status = _read_len_prefixed_value(candidate_slice, b'status"', 0, min(len(candidate_slice), 96))

                if not created_at and candidate_blocks:
                    created_at = str(candidate_blocks[0]["createdAt"])
                if not status and candidate_blocks:
                    status = str(candidate_blocks[0]["status"])

                if not _created_within_topic_range(created_at, topic_meta):
                    continue

                if not content and role == "user" and source == "first":
                    content = str(topic_meta["name"])

                block_ids = [str(block["id"]) for block in candidate_blocks] or _extract_legacy_block_ids(candidate_slice)
                if not role or not content and not block_ids:
                    continue

                candidate = {
                    "id": message_id,
                    "role": role,
                    "assistantId": str(topic_meta["assistantId"]),
                    "topicId": str(topic_meta["id"]),
                    "createdAt": created_at,
                    "status": status or "success",
                    "content": content,
                    "blockIds": block_ids,
                    "_rank": (
                        STATUS_RANK.get(str(status or "success"), -1),
                        1 if content else 0,
                        len(content),
                        len(block_ids),
                        file_index,
                        pos + candidate_pos,
                    ),
                }
                previous = legacy_messages.get(message_id)
                if previous is None or candidate["_rank"] >= previous["_rank"]:
                    legacy_messages[message_id] = candidate

    return legacy_messages


def _topic_preview(messages: list[dict[str, object]]) -> str:
    for message in reversed(messages):
        content = str(message.get("content") or "").strip()
        if content:
            return content[:120]
    return ""


def _build_snapshot() -> dict[str, object]:
    assistants_state = _load_assistants_state()
    raw_messages, raw_blocks = _parse_indexeddb()
    legacy_messages = _parse_legacy_topic_messages(assistants_state, raw_blocks)

    topic_messages: dict[str, list[dict[str, object]]] = {}
    for raw_message in raw_messages.values():
        block_entries = [raw_blocks.get(block_id) for block_id in raw_message["blockIds"]]
        content_parts = [
            str(block["content"]).strip()
            for block in block_entries
            if block and block.get("type") in TEXT_BLOCK_TYPES and str(block.get("content") or "").strip()
        ]
        message = {
            "id": raw_message["id"],
            "role": raw_message["role"],
            "assistantId": raw_message["assistantId"],
            "topicId": raw_message["topicId"],
            "createdAt": raw_message["createdAt"],
            "status": raw_message["status"],
            "content": "\n\n".join(content_parts).strip(),
            "blockIds": list(raw_message["blockIds"]),
        }
        topic_messages.setdefault(str(raw_message["topicId"]), []).append(message)

    for legacy_message in legacy_messages.values():
        if str(legacy_message["id"]) in raw_messages:
            continue
        message = {
            "id": str(legacy_message["id"]),
            "role": str(legacy_message["role"]),
            "assistantId": str(legacy_message["assistantId"]),
            "topicId": str(legacy_message["topicId"]),
            "createdAt": str(legacy_message["createdAt"]),
            "status": str(legacy_message["status"]),
            "content": str(legacy_message.get("content") or "").strip(),
            "blockIds": list(legacy_message.get("blockIds") or []),
        }
        topic_messages.setdefault(str(legacy_message["topicId"]), []).append(message)

    assistants: list[dict[str, object]] = []
    topics: dict[str, dict[str, object]] = {}

    for assistant in assistants_state.get("assistants", []):
        assistant_topics: list[dict[str, object]] = []
        for topic in assistant.get("topics", []) or []:
            topic_id = str(topic["id"])
            messages = sorted(topic_messages.get(topic_id, []), key=lambda item: str(item["createdAt"]))
            topic_payload = {
                "id": topic_id,
                "assistantId": str(topic.get("assistantId") or assistant["id"]),
                "name": str(topic.get("name") or "未命名话题"),
                "createdAt": topic.get("createdAt"),
                "updatedAt": topic.get("updatedAt"),
                "messageCount": len(messages),
                "preview": _topic_preview(messages),
                "messages": messages,
            }
            topics[topic_id] = topic_payload
            assistant_topics.append(
                {
                    "id": topic_id,
                    "name": topic_payload["name"],
                    "createdAt": topic_payload["createdAt"],
                    "updatedAt": topic_payload["updatedAt"],
                    "messageCount": topic_payload["messageCount"],
                    "preview": topic_payload["preview"],
                }
            )

        assistants.append(
            {
                "id": str(assistant["id"]),
                "name": str(assistant.get("name") or "未命名助手"),
                "emoji": str(assistant.get("emoji") or "😀"),
                "type": str(assistant.get("type") or "assistant"),
                "topics": assistant_topics,
            }
        )

    return {"assistants": assistants, "topics": topics}


def get_snapshot() -> dict[str, object]:
    signature = storage_signature()
    with SNAPSHOT_CACHE_LOCK:
        if SNAPSHOT_CACHE["signature"] == signature and SNAPSHOT_CACHE["value"]:
            return SNAPSHOT_CACHE["value"]  # type: ignore[return-value]

    try:
        snapshot = _build_snapshot()
    except Exception:
        with SNAPSHOT_CACHE_LOCK:
            cached = SNAPSHOT_CACHE["value"]
        if cached:
            return cached  # type: ignore[return-value]
        raise

    with SNAPSHOT_CACHE_LOCK:
        SNAPSHOT_CACHE["signature"] = signature
        SNAPSHOT_CACHE["value"] = snapshot
    return snapshot
