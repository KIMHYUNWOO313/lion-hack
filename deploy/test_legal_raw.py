import asyncio
import json
import os
import sys
import urllib.request

import django

sys.path.insert(0, "/opt/lion_meet")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
django.setup()

from django.conf import settings

MODEL = settings.LEGAL_MODEL
API_KEY = settings.OPENAI_API_KEY

MESSAGE = (
    "다음 국제 미팅의 법률·세금·컴플라이언스 리스크를 점검해 주세요.\n"
    "- 우리: 대한민국\n- 상대: 미국\n"
    "계약, 세금, 데이터 규제, IP 관점에서 ▲/●/○ 위험도와 확인할 사항을 정리해 주세요."
)

payload = {
    "model": MODEL,
    "messages": [
        {"role": "system", "content": "한국어로 간단히 답변"},
        {"role": "user", "content": MESSAGE},
    ],
    "max_completion_tokens": 2500,
}


def post():
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


result = post()
print("MODEL:", MODEL)
print("KEYS:", result.keys())
choice = result["choices"][0]
print("CHOICE KEYS:", choice.keys())
msg = choice["message"]
print("MESSAGE KEYS:", msg.keys())
print("CONTENT:", repr(msg.get("content")))
print("REFUSAL:", msg.get("refusal"))
print("FINISH:", choice.get("finish_reason"))
if msg.get("content"):
    print("CONTENT LEN:", len(msg["content"]))
    print("PREVIEW:", msg["content"][:300])
else:
    print("FULL MESSAGE:", json.dumps(msg, ensure_ascii=False, indent=2)[:2000])
