import asyncio
import json
import logging
import urllib.error
import urllib.request

from django.conf import settings

logger = logging.getLogger(__name__)

RISK_SYSTEM = """당신은 회의 음성 전사에서 법률·컴플라이언스·공정거래·세무 리스크를 실시간 탐지하는 AI입니다.

다음 발언에서 위험 신호를 JSON으로만 응답하세요:
{
  "hasRisk": true/false,
  "severity": "high|medium|low|none",
  "score": 0-100,
  "category": "예: 공정거래, 세무, 개인정보, 수출통제, 반부패",
  "title": "한 줄 요약",
  "summary": "2~3문장 설명",
  "basis": ["탐지 근거 1", "탐지 근거 2"],
  "laws": ["관련 법령/조항"],
  "questions": ["상대방에게 확인할 질문"]
}

hasRisk=false이면 severity=none, score=0, 나머지는 빈 배열.
일반 정보이며 formal legal advice 아님. 한국어로 작성."""


async def detect_legal_risk(
    transcript: str,
    speaker: str,
    my_country: str = "KR",
    partner_countries: list | None = None,
    meeting_context: str = "",
) -> dict | None:
    text = (transcript or "").strip()
    if len(text) < 8:
        return None

    api_key = settings.OPENAI_API_KEY
    if not api_key:
        return None

    model = getattr(settings, "RISK_MODEL", "gpt-5.6-terra")
    partners = ", ".join(partner_countries or []) or "미지정"

    user_msg = (
        f"발화자: {speaker}\n"
        f"우리 관할: {my_country}\n"
        f"상대 관할: {partners}\n"
        f"미팅 맥락: {meeting_context or '없음'}\n"
        f"전사 내용: {text[:1500]}"
    )

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": RISK_SYSTEM},
            {"role": "user", "content": user_msg},
        ],
        "max_completion_tokens": 800,
        "response_format": {"type": "json_object"},
        "reasoning_effort": "low",
    }

    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    def _post():
        with urllib.request.urlopen(req, timeout=45) as resp:
            return json.loads(resp.read().decode("utf-8"))

    try:
        result = await asyncio.to_thread(_post)
        content = result["choices"][0]["message"]["content"]
        data = json.loads(content)
        if not data.get("hasRisk"):
            return None
        data["transcript"] = text
        data["speaker"] = speaker
        return data
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        logger.error("Risk API error %s: %s", exc.code, body[:300])
        return None
    except Exception:
        logger.exception("Risk detection failed")
        return None
