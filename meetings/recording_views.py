import json
import logging

from django.conf import settings
from django.http import JsonResponse
from django.shortcuts import redirect, render
from django.views.decorators.http import require_http_methods

from .auth_utils import get_session_user, login_required_json
from .firebase_store import (
    firebase_enabled,
    get_recording_detail_sync,
    list_recordings_for_user_sync,
)
from .recording_store import (
    add_recording_chunk,
    complete_recording_session,
    get_recording_detail_django,
    list_recordings_django,
    start_recording_session,
)

logger = logging.getLogger(__name__)


def _firebase_config():
    return {
        "apiKey": settings.FIREBASE_API_KEY,
        "authDomain": settings.FIREBASE_AUTH_DOMAIN,
        "projectId": settings.FIREBASE_PROJECT_ID,
        "storageBucket": settings.FIREBASE_STORAGE_BUCKET,
        "messagingSenderId": settings.FIREBASE_MESSAGING_SENDER_ID,
        "appId": settings.FIREBASE_APP_ID,
        "measurementId": settings.FIREBASE_MEASUREMENT_ID,
    }


def _merge_recordings(*lists) -> list:
    merged = []
    seen = set()
    for items in lists:
        for item in items or []:
            key = f"{item.get('roomId')}:{item.get('sessionId')}"
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)
    merged.sort(key=lambda r: r.get("startedAt") or "", reverse=True)
    return merged


def recordings_page(request):
    profile = get_session_user(request)
    if not profile:
        return redirect("/?login=1&next=/recordings/")
    return render(
        request,
        "meetings/recordings.html",
        {
            "firebase_config": _firebase_config(),
            "firebase_admin_enabled": firebase_enabled(),
        },
    )


def recording_detail_page(request, room_id, session_id):
    profile = get_session_user(request)
    if not profile:
        return redirect(f"/?login=1&next=/recordings/{room_id}/{session_id}/")
    return render(
        request,
        "meetings/recording_detail.html",
        {
            "room_id": room_id,
            "session_id": session_id,
            "firebase_config": _firebase_config(),
            "firebase_admin_enabled": firebase_enabled(),
        },
    )


@login_required_json
@require_http_methods(["GET"])
def api_recordings_list(request):
    profile = get_session_user(request)
    if not profile:
        return JsonResponse({"error": "로그인이 필요합니다.", "code": "auth_required"}, status=401)

    items = list_recordings_django(profile.firebase_uid)

    if firebase_enabled():
        try:
            firestore_items = list_recordings_for_user_sync(profile.firebase_uid)
            items = _merge_recordings(items, firestore_items)
        except Exception as exc:
            logger.warning("Firestore list failed, using Django only: %s", exc)

    return JsonResponse({"recordings": items})


@login_required_json
@require_http_methods(["GET"])
def api_recording_detail(request, room_id, session_id):
    profile = get_session_user(request)
    if not profile:
        return JsonResponse({"error": "로그인이 필요합니다.", "code": "auth_required"}, status=401)

    detail = get_recording_detail_django(str(room_id), str(session_id), profile.firebase_uid)
    if detail:
        return JsonResponse({"recording": detail})

    if firebase_enabled():
        try:
            detail = get_recording_detail_sync(str(room_id), str(session_id), profile.firebase_uid)
            if detail:
                return JsonResponse({"recording": detail})
        except Exception as exc:
            logger.warning("Firestore detail failed: %s", exc)

    return JsonResponse({"error": "녹화본을 찾을 수 없거나 접근 권한이 없습니다."}, status=404)


@login_required_json
@require_http_methods(["POST"])
def api_recording_start(request):
    profile = get_session_user(request)
    if not profile:
        return JsonResponse({"error": "로그인이 필요합니다."}, status=401)

    try:
        data = json.loads(request.body or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "잘못된 요청입니다."}, status=400)

    room_id = (data.get("roomId") or "").strip()
    if not room_id:
        return JsonResponse({"error": "roomId가 필요합니다."}, status=400)

    rec = start_recording_session(
        room_id=room_id,
        room_name=(data.get("roomName") or "")[:100],
        owner_uid=profile.firebase_uid,
        owner_name=profile.display_name or profile.email,
        participant_id=(data.get("participantId") or "")[:64],
        participant_name=(data.get("participantName") or "")[:120],
        session_id=(data.get("sessionId") or "").strip()[:128] or None,
    )
    return JsonResponse(
        {
            "sessionId": rec.session_id,
            "roomId": str(rec.room_id),
            "status": rec.status,
        }
    )


@login_required_json
@require_http_methods(["POST"])
def api_recording_chunk(request, session_id):
    profile = get_session_user(request)
    if not profile:
        return JsonResponse({"error": "로그인이 필요합니다."}, status=401)

    try:
        data = json.loads(request.body or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "잘못된 요청입니다."}, status=400)

    url = (data.get("url") or "").strip()
    if not url:
        return JsonResponse({"error": "url이 필요합니다."}, status=400)

    rec = add_recording_chunk(
        session_id=str(session_id)[:128],
        owner_uid=profile.firebase_uid,
        participant_id=(data.get("participantId") or "")[:64],
        participant_name=(data.get("participantName") or "")[:120],
        index=int(data.get("index") or 0),
        url=url[:2000],
        size=int(data.get("size") or 0),
    )
    if not rec:
        return JsonResponse({"error": "녹화 세션을 찾을 수 없습니다."}, status=404)
    return JsonResponse({"ok": True, "chunkCount": len(rec.videos.get(data.get("participantId"), {}).get("chunks", []))})


@login_required_json
@require_http_methods(["POST"])
def api_recording_complete(request, session_id):
    profile = get_session_user(request)
    if not profile:
        return JsonResponse({"error": "로그인이 필요합니다."}, status=401)

    try:
        data = json.loads(request.body or "{}")
    except json.JSONDecodeError:
        data = {}

    rec = complete_recording_session(
        session_id=str(session_id)[:128],
        owner_uid=profile.firebase_uid,
        participant_id=(data.get("participantId") or "")[:64],
        duration_sec=int(data.get("durationSec") or 0),
    )
    if not rec:
        return JsonResponse({"error": "녹화 세션을 찾을 수 없습니다."}, status=404)
    return JsonResponse({"ok": True, "status": rec.status, "durationSec": rec.duration_sec})
