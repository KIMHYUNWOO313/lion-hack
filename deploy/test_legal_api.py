import asyncio
import os
import sys

import django

sys.path.insert(0, "/opt/lion_meet")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
django.setup()

from meetings.legal_service import ask_legal_advisor


async def main():
    result = await ask_legal_advisor(
        "한미 SaaS 계약 시 세금 이슈를 1문장으로 요약해 주세요.",
        "KR",
        ["US"],
        "B2B 계약",
    )
    print(result[:300])


asyncio.run(main())
