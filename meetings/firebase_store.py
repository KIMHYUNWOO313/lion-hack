import logging
from datetime import datetime, timezone

from django.conf import settings

logger = logging.getLogger(__name__)

_firebase_app = None
_db = None


def firebase_enabled() -> bool:
    return bool(getattr(settings, "FIREBASE_SERVICE_ACCOUNT_JSON", ""))


def _ensure_firebase():
    global _firebase_app, _db
    if _db is not None:
        return _db

    import json

    sa_raw = getattr(settings, "FIREBASE_SERVICE_ACCOUNT_JSON", "")
    if not sa_raw:
        return None

    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
    except ImportError:
        logger.warning("firebase-admin not installed")
        return None

    if not firebase_admin._apps:
        cred = credentials.Certificate(json.loads(sa_raw))
        _firebase_app = firebase_admin.initialize_app(
            cred,
            {"storageBucket": settings.FIREBASE_STORAGE_BUCKET},
        )
    _db = firestore.client()
    return _db


def _ts_to_iso(value) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        try:
            if value.tzinfo is None:
                return value.replace(tzinfo=timezone.utc).isoformat()
            return value.isoformat()
        except Exception:
            pass
    if hasattr(value, "timestamp"):
        try:
            return datetime.fromtimestamp(value.timestamp(), tz=timezone.utc).isoformat()
        except Exception:
            pass
    return str(value)


def create_custom_token(firebase_uid: str, display_name: str = "", email: str = "") -> str:
    _ensure_firebase()
    import firebase_admin
    from firebase_admin import auth

    if not firebase_admin._apps:
        raise RuntimeError("Firebase service account is not configured")

    claims = {}
    if display_name:
        claims["name"] = display_name
    if email:
        claims["email"] = email
    return auth.create_custom_token(firebase_uid, claims or None).decode("utf-8")


def _user_can_access_session(data: dict, firebase_uid: str) -> bool:
    if not firebase_uid or not data:
        return False
    started_by = data.get("startedBy") or {}
    if started_by.get("uid") == firebase_uid:
        return True
    if firebase_uid in (data.get("participantUids") or []):
        return True
    for p in data.get("participants") or []:
        if p.get("firebaseUid") == firebase_uid:
            return True
    videos = data.get("videos") or {}
    for info in videos.values():
        if isinstance(info, dict) and info.get("firebaseUid") == firebase_uid:
            return True
    return False


def _serialize_videos(videos: dict | None) -> list:
    items = []
    for participant_id, info in (videos or {}).items():
        if not isinstance(info, dict):
            continue
        chunks = info.get("chunks") or []
        if isinstance(chunks, dict):
            chunks = list(chunks.values())
        chunks = sorted(chunks, key=lambda c: c.get("index", 0) if isinstance(c, dict) else 0)
        items.append(
            {
                "participantId": participant_id,
                "participantName": info.get("participantName") or participant_id[:8],
                "status": info.get("status") or "",
                "chunkCount": info.get("chunkCount") or len(chunks),
                "chunks": [
                    {
                        "index": c.get("index", i),
                        "url": c.get("url", ""),
                        "size": c.get("size", 0),
                    }
                    for i, c in enumerate(chunks)
                    if isinstance(c, dict) and c.get("url")
                ],
            }
        )
    return items


def _serialize_session_summary(room_id: str, session_id: str, data: dict) -> dict:
    videos = data.get("videos") or {}
    chunk_count = 0
    participant_count = 0
    for info in videos.values():
        if not isinstance(info, dict):
            continue
        participant_count += 1
        chunks = info.get("chunks") or []
        if isinstance(chunks, dict):
            chunks = list(chunks.values())
        chunk_count += len(chunks)

    return {
        "roomId": room_id,
        "sessionId": session_id,
        "roomName": data.get("roomName") or "",
        "status": data.get("status") or "unknown",
        "startedAt": _ts_to_iso(data.get("startedAt")),
        "endedAt": _ts_to_iso(data.get("endedAt")),
        "durationSec": data.get("durationSec") or 0,
        "chunkCount": chunk_count,
        "participantCount": participant_count,
    }


def _serialize_session_doc(room_id: str, session_id: str, data: dict) -> dict:
    videos = _serialize_videos(data.get("videos"))
    total_chunks = sum(len(v["chunks"]) for v in videos)
    return {
        "roomId": room_id,
        "sessionId": session_id,
        "roomName": data.get("roomName") or "",
        "status": data.get("status") or "unknown",
        "startedAt": _ts_to_iso(data.get("startedAt")),
        "endedAt": _ts_to_iso(data.get("endedAt")),
        "updatedAt": _ts_to_iso(data.get("updatedAt")),
        "durationSec": data.get("durationSec") or 0,
        "startedBy": data.get("startedBy") or {},
        "participants": data.get("participants") or [],
        "videoTracks": videos,
        "chunkCount": total_chunks,
    }


