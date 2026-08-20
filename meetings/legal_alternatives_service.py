import asyncio
import json
import logging
import urllib.error
import urllib.request

from django.conf import settings

from .legal_countries import country_label

logger = logging.getLogger(__name__)

ALTERNATIVES_SYSTEM = """당신은 국제 B2B 미팅 컴플라이언스 전문 AI입니다.
탐지된 법률·규제 리스크에 대해 **법률 위반이 아닌** 실무적·합법적 대안(차선책)을 JSON으로만 제시하세요.

{
  "summary": "차선책 전략 2~3문장 요약",
  "alternatives": [
    {
      "title": "대안 제목",
      "description": "구체적 실행 방법",
      "whyCompliant": "왜 합법·저위험인지",
      "jurisdictions": ["KR", "US"],
      "cautions": ["주의사항"]
    }
  ],
  "questionsToConfirm": ["전문가·상대방에게 확인할 질문"]
}

3~5개 대안. 각 관할법을 고려하되, 불법·회피·은폐 목적의 조언은 금지.
일반 정보이며 formal legal advice 아님. 한국어로 작성."""


def _format_jurisdictions(my_country: str, partner_countries: list | None) -> str:
    parts = [f"{country_label(my_country)} ({my_country})"]
    for code in partner_countries or []:
        if code and code != my_country:
            parts.append(f"{country_label(code)} ({code})")
    return ", ".join(parts)


async def suggest_compliant_alternatives(
    risk: dict,
    my_country: str = "KR",
    partner_countries: list | None = None,
    meeting_context: str = "",
) -> dict:
    if not risk:
        return {"summary": "", "alternatives": [], "questionsToConfirm": []}

    api_key = settings.OPENAI_API_KEY
    if not api_key:
        return {
            "summary": "OpenAI API 키가 설정되지 않아 차선책을 생성할 수 없습니다.",
            "alternatives": [],
            "questionsToConfirm": [],
        }

    model = getattr(settings, "ALTERNATIVES_MODEL", getattr(settings, "RISK_MODEL", "gpt-5.6-terra"))
    jurisdictions = _format_jurisdictions(my_country, partner_countries)

    risk_block = json.dumps(
        {
            "title": risk.get("title", ""),
            "summary": risk.get("summary", ""),
            "category": risk.get("category", ""),
            "severity": risk.get("severity", ""),
            "score": risk.get("score", 0),
            "basis": risk.get("basis") or [],
            "laws": risk.get("laws") or [],
            "transcript": (risk.get("transcript") or "")[:800],
            "speaker": risk.get("speaker") or "",
        },
        ensure_ascii=False,
    )

    user_msg = (
        f"관할: {jurisdictions}\n"
        f"미팅 맥락: {meeting_context or '없음'}\n"
        f"탐지된 리스크:\n{risk_block}\n\n"
        "위 리스크를 피하면서도 비즈니스 목표에 가까운 합법적 차선책을 제안하세요."
    )

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": ALTERNATIVES_SYSTEM},
            {"role": "user", "content": user_msg},
        ],
        "max_completion_tokens": 1200,
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
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))

    try:
        result = await asyncio.to_thread(_post)
        content = result["choices"][0]["message"]["content"]
        data = json.loads(content)
        return {
            "summary": data.get("summary") or "",
            "alternatives": data.get("alternatives") or [],
            "questionsToConfirm": data.get("questionsToConfirm") or [],
        }
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        logger.error("Alternatives API error %s: %s", exc.code, body[:300])
        return {
            "summary": "차선책 생성 중 API 오류가 발생했습니다.",
            "alternatives": [],
            "questionsToConfirm": [],
        }
    except Exception:
        logger.exception("Alternatives suggestion failed")
        return {
            "summary": "차선책을 생성하지 못했습니다.",
            "alternatives": [],
            "questionsToConfirm": [],
        }
