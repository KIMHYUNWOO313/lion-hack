from django.urls import path, re_path

from . import auth_views, recording_views, views

urlpatterns = [
    path("", views.home, name="home"),
    path("recordings/", recording_views.recordings_page, name="recordings"),
    path(
        "recordings/<uuid:room_id>/<str:session_id>/",
        recording_views.recording_detail_page,
        name="recording_detail",
    ),
    path("api/recordings/", recording_views.api_recordings_list, name="api_recordings_list"),
    path(
        "api/recordings/<uuid:room_id>/<str:session_id>/",
        recording_views.api_recording_detail,
        name="api_recording_detail",
    ),
    path("api/recordings/session/start/", recording_views.api_recording_start, name="api_recording_start"),
    path(
        "api/recordings/session/<str:session_id>/chunk/",
        recording_views.api_recording_chunk,
        name="api_recording_chunk",
    ),
    path(
        "api/recordings/session/<str:session_id>/complete/",
        recording_views.api_recording_complete,
        name="api_recording_complete",
    ),
    path("api/auth/me/", auth_views.auth_me, name="auth_me"),
    path("api/auth/session/", auth_views.auth_session, name="auth_session"),
    path("api/auth/logout/", auth_views.auth_logout, name="auth_logout"),
    path("api/auth/firebase-token/", auth_views.auth_firebase_token, name="auth_firebase_token"),
    path("api/rooms/create/", views.create_room, name="create_room"),
    path("api/rooms/join/", views.resolve_join_code, name="resolve_join_code"),
    path("api/rooms/<uuid:room_id>/", views.room_info, name="room_info"),
    re_path(r"^join/(?P<code>[\d-]+)/$", views.join_by_code, name="join_by_code"),
    path("room/<uuid:room_id>/", views.room, name="room"),
]