def list_recordings_for_user_sync(firebase_uid: str, limit: int = 30) -> list:
    db = _ensure_firebase()
    if not db or not firebase_uid:
        return []

    from firebase_admin import firestore

    results = []
    seen = set()

    def collect_from_query(query):
        nonlocal results
        for doc in query.stream():
            data = doc.to_dict() or {}
            room_id = data.get("roomId")
            session_id = data.get("sessionId")
            if not room_id or not session_id:
                try:
                    room_id = doc.reference.parent.parent.id
                    session_id = doc.id
                except Exception:
                    continue
            key = f"{room_id}:{session_id}"
            if key in seen:
                continue
            seen.add(key)

            if data.get("roomId") and data.get("sessionId") and "videos" not in data:
                results.append(
                    {
                        "roomId": room_id,
                        "sessionId": session_id,
                        "roomName": data.get("roomName") or "",
                        "status": data.get("status") or "unknown",
                        "startedAt": _ts_to_iso(data.get("startedAt")),
                        "endedAt": _ts_to_iso(data.get("endedAt")),
                        "durationSec": data.get("durationSec") or 0,
                        "chunkCount": data.get("chunkCount") or 0,
                        "participantCount": data.get("participantCount") or 1,
                    }
                )
            else:
                results.append(_serialize_session_summary(room_id, session_id, data))
            if len(results) >= limit:
                break

    index_attempts = [
        db.collection("userRecordings")
        .document(firebase_uid)
        .collection("sessions")
        .order_by("startedAt", direction=firestore.Query.DESCENDING)
        .limit(limit),
        db.collection("userRecordings")
        .document(firebase_uid)
        .collection("sessions")
        .limit(limit),
    ]

    for q in index_attempts:
        try:
            collect_from_query(q)
            if results:
                results.sort(key=lambda r: r.get("startedAt") or "", reverse=True)
                return results[:limit]
        except Exception as exc:
            logger.warning("User recordings index query failed: %s", exc)

    query_attempts = [
        db.collection_group("sessions")
        .where("startedBy.uid", "==", firebase_uid)
        .order_by("startedAt", direction=firestore.Query.DESCENDING)
        .limit(limit),
        db.collection_group("sessions")
        .where("startedBy.uid", "==", firebase_uid)
        .limit(limit),
        db.collection_group("sessions")
        .where("participantUids", "array_contains", firebase_uid)
        .limit(limit),
    ]

    for q in query_attempts:
        try:
            collect_from_query(q)
            if results:
                results.sort(key=lambda r: r.get("startedAt") or "", reverse=True)
                return results[:limit]
            return []
        except Exception as exc:
            logger.warning("Firestore recordings query failed: %s", exc)

    return results


def get_recording_detail_sync(room_id: str, session_id: str, firebase_uid: str) -> dict | None:
    db = _ensure_firebase()
    if not db:
        return None

    ref = (
        db.collection("meetings")
        .document(room_id)
        .collection("sessions")
        .document(session_id)
    )
    snap = ref.get()
    if not snap.exists:
        return None

    data = snap.to_dict() or {}
    if not _user_can_access_session(data, firebase_uid):
        return None

    detail = _serialize_session_doc(room_id, session_id, data)

    chat = []
    for doc in ref.collection("chat").order_by("elapsedSec").stream():
        row = doc.to_dict() or {}
        chat.append(
            {
                "id": doc.id,
                "fromId": row.get("fromId") or "",
                "fromName": row.get("fromName") or "",
                "message": row.get("message") or "",
                "elapsedSec": row.get("elapsedSec") or 0,
                "createdAt": _ts_to_iso(row.get("createdAt")),
            }
        )

    transcripts = []
    for doc in ref.collection("transcripts").order_by("elapsedSec").stream():
        row = doc.to_dict() or {}
        transcripts.append(
            {
                "id": doc.id,
                "fromId": row.get("fromId") or "",
                "fromName": row.get("fromName") or "",
                "transcript": row.get("transcript") or "",
                "elapsedSec": row.get("elapsedSec") or 0,
                "createdAt": _ts_to_iso(row.get("createdAt")),
            }
        )

    detail["chat"] = chat
    detail["transcripts"] = transcripts
    return detail


def save_chat_message_sync(
    room_id: str,
    session_id: str,
    from_id: str,
    from_name: str,
    message: str,
    elapsed_sec: int = 0,
) -> None:
    db = _ensure_firebase()
    if not db or not room_id or not session_id or not message:
        return

    from firebase_admin import firestore

    db.collection("meetings").document(room_id).collection("sessions").document(
        session_id
    ).collection("chat").add(
        {
            "fromId": from_id,
            "fromName": from_name,
            "message": message[:500],
            "elapsedSec": elapsed_sec,
            "createdAt": firestore.SERVER_TIMESTAMP,
        }
    )


def save_transcript_message_sync(
    room_id: str,
    session_id: str,
    from_id: str,
    from_name: str,
    transcript: str,
    item_id: str,
    elapsed_sec: int = 0,
) -> None:
    db = _ensure_firebase()
    if not db or not room_id or not session_id or not transcript:
        return

    from firebase_admin import firestore

    doc_id = (item_id or f"{from_id}-{elapsed_sec}")[:128]
    db.collection("meetings").document(room_id).collection("sessions").document(
        session_id
    ).collection("transcripts").document(doc_id).set(
        {
            "fromId": from_id,
            "fromName": from_name,
            "transcript": transcript[:4000],
            "itemId": item_id,
            "elapsedSec": elapsed_sec,
            "createdAt": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )


def touch_session_sync(
    room_id: str,
    session_id: str,
    room_name: str,
    participant: dict,
) -> None:
    db = _ensure_firebase()
    if not db:
        return

    from firebase_admin import firestore

    ref = db.collection("meetings").document(room_id).collection("sessions").document(
        session_id
    )
    ref.set(
        {
            "roomId": room_id,
            "roomName": room_name or "",
            "status": "recording",
            "updatedAt": firestore.SERVER_TIMESTAMP,
            "participants": firestore.ArrayUnion(
                [
                    {
                        "participantId": participant.get("participantId", ""),
                        "name": participant.get("name", ""),
                        "firebaseUid": participant.get("firebaseUid", ""),
                        "joinedAt": datetime.now(timezone.utc).isoformat(),
                    }
                ]
            ),
        },
        merge=True,
    )
