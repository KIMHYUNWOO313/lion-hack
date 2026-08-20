import asyncio
import os
import sys

import django

sys.path.insert(0, "/opt/lion_meet")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
django.setup()

from meetings.legal_service import ask_legal_advisor

MESSAGE = (
    "다음 국제 미팅의 법률·세금·컴플라이언스 리스크를 점검해 주세요.\n"
    "- 우리: 대한민국\n- 상대: 미국\n"
    "계약, 세금, 데이터 규제, IP 관점에서 ▲/●/○ 위험도와 확인할 사항을 정리해 주세요."
)


async def main():
    result = await ask_legal_advisor(MESSAGE, "KR", ["US"], "대리 결제", [])
    print("LEN:", len(result["text"]))
    print("REFS:", len(result["references"]))
    print("PREVIEW:", result["text"][:400])


asyncio.run(main())
