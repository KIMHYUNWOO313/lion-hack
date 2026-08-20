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
    if not firebase_enabled():
        return JsonResponse(
            {
                "error": "서버 service account 미설정 — 클라이언트에서 불러옵니다.",
                "fallback": "client",
                "recordings": [],
            },
            status=503,
        )
    try:
        items = list_recordings_for_user_sync(profile.firebase_uid)
    except Exception as exc:
        logger.exception("List recordings failed")
        msg = str(exc)
        if "does not exist for project" in msg or "NOT_FOUND" in msg:
            return JsonResponse(
                {
                    "error": "Firestore 데이터베이스가 아직 생성되지 않았습니다. Firebase Console에서 Firestore를 활성화해 주세요.",
                    "code": "firestore_not_created",
                    "setupUrl": "https://console.firebase.google.com/project/lion-hack-ff862/firestore",
                },
                status=503,
            )
        return JsonResponse({"error": msg}, status=500)
    return JsonResponse({"recordings": items})


@login_required_json
@require_http_methods(["GET"])
def api_recording_detail(request, room_id, session_id):
    profile = get_session_user(request)
    if not profile:
        return JsonResponse({"error": "로그인이 필요합니다.", "code": "auth_required"}, status=401)
    if not firebase_enabled():
        return JsonResponse(
            {"error": "서버 service account 미설정 — 클라이언트에서 불러옵니다.", "fallback": "client"},
            status=503,
        )
    try:
        detail = get_recording_detail_sync(str(room_id), str(session_id), profile.firebase_uid)
    except Exception as exc:
        logger.exception("Recording detail failed")
        msg = str(exc)
        if "does not exist for project" in msg or "NOT_FOUND" in msg:
            return JsonResponse(
                {
                    "error": "Firestore 데이터베이스가 아직 생성되지 않았습니다. Firebase Console에서 Firestore를 활성화해 주세요.",
                    "code": "firestore_not_created",
                    "setupUrl": "https://console.firebase.google.com/project/lion-hack-ff862/firestore",
                },
                status=503,
            )
        return JsonResponse({"error": msg}, status=500)
    if not detail:
        return JsonResponse({"error": "녹화본을 찾을 수 없거나 접근 권한이 없습니다."}, status=404)
    return JsonResponse({"recording": detail})
