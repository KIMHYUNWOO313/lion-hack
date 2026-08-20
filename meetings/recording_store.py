"""Django DB recording store (works without Firestore)."""

from django.utils import timezone

from .models import RecordingSession


def _user_can_access_recording(rec: RecordingSession, firebase_uid: str) -> bool:
    if not firebase_uid:
        return False
    if rec.owner_uid == firebase_uid:
        return True
    for p in rec.participants or []:
        if p.get("firebaseUid") == firebase_uid:
            return True
    return False


def _ensure_participant(rec: RecordingSession, participant_id: str, participant_name: str, firebase_uid: str):
    participants = list(rec.participants or [])
    if rec.owner_uid != firebase_uid and not any(
        p.get("firebaseUid") == firebase_uid for p in participants
    ):
        participants.append(
            {
                "participantId": participant_id,
                "name": participant_name,
                "firebaseUid": firebase_uid,
            }
        )
        rec.participants = participants
        rec.save(update_fields=["participants"])


def _serialize_summary(rec: RecordingSession) -> dict:
    chunk_count = 0
    participant_count = 0
    for info in (rec.videos or {}).values():
        if not isinstance(info, dict):
            continue
        participant_count += 1
        chunks = info.get("chunks") or []
        chunk_count += len(chunks)
    return {
        "roomId": str(rec.room_id),
        "sessionId": rec.session_id,
        "roomName": rec.room_name or "",
        "status": rec.status or "unknown",
        "startedAt": rec.started_at.isoformat() if rec.started_at else None,
        "endedAt": rec.ended_at.isoformat() if rec.ended_at else None,
        "durationSec": rec.duration_sec or 0,
        "chunkCount": chunk_count,
        "participantCount": participant_count or 1,
    }


def _serialize_videos(videos: dict) -> list:
    items = []
    for participant_id, info in (videos or {}).items():
        if not isinstance(info, dict):
            continue
        chunks = info.get("chunks") or []
        if isinstance(chunks, dict):
            chunks = list(chunks.values())
        chunks = sorted(
            [c for c in chunks if isinstance(c, dict) and c.get("url")],
            key=lambda c: c.get("index", 0),
        )
        items.append(
            {
                "participantId": participant_id,
                "participantName": info.get("participantName") or participant_id[:8],
                "status": info.get("status") or "",
                "chunkCount": len(chunks),
                "chunks": [
                    {
                        "index": c.get("index", i),
                        "url": c.get("url", ""),
                        "size": c.get("size", 0),
                    }
                    for i, c in enumerate(chunks)
                ],
            }
        )
    return items


def _serialize_detail(rec: RecordingSession) -> dict:
    video_tracks = _serialize_videos(rec.videos)
    detail = _serialize_summary(rec)
    detail.update(
        {
            "startedBy": {"uid": rec.owner_uid, "displayName": rec.owner_name},
            "participants": rec.participants or [],
            "videoTracks": video_tracks,
            "chunkCount": sum(len(v["chunks"]) for v in video_tracks),
            "chat": [],
            "transcripts": [],
        }
    )
    return detail


def list_recordings_django(firebase_uid: str, limit: int = 30) -> list:
    if not firebase_uid:
        return []
    results = []
    seen = set()
    for rec in RecordingSession.objects.order_by("-started_at")[: limit * 2]:
        if not _user_can_access_recording(rec, firebase_uid):
            continue
        key = f"{rec.room_id}:{rec.session_id}"
        if key in seen:
            continue
        seen.add(key)
        results.append(_serialize_summary(rec))
        if len(results) >= limit:
            break
    return results


def get_recording_detail_django(room_id: str, session_id: str, firebase_uid: str) -> dict | None:
    try:
        rec = RecordingSession.objects.get(room_id=room_id, session_id=session_id)
    except RecordingSession.DoesNotExist:
        return None
    if not _user_can_access_recording(rec, firebase_uid):
        return None
    return _serialize_detail(rec)


def start_recording_session(
    room_id: str,
    room_name: str,
    owner_uid: str,
    owner_name: str,
    participant_id: str,
    participant_name: str,
    session_id: str | None = None,
) -> RecordingSession:
    import uuid

    sid = session_id or str(uuid.uuid4())
    rec, created = RecordingSession.objects.get_or_create(
        session_id=sid,
        defaults={
            "room_id": room_id,
            "room_name": room_name or "",
            "owner_uid": owner_uid,
            "owner_name": owner_name or "",
            "status": "recording",
            "participants": [
                {
                    "participantId": participant_id,
                    "name": participant_name or "",
                    "firebaseUid": owner_uid,
                }
            ],
        },
    )
    if not created:
        _ensure_participant(rec, participant_id, participant_name, owner_uid)
    return rec


def add_recording_chunk(
    session_id: str,
    owner_uid: str,
    participant_id: str,
    participant_name: str,
    index: int,
    url: str,
    size: int = 0,
) -> RecordingSession | None:
    try:
        rec = RecordingSession.objects.get(session_id=session_id)
    except RecordingSession.DoesNotExist:
        return None

    _ensure_participant(rec, participant_id, participant_name, owner_uid)
    if not _user_can_access_recording(rec, owner_uid):
        return None

    videos = dict(rec.videos or {})
    track = dict(videos.get(participant_id) or {})
    chunks = list(track.get("chunks") or [])
    chunks = [c for c in chunks if c.get("index") != index]
    chunks.append({"index": index, "url": url, "size": size})
    chunks.sort(key=lambda c: c.get("index", 0))
    track["chunks"] = chunks
    track["participantName"] = participant_name or track.get("participantName") or participant_id[:8]
    track["status"] = "recording"
    track["chunkCount"] = len(chunks)
    videos[participant_id] = track
    rec.videos = videos
    rec.save(update_fields=["videos"])
    return rec


def complete_recording_session(
    session_id: str,
    owner_uid: str,
    participant_id: str,
    duration_sec: int = 0,
) -> RecordingSession | None:
    try:
        rec = RecordingSession.objects.get(session_id=session_id)
    except RecordingSession.DoesNotExist:
        return None

    if not _user_can_access_recording(rec, owner_uid):
        return None

    videos = dict(rec.videos or {})
    if participant_id in videos:
        videos[participant_id]["status"] = "completed"
        videos[participant_id]["chunkCount"] = len(videos[participant_id].get("chunks") or [])

    rec.videos = videos
    rec.status = "completed"
    rec.duration_sec = max(duration_sec, rec.duration_sec or 0)
    rec.ended_at = timezone.now()
    rec.save(update_fields=["videos", "status", "duration_sec", "ended_at"])
    return rec
