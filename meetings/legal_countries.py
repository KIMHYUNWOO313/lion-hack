"""Jurisdictions for cross-border meeting legal checks."""

LEGAL_COUNTRIES = [
    {"code": "KR", "label": "대한민국"},
    {"code": "US", "label": "미국"},
    {"code": "JP", "label": "일본"},
    {"code": "CN", "label": "중국"},
    {"code": "TW", "label": "대만"},
    {"code": "HK", "label": "홍콩"},
    {"code": "SG", "label": "싱가포르"},
    {"code": "VN", "label": "베트남"},
    {"code": "IN", "label": "인도"},
    {"code": "GB", "label": "영국"},
    {"code": "DE", "label": "독일"},
    {"code": "FR", "label": "프랑스"},
    {"code": "NL", "label": "네덜란드"},
    {"code": "CH", "label": "스위스"},
    {"code": "AE", "label": "UAE"},
    {"code": "AU", "label": "호주"},
    {"code": "CA", "label": "캐나다"},
    {"code": "MX", "label": "멕시코"},
    {"code": "BR", "label": "브라질"},
    {"code": "IL", "label": "이스라엘"},
]

VALID_COUNTRY_CODES = {c["code"] for c in LEGAL_COUNTRIES}


def country_label(code: str) -> str:
    for c in LEGAL_COUNTRIES:
        if c["code"] == code:
            return c["label"]
    return code
