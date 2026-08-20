import logging

import jwt
from django.conf import settings
from jwt import PyJWKClient

logger = logging.getLogger(__name__)

_jwks_client = None


def _get_jwks_client():
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = PyJWKClient(
            "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
        )
    return _jwks_client


def verify_firebase_id_token(id_token: str) -> dict:
    """Verify Firebase ID token (JWT) without service account file."""
    project_id = settings.FIREBASE_PROJECT_ID
    if not id_token or not project_id:
        raise ValueError("Invalid token or Firebase project ID")

    signing_key = _get_jwks_client().get_signing_key_from_jwt(id_token)
    return jwt.decode(
        id_token,
        signing_key.key,
        algorithms=["RS256"],
        audience=project_id,
        issuer=f"https://securetoken.google.com/{project_id}",
        leeway=30,
    )


def claims_to_profile_fields(claims: dict) -> dict:
    return {
        "firebase_uid": claims.get("uid") or claims.get("sub") or "",
        "email": (claims.get("email") or "").lower(),
        "display_name": claims.get("name") or claims.get("email") or "",
    }
