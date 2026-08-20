import json
import re

from django.conf import settings
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_http_methods

from .auth_utils import get_session_user, login_required_json
from .models import MeetingRoom, format_join_code


def _normalize_code(raw: str) -> str:
    return re.sub(r"\D", "", (raw or "").strip())[:6]


@ensure_csrf_cookie
def home(request):
    user = get_session_user(request)
    return render(
        request,
        "meetings/home.html",
        {
            "user_authenticated": bool(user),
            "user_email": user.email if user else "",
            "user_name": user.display_name if user else "",
            "firebase_config": {
                "apiKey": settings.FIREBASE_API_KEY,
                "authDomain": settings.FIREBASE_AUTH_DOMAIN,
                "projectId": settings.FIREBASE_PROJECT_ID,
                "storageBucket": settings.FIREBASE_STORAGE_BUCKET,
                "messagingSenderId": settings.FIREBASE_MESSAGING_SENDER_ID,
                "appId": settings.FIREBASE_APP_ID,
                "measurementId": settings.FIREBASE_MEASUREMENT_ID,
            },
        },
    )


def room(request, room_id):
    if not get_session_user(request):
        return redirect(f"/?login=1&next=/room/{room_id}/")
    room_obj = get_object_or_404(MeetingRoom, id=room_id, is_active=True)
    return render(
        request,
        "meetings/room.html",
        {
            "room": room_obj,
            "room_id": str(room_obj.id),
            "join_code": room_obj.join_code,
            "join_code_display": room_obj.join_code_display,
            "ice_servers_json": json.dumps(settings.ICE_SERVERS),
            "stt_model": getattr(settings, "STT_MODEL", "gpt-live-transcribe"),
            "stt_boost_gain": getattr(settings, "STT_MAX_GAIN", 1.0),
            "firebase_config": {
                "apiKey": settings.FIREBASE_API_KEY,
                "authDomain": settings.FIREBASE_AUTH_DOMAIN,
                "projectId": settings.FIREBASE_PROJECT_ID,
                "storageBucket": settings.FIREBASE_STORAGE_BUCKET,
                "messagingSenderId": settings.FIREBASE_MESSAGING_SENDER_ID,
                "appId": settings.FIREBASE_APP_ID,
                "measurementId": settings.FIREBASE_MEASUREMENT_ID,
            },
            "firebase_admin_enabled": bool(getattr(settings, "FIREBASE_SERVICE_ACCOUNT_JSON", "")),
        },
    )


def join_by_code(request, code):
    normalized = _normalize_code(code)
    if len(normalized) != 6:
        return redirect("home")
    room_obj = get_object_or_404(MeetingRoom, join_code=normalized, is_active=True)
    return redirect("room", room_id=room_obj.id)


@login_required_json
@require_http_methods(["POST"])
def create_room(request):
    data = json.loads(request.body or "{}")
    name = (data.get("name") or "새 회의").strip()[:100]
    room_obj = MeetingRoom.objects.create(name=name or "새 회의")
    return JsonResponse(
        {
            "room_id": str(room_obj.id),
            "name": room_obj.name,
            "join_code": room_obj.join_code,
            "join_code_display": room_obj.join_code_display,
        }
    )


@login_required_json
@require_http_methods(["POST"])
def resolve_join_code(request):
    data = json.loads(request.body or "{}")
    normalized = _normalize_code(data.get("code", ""))
    if len(normalized) != 6:
        return JsonResponse({"error": "6자리 회의 코드를 입력하세요."}, status=400)
    try:
        room_obj = MeetingRoom.objects.get(join_code=normalized, is_active=True)
    except MeetingRoom.DoesNotExist:
        return JsonResponse({"error": "회의를 찾을 수 없습니다."}, status=404)
    return JsonResponse(
        {
            "room_id": str(room_obj.id),
            "name": room_obj.name,
            "join_code": room_obj.join_code,
            "join_code_display": room_obj.join_code_display,
        }
    )


@require_http_methods(["GET"])
def room_info(request, room_id):
    room_obj = get_object_or_404(MeetingRoom, id=room_id, is_active=True)
    return JsonResponse(
        {
            "room_id": str(room_obj.id),
            "name": room_obj.name,
            "join_code": room_obj.join_code,
            "join_code_display": room_obj.join_code_display,
        }
    )
