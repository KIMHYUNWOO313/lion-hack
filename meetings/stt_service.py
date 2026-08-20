import asyncio
import json
import logging
import time
import urllib.error
import urllib.request

import websockets
from django.conf import settings

logger = logging.getLogger(__name__)

OPENAI_REALTIME_WS_URL = "wss://api.openai.com/v1/realtime"
OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"

STT_MODEL = getattr(settings, "STT_MODEL", "gpt-live-transcribe")

STT_KEYWORDS = [
    "공정거래",
    "공정거래법",
    "컴플라이언스",
    "개인정보보호법",
    "하도급법",
    "부정청탁금지법",
    "영업비밀",
    "비밀유지계약",
]


def _parse_languages():
    raw = getattr(settings, "STT_LANGUAGES", "ko")
    if isinstance(raw, (list, tuple)):
        langs = list(raw)
    else:
        langs = [c.strip() for c in str(raw).split(",") if c.strip()]
    # Korean-only lock improves accuracy vs multi-language hints
    return langs or ["ko"]


def _session_config():
    transcription = {
        "model": STT_MODEL,
        "languages": _parse_languages(),
        "keywords": STT_KEYWORDS,
        "delay": getattr(settings, "STT_DELAY", "xhigh"),
    }

    audio_input = {
        "format": {"type": "audio/pcm", "rate": 24000},
        "transcription": transcription,
        "turn_detection": None,
    }

    noise = getattr(settings, "STT_NOISE_REDUCTION", "")
    if noise in ("near_field", "far_field"):
        audio_input["noise_reduction"] = {"type": noise}

    return {
        "type": "transcription",
        "audio": {"input": audio_input},
    }


