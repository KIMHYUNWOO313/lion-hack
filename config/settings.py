import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "change-me-in-production-lion-hack-2026")
DEBUG = os.getenv("DEBUG", "True").lower() in ("1", "true", "yes")
ALLOWED_HOSTS = [
    host.strip()
    for host in os.getenv(
        "ALLOWED_HOSTS", "localhost,127.0.0.1"
    ).split(",")
    if host.strip()
]

INSTALLED_APPS = [
    "daphne",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "channels",
    "meetings",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }
}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "ko-kr"
TIME_ZONE = "Asia/Seoul"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "static"]
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels.layers.InMemoryChannelLayer",
    }
}

OPENAI_API_KEY = os.getenv("GPT_API_KEY") or os.getenv("OPENAI_API_KEY", "")

# Legal advisor chatbot (cross-border meeting checks)
LEGAL_MODEL = os.getenv("LEGAL_MODEL", "gpt-5.6-terra")
RISK_MODEL = os.getenv("RISK_MODEL", LEGAL_MODEL)

# Realtime STT (gpt-live-transcribe — continuous live streaming only)
STT_MODEL = os.getenv("STT_MODEL", "gpt-live-transcribe")
STT_LANGUAGES = os.getenv("STT_LANGUAGES", "ko")
# xhigh delay = more audio context before transcript (better Korean accuracy)
STT_DELAY = os.getenv("STT_DELAY", "xhigh")
STT_COMMIT_SILENCE_SEC = os.getenv("STT_COMMIT_SILENCE_SEC", "2.5")
STT_COMMIT_MAX_INTERVAL_SEC = os.getenv("STT_COMMIT_MAX_INTERVAL_SEC", "20")
# Quiet-room default: avoid speech-damaging denoising. Set near_field/far_field only when needed.
STT_NOISE_REDUCTION = os.getenv("STT_NOISE_REDUCTION", "")
STT_MIN_LEVEL = os.getenv("STT_MIN_LEVEL", "0.001")
STT_MAX_GAIN = float(os.getenv("STT_MAX_GAIN", "1.0"))

# Firebase Auth (client config is public; token verified server-side)
FIREBASE_PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", "lion-hack-ff862")
FIREBASE_API_KEY = os.getenv("FIREBASE_API_KEY", "")
FIREBASE_AUTH_DOMAIN = os.getenv("FIREBASE_AUTH_DOMAIN", "lion-hack-ff862.firebaseapp.com")
FIREBASE_STORAGE_BUCKET = os.getenv("FIREBASE_STORAGE_BUCKET", "lion-hack-ff862.firebasestorage.app")
FIREBASE_MESSAGING_SENDER_ID = os.getenv("FIREBASE_MESSAGING_SENDER_ID", "721755281636")
FIREBASE_APP_ID = os.getenv("FIREBASE_APP_ID", "1:721755281636:web:fdda4b452a65ab78ed34f1")
FIREBASE_MEASUREMENT_ID = os.getenv("FIREBASE_MEASUREMENT_ID", "G-C2YT56TLK5")
# JSON string of Firebase service account (enables server-side Firestore + custom tokens)
FIREBASE_SERVICE_ACCOUNT_JSON = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "")

# WebRTC ICE servers (Google public STUN)
ICE_SERVERS = [
    {"urls": "stun:stun.l.google.com:19302"},
    {"urls": "stun:stun1.l.google.com:19302"},
    {"urls": "stun:stun2.l.google.com:19302"},
    {"urls": "stun:stun3.l.google.com:19302"},
    {"urls": "stun:stun4.l.google.com:19302"},
]

if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    CSRF_TRUSTED_ORIGINS = [
        f"https://{host}"
        for host in ALLOWED_HOSTS
        if host not in ("localhost", "127.0.0.1")
    ] + [
        f"http://{host}"
        for host in ALLOWED_HOSTS
        if host not in ("localhost", "127.0.0.1")
    ]
