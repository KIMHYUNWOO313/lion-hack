from django.contrib import admin

from .models import MeetingRoom


@admin.register(MeetingRoom)
class MeetingRoomAdmin(admin.ModelAdmin):
    list_display = ("name", "join_code", "created_at", "is_active")
    search_fields = ("name", "join_code")
    readonly_fields = ("id", "join_code", "created_at")

