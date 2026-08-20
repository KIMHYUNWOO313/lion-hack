import random
import uuid

from django.db import models


def generate_join_code():
    """Generate unique 6-digit meeting join code."""
    for _ in range(100):
        code = f"{random.randint(0, 999999):06d}"
        if not MeetingRoom.objects.filter(join_code=code).exists():
            return code
    raise RuntimeError("Could not generate unique join code")


def format_join_code(code: str) -> str:
    code = (code or "").replace("-", "").strip()
    if len(code) == 6:
        return f"{code[:3]}-{code[3:]}"
    return code


class UserProfile(models.Model):
    """Firebase-authenticated user profile synced from ID token."""

    firebase_uid = models.CharField(max_length=128, unique=True, db_index=True)
    email = models.EmailField(max_length=255, blank=True, db_index=True)
    display_name = models.CharField(max_length=120, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.email or self.firebase_uid


class MeetingRoom(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    join_code = models.CharField(max_length=6, unique=True, db_index=True)
    name = models.CharField(max_length=100)
    created_at = models.DateTimeField(auto_now_add=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["-created_at"]

    def save(self, *args, **kwargs):
        if not self.join_code:
            self.join_code = generate_join_code()
        super().save(*args, **kwargs)

    @property
    def join_code_display(self):
        return format_join_code(self.join_code)

    def __str__(self):
        return self.name


class LegalReference(models.Model):
    """Curated legal/tax/compliance reference per jurisdiction."""

    country_code = models.CharField(max_length=2, db_index=True)
    category = models.CharField(max_length=50)
    title = models.CharField(max_length=200)
    summary = models.TextField()
    source_url = models.URLField(max_length=500, blank=True)
    keywords = models.CharField(max_length=300, blank=True)

    class Meta:
        ordering = ["country_code", "category", "title"]
        indexes = [
            models.Index(fields=["country_code", "category"]),
        ]

    def __str__(self):
        return f"{self.country_code} · {self.title}"


class RecordingSession(models.Model):
    """Server-side recording metadata (Firestore fallback)."""

    session_id = models.CharField(max_length=128, unique=True, db_index=True)
    room_id = models.UUIDField(db_index=True)
    room_name = models.CharField(max_length=100, blank=True)
    owner_uid = models.CharField(max_length=128, db_index=True)
    owner_name = models.CharField(max_length=120, blank=True)
    status = models.CharField(max_length=20, default="recording")
    started_at = models.DateTimeField(auto_now_add=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    duration_sec = models.PositiveIntegerField(default=0)
    videos = models.JSONField(default=dict)
    participants = models.JSONField(default=list)

    class Meta:
        ordering = ["-started_at"]
        indexes = [
            models.Index(fields=["owner_uid", "-started_at"]),
            models.Index(fields=["room_id", "session_id"]),
        ]

    def __str__(self):
        return f"{self.room_name or self.room_id} · {self.session_id[:8]}"
