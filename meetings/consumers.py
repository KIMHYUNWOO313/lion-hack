import asyncio
import json
import logging
import time
import uuid

from channels.generic.websocket import AsyncWebsocketConsumer
from django.conf import settings

from .firebase_store import save_chat_message_sync, save_transcript_message_sync
from .legal_countries import LEGAL_COUNTRIES, VALID_COUNTRY_CODES
from .legal_alternatives_service import suggest_compliant_alternatives
from .legal_risk_service import detect_legal_risk
from .legal_service import ask_legal_advisor
from .room_registry import add_participant, get_channel, remove_participant
from .stt_service import TranscriptionSession

logger = logging.getLogger(__name__)


class MeetingConsumer(AsyncWebsocketConsumer):
    """WebSocket consumer: WebRTC signaling, chat, legal advisor, realtime STT + risk."""

    async def connect(self):
        self.room_id = self.scope["url_route"]["kwargs"]["room_id"]
        self.room_group = f"meeting_{self.room_id}"
        self.participant_id = str(uuid.uuid4())
        self.participant_name = None
        self._joined = False
        self.my_country = "KR"
        self.partner_countries = []
        self.meeting_context = ""
        self.stt_session = None
        self._join_time = time.time()
        self.recording_session_id = None

        await self.channel_layer.group_add(self.room_group, self.channel_name)
        await self.accept()

    async def disconnect(self, close_code):
        if self.stt_session:
            await self.stt_session.stop()
            self.stt_session = None

        if self._joined:
            await remove_participant(self.room_id, self.participant_id)
            await self.channel_layer.group_send(
                self.room_group,
                {
                    "type": "relay_message",
                    "sender": self.channel_name,
                    "payload": {
                        "type": "participant-left",
                        "participantId": self.participant_id,
                        "participantName": self.participant_name,
                    },
                },
            )
        await self.channel_layer.group_discard(self.room_group, self.channel_name)

    async def _start_stt(self):
        if not settings.OPENAI_API_KEY or self.stt_session:
            return
        try:
            self.stt_session = TranscriptionSession(
                participant_name=self.participant_name,
                on_delta=self._on_stt_delta,
                on_completed=self._on_stt_completed,
                on_error=self._on_stt_error,
                on_ready=self._on_stt_ready,
            )
            await self.stt_session.start()
        except Exception as exc:
            logger.exception("STT start failed")
            self.stt_session = None
            await self.send(
                text_data=json.dumps({"type": "stt-error", "message": str(exc)})
            )

    async def _on_stt_ready(self, model: str):
        await self.send(text_data=json.dumps({"type": "stt-ready", "model": model}))

    async def _on_stt_delta(self, item_id: str, delta: str):
        elapsed = int(time.time() - self._join_time)
        payload = {
            "type": "transcript-delta",
            "fromId": self.participant_id,
            "fromName": self.participant_name,
            "itemId": item_id,
            "delta": delta,
            "elapsedSec": elapsed,
        }
        await self.send(text_data=json.dumps(payload))
        await self.channel_layer.group_send(
            self.room_group,
            {
                "type": "relay_message",
                "sender": self.channel_name,
                "payload": payload,
            },
        )

    async def _on_stt_completed(self, item_id: str, transcript: str):
        elapsed = int(time.time() - self._join_time)
        payload = {
            "type": "transcript-completed",
            "fromId": self.participant_id,
            "fromName": self.participant_name,
            "itemId": item_id,
            "transcript": transcript,
            "elapsedSec": elapsed,
        }
        await self.send(text_data=json.dumps(payload))
        await self.channel_layer.group_send(
            self.room_group,
            {
                "type": "relay_message",
                "sender": self.channel_name,
                "payload": payload,
            },
        )
        asyncio.create_task(self._analyze_risk(transcript, elapsed, item_id))
        if self.recording_session_id:
            asyncio.create_task(
                self._persist_transcript(transcript, elapsed, item_id)
            )

    async def _persist_transcript(self, transcript: str, elapsed_sec: int, item_id: str):
        await asyncio.to_thread(
            save_transcript_message_sync,
            self.room_id,
            self.recording_session_id,
            self.participant_id,
            self.participant_name or "",
            transcript,
            item_id,
            elapsed_sec,
        )

    async def _on_stt_error(self, message: str):
        await self.send(text_data=json.dumps({"type": "stt-error", "message": message}))

    async def _analyze_risk(self, transcript: str, elapsed_sec: int, item_id: str):
        risk = await detect_legal_risk(
            transcript,
            self.participant_name,
            self.my_country,
            self.partner_countries,
            self.meeting_context,
        )
        if not risk:
            return

        risk["fromId"] = self.participant_id
        risk["fromName"] = self.participant_name
        risk["itemId"] = item_id
        risk["elapsedSec"] = elapsed_sec
        risk["windowStart"] = max(0, elapsed_sec - 30)
        risk["windowEnd"] = elapsed_sec + 5

        payload = {"type": "risk-detected", **risk}
        await self.send(text_data=json.dumps(payload))
        await self.channel_layer.group_send(
            self.room_group,
            {
                "type": "relay_message",
                "sender": self.channel_name,
                "payload": payload,
            },
        )

    async def receive(self, text_data=None, bytes_data=None):
        if not text_data:
            return

        try:
            data = json.loads(text_data)
        except json.JSONDecodeError:
            return

        msg_type = data.get("type")

        if msg_type == "join":
            self.participant_name = (data.get("name") or f"참가자-{self.participant_id[:6]}").strip()[
                :50
            ]
            self._joined = True
            self._join_time = time.time()

            existing = await add_participant(
                self.room_id,
                self.participant_id,
                self.participant_name,
                self.channel_name,
            )

            await self.channel_layer.group_send(
                self.room_group,
                {
                    "type": "relay_message",
                    "sender": self.channel_name,
                    "payload": {
                        "type": "participant-joined",
                        "participantId": self.participant_id,
                        "participantName": self.participant_name,
                    },
                },
            )

            await self.send(
                text_data=json.dumps(
                    {
                        "type": "welcome",
                        "participantId": self.participant_id,
                        "participantName": self.participant_name,
                        "participants": existing,
                        "legalCountries": LEGAL_COUNTRIES,
                        "legalEnabled": bool(settings.OPENAI_API_KEY),
                        "sttEnabled": bool(settings.OPENAI_API_KEY),
                        "sttModel": (
                            self.stt_session.model
                            if self.stt_session
                            else getattr(settings, "STT_MODEL", "gpt-live-transcribe")
                        ),
                    }
                )
            )

            if settings.OPENAI_API_KEY:
                await self._start_stt()
            return

        if msg_type == "stt-audio":
            if self.stt_session and self._joined:
                await self.stt_session.append_audio(
                    data.get("audio") or "",
                    float(data.get("level") or 0),
                )
            return

        if msg_type == "legal-settings":
            my_country = (data.get("myCountry") or "KR").upper()[:2]
            if my_country in VALID_COUNTRY_CODES:
                self.my_country = my_country
            partners = data.get("partnerCountries") or []
            self.partner_countries = [
                c.upper()[:2] for c in partners if c.upper()[:2] in VALID_COUNTRY_CODES
            ][:8]
            self.meeting_context = (data.get("meetingContext") or "")[:1000]
            return

        if msg_type == "legal-query":
            if not self._joined:
                return
            message = (data.get("message") or "").strip()
            if not message:
                return

            my_country = (data.get("myCountry") or self.my_country or "KR").upper()[:2]
            if my_country not in VALID_COUNTRY_CODES:
                my_country = "KR"
            partners = data.get("partnerCountries") or self.partner_countries
            partner_list = [
                c.upper()[:2] for c in partners if c.upper()[:2] in VALID_COUNTRY_CODES
            ][:8]
            context = (data.get("meetingContext") or self.meeting_context or "")[:1000]
            history = data.get("history") or []

            await self.send(
                text_data=json.dumps({"type": "legal-typing", "active": True})
            )

            result = await ask_legal_advisor(
                message, my_country, partner_list, context, history
            )

            await self.send(
                text_data=json.dumps(
                    {
                        "type": "legal-response",
                        "message": result.get("text", ""),
                        "references": result.get("references", []),
                        "myCountry": my_country,
                        "partnerCountries": partner_list,
                    }
                )
            )
            return

        if msg_type == "legal-alternatives":
            if not self._joined:
                return
            risk = data.get("risk") or {}
            if not (risk.get("title") or risk.get("summary")):
                return

            my_country = (data.get("myCountry") or self.my_country or "KR").upper()[:2]
            if my_country not in VALID_COUNTRY_CODES:
                my_country = "KR"
            partners = data.get("partnerCountries") or self.partner_countries
            partner_list = [
                c.upper()[:2] for c in partners if c.upper()[:2] in VALID_COUNTRY_CODES
            ][:8]
            context = (data.get("meetingContext") or self.meeting_context or "")[:1000]

            await self.send(
                text_data=json.dumps({"type": "legal-alternatives-typing", "active": True})
            )

            result = await suggest_compliant_alternatives(
                risk, my_country, partner_list, context
            )

            await self.send(
                text_data=json.dumps(
                    {
                        "type": "legal-alternatives-response",
                        "summary": result.get("summary", ""),
                        "alternatives": result.get("alternatives", []),
                        "questionsToConfirm": result.get("questionsToConfirm", []),
                    }
                )
            )
            return

        if msg_type == "legal-share":
            if not self._joined:
                return
            summary = (data.get("summary") or "")[:1500]
            title = (data.get("title") or "법률·세무 알림")[:120]
            severity = (data.get("severity") or "medium")[:10]
            countries = data.get("countries") or []
            if not summary:
                return

            await self.channel_layer.group_send(
                self.room_group,
                {
                    "type": "relay_message",
                    "sender": self.channel_name,
                    "payload": {
                        "type": "legal-alert",
                        "fromId": self.participant_id,
                        "fromName": self.participant_name,
                        "title": title,
                        "summary": summary,
                        "severity": severity,
                        "countries": countries,
                        "myCountry": self.my_country,
                    },
                },
            )
            return

        if msg_type in ("offer", "answer", "ice-candidate", "media-state"):
            payload = dict(data)
            payload["fromId"] = self.participant_id
            payload["fromName"] = self.participant_name

            target_id = data.get("targetId")
            if target_id:
                target_channel = await get_channel(self.room_id, target_id)
                if target_channel:
                    await self.channel_layer.send(
                        target_channel,
                        {"type": "direct_message", "payload": payload},
                    )
                    return

            await self.channel_layer.group_send(
                self.room_group,
                {
                    "type": "relay_message",
                    "sender": self.channel_name,
                    "payload": payload,
                },
            )
            return

        if msg_type == "recording-session":
            session_id = (data.get("sessionId") or "").strip()[:128]
            if session_id:
                self.recording_session_id = session_id
            return

        if msg_type == "chat":
            message = (data.get("message") or "")[:500]
            session_id = (data.get("recordingSessionId") or self.recording_session_id or "").strip()
            elapsed = int(time.time() - self._join_time)
            await self.channel_layer.group_send(
                self.room_group,
                {
                    "type": "relay_message",
                    "sender": self.channel_name,
                    "payload": {
                        "type": "chat",
                        "fromId": self.participant_id,
                        "fromName": self.participant_name,
                        "message": message,
                        "elapsedSec": elapsed,
                        "recordingSessionId": session_id,
                    },
                },
            )
            if session_id and message:
                asyncio.create_task(
                    self._persist_chat(message, session_id, elapsed)
                )
            return

    async def _persist_chat(self, message: str, session_id: str, elapsed_sec: int):
        await asyncio.to_thread(
            save_chat_message_sync,
            self.room_id,
            session_id,
            self.participant_id,
            self.participant_name or "",
            message,
            elapsed_sec,
        )

    async def relay_message(self, event):
        if event["sender"] == self.channel_name:
            return
        await self.send(text_data=json.dumps(event["payload"]))

    async def direct_message(self, event):
        await self.send(text_data=json.dumps(event["payload"]))
