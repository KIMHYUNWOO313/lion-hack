import json
import logging

import jwt
from django.contrib.auth import logout as django_logout
from django.http import JsonResponse
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_http_methods

from .firebase_service import claims_to_profile_fields, verify_firebase_id_token
from .firebase_store import create_custom_token, firebase_enabled
from .models import UserProfile

logger = logging.getLogger(__name__)


def _session_user(request):
    uid = request.session.get("firebase_uid")
    if not uid:
        return None
    try:
        return UserProfile.objects.get(firebase_uid=uid)
    except UserProfile.DoesNotExist:
        return None


def _user_json(profile: UserProfile | None):
    if not profile:
        return None
    return {
        "uid": profile.firebase_uid,
        "email": profile.email,
        "displayName": profile.display_name,
    }


@ensure_csrf_cookie
@require_http_methods(["GET"])
def auth_me(request):
    profile = _session_user(request)
    return JsonResponse({"authenticated": bool(profile), "user": _user_json(profile)})


@require_http_methods(["POST"])
def auth_session(request):
    try:
        data = json.loads(request.body or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "잘못된 요청입니다."}, status=400)

    id_token = (data.get("idToken") or "").strip()
    if not id_token:
        return JsonResponse({"error": "인증 토큰이 없습니다."}, status=400)

    try:
        claims = verify_firebase_id_token(id_token)
    except jwt.ExpiredSignatureError:
        return JsonResponse({"error": "로그인이 만료되었습니다. 다시 로그인해 주세요."}, status=401)
    except Exception as exc:
        logger.warning("Firebase token verify failed: %s", exc)
        return JsonResponse({"error": "인증에 실패했습니다."}, status=401)

    fields = claims_to_profile_fields(claims)
    if not fields["firebase_uid"]:
        return JsonResponse({"error": "유효하지 않은 사용자 정보입니다."}, status=400)

    profile, _ = UserProfile.objects.update_or_create(
        firebase_uid=fields["firebase_uid"],
        defaults={
            "email": fields["email"],
            "display_name": fields["display_name"][:120],
        },
    )

    request.session["firebase_uid"] = profile.firebase_uid
    request.session["user_email"] = profile.email
    request.session.modified = True

    return JsonResponse({"ok": True, "user": _user_json(profile)})


@require_http_methods(["POST"])
def auth_logout(request):
    django_logout(request)
    request.session.flush()
    return JsonResponse({"ok": True})


@ensure_csrf_cookie
@require_http_methods(["GET"])
def auth_firebase_token(request):
    """Return Firebase custom token so the room page can upload to Storage/Firestore."""
    profile = _session_user(request)
    if not profile:
        return JsonResponse({"error": "로그인이 필요합니다."}, status=401)
    if not firebase_enabled():
        return JsonResponse(
            {"error": "Firebase service account가 설정되지 않았습니다.", "code": "firebase_admin_missing"},
            status=503,
        )
    try:
        token = create_custom_token(
            profile.firebase_uid,
            display_name=profile.display_name,
            email=profile.email,
        )
    except Exception as exc:
        logger.warning("Firebase custom token failed: %s", exc)
        return JsonResponse({"error": "Firebase 토큰 발급에 실패했습니다."}, status=500)
    return JsonResponse({"token": token, "uid": profile.firebase_uid})