def _create_client_secret(api_key: str) -> str:
    payload = {"session": _session_config()}
    req = urllib.request.Request(
        OPENAI_CLIENT_SECRETS_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["value"]


async def _connect_transcription(api_key: str):
    secret = await asyncio.to_thread(_create_client_secret, api_key)
    headers_list = [
        {"Authorization": f"Bearer {secret}"},
        {"Authorization": f"Bearer {secret}", "OpenAI-Beta": "realtime=v1"},
    ]
    last_err = None
    for headers in headers_list:
        for kw in (
            {"additional_headers": headers},
            {"extra_headers": list(headers.items())},
        ):
            try:
                return await websockets.connect(
                    OPENAI_REALTIME_WS_URL,
                    ping_interval=20,
                    ping_timeout=20,
                    max_size=8 * 1024 * 1024,
                    **kw,
                )
            except TypeError as exc:
                last_err = exc
            except Exception as exc:
                last_err = exc
    raise RuntimeError(f"STT WebSocket connect failed: {last_err}")


def _extract_text(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get("text") or value.get("transcript") or value.get("delta") or ""
    return ""


def _extract_delta(event: dict) -> str:
    for key in ("delta", "text"):
        text = _extract_text(event.get(key))
        if text:
            return text
    for key in ("transcription", "transcript"):
        text = _extract_text(event.get(key))
        if text:
            return text
    return ""


def _extract_transcript(event: dict) -> str:
    for key in ("transcript", "text"):
        text = _extract_text(event.get(key))
        if text:
            return text.strip()
    text = _extract_text(event.get("transcription"))
    if text:
        return text.strip()
    return ""


class TranscriptionSession:
    """OpenAI GA Realtime transcription (gpt-live-transcribe only)."""

    def __init__(
        self,
        participant_name: str,
        on_delta,
        on_completed,
        on_error=None,
        on_ready=None,
    ):
        self.participant_name = participant_name
        self.on_delta = on_delta
        self.on_completed = on_completed
        self.on_error = on_error
        self.on_ready = on_ready
        self._ws = None
        self._task = None
        self._running = False
        self._ready = False
        self._item_counter = 0
        self._last_audio_at = 0.0
        self._last_commit_at = 0.0
        self._commit_task = None
        self._pending_audio = []
        self._has_audio_since_commit = False

    async def start(self):
        api_key = settings.OPENAI_API_KEY
        if not api_key:
            raise RuntimeError("OpenAI API key missing")

        self._ws = await _connect_transcription(api_key)
        self._running = True
        self._task = asyncio.create_task(self._listen())
        self._schedule_commit()
        logger.info("STT started for %s model=%s", self.participant_name, STT_MODEL)

    @property
    def model(self):
        return STT_MODEL

    async def stop(self):
        self._running = False
        if self._commit_task:
            self._commit_task.cancel()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._ws:
            await self._ws.close()
        self._ws = None

    async def append_audio(self, audio_b64: str, level: float = 0.0):
        if not self._running or not self._ws:
            return

        if not self._ready:
            self._pending_audio.append(audio_b64)
            if len(self._pending_audio) > 120:
                self._pending_audio.pop(0)
            return

        for chunk in self._pending_audio:
            await self._ws.send(
                json.dumps({"type": "input_audio_buffer.append", "audio": chunk})
            )
        self._pending_audio.clear()

        if level >= float(getattr(settings, "STT_MIN_LEVEL", "0.001")):
            now = time.monotonic()
            self._last_audio_at = now
            if not self._has_audio_since_commit:
                # Start the max-turn timer at the first voiced frame.
                # Treating an unset last_commit_at as an expired timer used to
                # commit the first 100 ms immediately, destroying Korean context.
                self._last_commit_at = now
            self._has_audio_since_commit = True

        await self._ws.send(
            json.dumps({"type": "input_audio_buffer.append", "audio": audio_b64})
        )

    def _schedule_commit(self):
        if self._commit_task and not self._commit_task.done():
            self._commit_task.cancel()

        async def _wait_and_commit():
            silence = float(getattr(settings, "STT_COMMIT_SILENCE_SEC", "2.5"))
            max_interval = float(getattr(settings, "STT_COMMIT_MAX_INTERVAL_SEC", "20"))
            try:
                while self._running:
                    await asyncio.sleep(0.2)
                    if not self._has_audio_since_commit:
                        continue
                    now = time.monotonic()
                    since_audio = now - self._last_audio_at if self._last_audio_at else 999
                    since_commit = now - self._last_commit_at
                    if since_audio >= silence:
                        await self._commit_buffer()
                    elif since_commit >= max_interval:
                        await self._commit_buffer()
            except asyncio.CancelledError:
                pass

        self._commit_task = asyncio.create_task(_wait_and_commit())

    async def _commit_buffer(self):
        if not self._ws or not self._running or not self._has_audio_since_commit:
            return
        self._last_commit_at = time.monotonic()
        self._has_audio_since_commit = False
        await self._ws.send(json.dumps({"type": "input_audio_buffer.commit"}))

    async def _listen(self):
        try:
            async for raw in self._ws:
                if not self._running:
                    break
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                await self._handle_event(event)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.exception("STT listen error")
            if self.on_error:
                await self.on_error(str(exc))

    async def _set_ready(self):
        if self._ready:
            return
        self._ready = True
        if self.on_ready:
            await self.on_ready(STT_MODEL)

    async def _handle_event(self, event: dict):
        etype = event.get("type", "")

        if etype in (
            "session.created",
            "session.updated",
            "transcription_session.updated",
            "transcription_session.created",
        ):
            await self._set_ready()
            return

        if etype == "error":
            msg = event.get("error", {}).get("message", "STT error")
            logger.error("STT event error: %s", msg)
            if self.on_error:
                await self.on_error(msg)
            return

        if etype.endswith(".delta") and "transcri" in etype.lower():
            delta = _extract_delta(event)
            if not delta or _is_prompt_echo(delta):
                return
            item_id = (
                event.get("item_id")
                or event.get("event_id")
                or str(self._item_counter)
            )
            await self.on_delta(item_id, delta)
            return

        if etype.endswith(".completed") and "transcri" in etype.lower():
            transcript = _extract_transcript(event)
            if not transcript or _is_prompt_echo(transcript):
                return
            self._item_counter += 1
            item_id = event.get("item_id") or str(self._item_counter)
            await self.on_completed(item_id, transcript)
            return

        if etype in (
            "conversation.item.input_audio_transcription.delta",
            "input_audio_transcription.delta",
            "transcription.delta",
            "transcription.text.delta",
        ):
            delta = _extract_delta(event)
            if not delta or _is_prompt_echo(delta):
                return
            item_id = event.get("item_id") or event.get("event_id") or str(self._item_counter)
            await self.on_delta(item_id, delta)
            return

        if etype in (
            "conversation.item.input_audio_transcription.completed",
            "input_audio_transcription.completed",
            "transcription.completed",
            "transcription.text.done",
            "transcription.text.completed",
        ):
            transcript = _extract_transcript(event)
            if not transcript or _is_prompt_echo(transcript):
                return
            self._item_counter += 1
            item_id = event.get("item_id") or str(self._item_counter)
            await self.on_completed(item_id, transcript)
            return

        if etype == "input_audio_buffer.speech_started":
            self._item_counter += 1
            return

        if "transcri" in etype.lower() and etype not in ("session.created",):
            logger.debug("STT unhandled event: %s keys=%s", etype, list(event.keys()))


def _is_prompt_echo(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    echo_markers = ("화상회의 실시간", "정확히 전사합니다", "한국어 우선")
    return any(m in t for m in echo_markers)
