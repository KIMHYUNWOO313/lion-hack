"""Create the Firestore (default) database using the configured service account.

Usage (on the server):
    /opt/lion_meet/venv/bin/python deploy/setup_firestore.py
"""

import json
import os
import sys
import urllib.error
import urllib.request

from dotenv import load_dotenv

LOCATION = os.getenv("FIRESTORE_LOCATION", "asia-northeast3")


def _access_token(sa_info: dict) -> str:
    from google.oauth2 import service_account
    from google.auth.transport.requests import Request

    creds = service_account.Credentials.from_service_account_info(
        sa_info, scopes=["https://www.googleapis.com/auth/datastore"]
    )
    creds.refresh(Request())
    return creds.token


def _api(method: str, url: str, token: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method=method,
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def main() -> int:
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
    sa_raw = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "")
    if not sa_raw:
        print("FIREBASE_SERVICE_ACCOUNT_JSON is not set")
        return 1

    sa_info = json.loads(sa_raw)
    project = sa_info["project_id"]
    token = _access_token(sa_info)

    list_url = f"https://firestore.googleapis.com/v1/projects/{project}/databases"
    try:
        existing = _api("GET", list_url, token)
        for db in existing.get("databases", []):
            if db.get("name", "").endswith("/(default)"):
                print(f"Firestore already exists: {db['name']} ({db.get('locationId')})")
                return 0
    except urllib.error.HTTPError as exc:
        print(f"List databases failed ({exc.code}): {exc.read().decode('utf-8')[:400]}")

    create_url = f"{list_url}?databaseId=(default)"
    body = {"type": "FIRESTORE_NATIVE", "locationId": LOCATION}
    try:
        op = _api("POST", create_url, token, body)
        print("Create requested:", json.dumps(op)[:400])
    except urllib.error.HTTPError as exc:
        print(f"Create failed ({exc.code}): {exc.read().decode('utf-8')[:600]}")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
