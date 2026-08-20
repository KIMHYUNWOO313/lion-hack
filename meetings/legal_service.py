import asyncio
import json
import logging
import urllib.error
import urllib.request

from asgiref.sync import sync_to_async
from django.conf import settings

from .legal_countries import country_label

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """당신은 국제 B2B 미팅을 지원하는 법률·세무·컴플라이언스 자문 AI입니다.

역할:
- 참가국(관할)별로 법률, 세금, 규제 리스크를 점검합니다.
- 아래 [참고 법령 DB]에 있는 공식 출처·요약을 우선 인용하고, 답변 말미에 **참고 법령** 목록을 bullet로 제시하세요.

응답 형식 (마크다운, 간결히):
1. **요약** (2~3문장)
2. **관할별 체크리스트** — ▲/●/○ 위험 항목
3. **세금·회계**
4. **상대방에게 확인할 질문**
5. **참고 법령** (DB 항목 + 공식 URL)

주의: 일반 정보이며 formal legal advice가 아님. 한국어로 답변."""


def _build_context_message(my_country, partner_countries, meeting_context):
    parts = [f"우리 측: {country_label(my_country)} ({my_country})"]
    if partner_countries:
        labels = ", ".join(f"{country_label(c)} ({c})" for c in partner_countries)
        parts.append(f"상대: {labels}")
    if meeting_context:
        parts.append(f"미팅 맥락: {meeting_context}")
    return "\n".join(parts)


def _fetch_reference_block(countries: list[str]) -> tuple[str, list[dict]]:
    from .models import LegalReference

    codes = []
    for code in countries:
        if code and code not in codes:
            codes.append(code)

    if not codes:
        return "", []

    refs = list(
        LegalReference.objects.filter(country_code__in=codes).order_by(
            "country_code", "category", "title"
        )
    )
    if not refs:
        return "", []

    lines = ["[참고 법령 DB — 공식 출처 요약]"]
    meta = []
    for ref in refs:
        line = (
            f"- [{ref.country_code}] {ref.category} | {ref.title}: "
            f"{ref.summary[:280]}"
        )
        if ref.source_url:
            line += f" (출처: {ref.source_url})"
        lines.append(line)
        meta.append(
            {
                "country": ref.country_code,
                "category": ref.category,
                "title": ref.title,
                "url": ref.source_url,
            }
        )

    return "\n".join(lines), meta


fetch_reference_block = sync_to_async(_fetch_reference_block, thread_sensitive=True)


def _extract_content(result: dict) -> str:
    choice = result["choices"][0]
    message = choice.get("message") or {}
    content = (message.get("content") or "").strip()

    if content:
        return content

    finish = choice.get("finish_reason", "")
    usage = result.get("usage") or {}
    reasoning = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)
    if reasoning:
        return (
            "분석은 완료됐으나 응답 길이 한도에 도달했습니다. "
            "질문을 더 구체적으로 나눠 다시 시도해 주세요."
        )
    return f"빈 응답이 반환되었습니다 (finish={finish}). 다시 시도해 주세요."


def _build_messages(
    user_message: str,
    my_country: str,
    partner_countries: list,
    meeting_context: str,
    history: list | None,
    reference_block: str,
) -> list[dict]:
    context = _build_context_message(my_country, partner_countries, meeting_context)
    system = SYSTEM_PROMPT
    if reference_block:
        system += f"\n\n{reference_block}"

    messages = [{"role": "system", "content": system}]
    messages.append(
        {
            "role": "user",
            "content": f"[미팅 배경]\n{context}",
        },
    )

    seen = set()
    for item in (history or [])[-6:]:
        role = item.get("role")
        content = (item.get("content") or "").strip()
        if role not in ("user", "assistant") or not content:
            continue
        key = (role, content[:500])
        if key in seen:
            continue
        seen.add(key)
        messages.append({"role": role, "content": content[:2000]})

    if user_message.strip() not in {m["content"][:3000] for m in messages if m["role"] == "user"}:
        messages.append({"role": "user", "content": user_message[:3000]})

    return messages


async def ask_legal_advisor(
    user_message: str,
    my_country: str,
    partner_countries: list,
    meeting_context: str = "",
    history: list | None = None,
) -> dict:
    """Returns {text, references}"""
    api_key = settings.OPENAI_API_KEY
    if not api_key:
        return {
            "text": "OpenAI API 키가 설정되지 않았습니다. 관리자에게 문의하세요.",
            "references": [],
        }

    countries = [my_country] + list(partner_countries or [])
    reference_block, references = await fetch_reference_block(countries)

    model = getattr(settings, "LEGAL_MODEL", "gpt-5.6-terra")
    messages = _build_messages(
        user_message, my_country, partner_countries, meeting_context, history, reference_block
    )

    payload = {
        "model": model,
        "messages": messages,
        "max_completion_tokens": 8000,
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
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))

    try:
        result = await asyncio.to_thread(_post)
        text = _extract_content(result)
        return {"text": text, "references": references}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        logger.error("Legal API error %s: %s", exc.code, body[:500])
        try:
            detail = json.loads(body)["error"].get("message", "")
        except Exception:
            detail = ""
        msg = f"법률 자문 API 오류: {detail}" if detail else f"법률 자문 API 오류 ({exc.code})."
        return {"text": msg, "references": references}
    except Exception:
        logger.exception("Legal advisor request failed")
        return {"text": "법률 자문 요청 중 오류가 발생했습니다.", "references": references}
