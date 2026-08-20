from django.urls import re_path

from . import consumers

websocket_urlpatterns = [
    re_path(r"ws/meeting/(?P<room_id>[0-9a-f-]+)/$", consumers.MeetingConsumer.as_asgi()),
]
