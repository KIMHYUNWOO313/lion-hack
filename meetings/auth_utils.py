from functools import wraps

from django.http import JsonResponse


def get_session_user(request):
    uid = request.session.get("firebase_uid")
    if not uid:
        return None
    from .models import UserProfile

    try:
        return UserProfile.objects.get(firebase_uid=uid)
    except UserProfile.DoesNotExist:
        return None


def login_required_json(view_func):
    @wraps(view_func)
    def _wrapped(request, *args, **kwargs):
        if not get_session_user(request):
            return JsonResponse(
                {"error": "로그인이 필요합니다.", "code": "auth_required"},
                status=401,
            )
        return view_func(request, *args, **kwargs)

    return _wrapped
