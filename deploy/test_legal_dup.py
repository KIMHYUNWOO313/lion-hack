import json
import os
import sys
import urllib.request

import django

sys.path.insert(0, "/opt/lion_meet")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
django.setup()

from django.conf import settings
from meetings.legal_service import SYSTEM_PROMPT, _build_context_message

MESSAGE = (
    "다음 국제 미팅의 법률·세금·컴플라이언스 리스크를 점검해 주세요.\n"
    "- 우리: 대한민국\n- 상대: 미국\n"
    "계약, 세금, 데이터 규제, IP 관점에서 ▲/●/○ 위험도와 확인할 사항을 정리해 주세요."
)
HISTORY = [{"role": "user", "content": MESSAGE}]

context = _build_context_message("KR", ["US"], "대리 결제")
messages = [{"role": "system", "content": SYSTEM_PROMPT}]
messages.append({"role": "user", "content": f"[미팅 배경]\n{context}\n\n위 맥락을 항상 고려하세요."})
messages.append({"role": "assistant", "content": "네, 국제 미팅 맥락을 반영해 관할별 법률·세무 리스크를 점검하겠습니다."})
for item in HISTORY[-8:]:
    messages.append({"role": item["role"], "content": item["content"][:2000]})
messages.append({"role": "user", "content": MESSAGE[:3000]})

payload = {
    "model": settings.LEGAL_MODEL,
    "messages": messages,
    "max_completion_tokens": 2500,
}

req = urllib.request.Request(
    "https://api.openai.com/v1/chat/completions",
    data=json.dumps(payload).encode("utf-8"),
    headers={
        "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
        "Content-Type": "application/json",
    },
    method="POST",
)
with urllib.request.urlopen(req, timeout=120) as resp:
    result = json.loads(resp.read().decode("utf-8"))

choice = result["choices"][0]
msg = choice["message"]
print("finish:", choice.get("finish_reason"))
print("content len:", len(msg.get("content") or ""))
print("usage:", result.get("usage"))
print("preview:", (msg.get("content") or "")[:200])
