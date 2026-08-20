# Lion Meet 🦁

Zoom 스타일 화상회의 웹앱 — Django + WebRTC + AI 법률·세무 자문

## 기능

- **HD 화상회의**: WebRTC P2P 메시 토폴로지 (영상/음성)
- **화면 공유**: 원클릭 데스크톱/창 공유
- **법률·세무 AI**: 국제 미팅 시 관할별 법률·세금·컴플라이언스 리스크 점검 및 참가자 공유
- **채팅**: 회의 중 텍스트 채팅
- **참가자 목록**: 음소거/비디오 상태 표시
- **WebSocket 시그널링**: Django Channels 기반

## 기술 스택

| 구분 | 기술 |
|------|------|
| Backend | Django 5, Django Channels, Daphne |
| Frontend | HTML, CSS, JavaScript (Vanilla) |
| 영상/음성 | WebRTC (P2P mesh) |
| Legal AI | OpenAI Chat Completions (`gpt-5.6-terra`) |
| Server | AWS EC2 (3.34.197.18) |

## 로컬 실행

### 1. 환경 설정

`.env` 파일에 OpenAI API 키를 설정하세요:

```env
GPT_API_KEY=sk-your-openai-api-key
DJANGO_SECRET_KEY=your-random-secret-key
DEBUG=True
ALLOWED_HOSTS=localhost,127.0.0.1
```

### 2. 설치 및 실행

```bash
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # Linux/Mac

pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

브라우저에서 http://127.0.0.1:8000 접속

> WebRTC와 마이크 접근을 위해 `localhost` 또는 HTTPS 환경에서 테스트하세요.

## AWS EC2 배포

### 서버 정보

- **Public IP**: 3.34.197.18
- **SSH Key**: `lion.pem`

### SSH 접속

```bash
ssh -i lion.pem ubuntu@3.34.197.18
```

### 배포 (Windows)

```bat
deploy\deploy_from_windows.bat
```

### 배포 (Linux/Mac)

```bash
scp -i lion.pem -r config meetings static deploy manage.py requirements.txt ubuntu@3.34.197.18:/tmp/lion_meet_upload/
ssh -i lion.pem ubuntu@3.34.197.18 "bash /tmp/lion_meet_upload/deploy/setup_ec2.sh"
```

### EC2 보안 그룹

다음 포트를 열어야 합니다:

| 포트 | 용도 |
|------|------|
| 22 | SSH |
| 80 | HTTP (Nginx) |
| 443 | HTTPS (선택) |
| 8000 | Daphne (내부, Nginx 프록시) |

WebRTC를 위해 UDP 포트도 필요할 수 있습니다 (STUN/TURN).

### 배포 후 설정

```bash
ssh -i lion.pem ubuntu@3.34.197.18
sudo nano /opt/lion_meet/.env
# GPT_API_KEY 설정 후:
sudo systemctl restart lion-meet
```

## 사용 방법

1. http://3.34.197.18 접속
2. **회의 만들기** 클릭 → 회의실 생성
3. 회의 ID(URL)를 다른 참가자에게 공유
4. 카메라/마이크 확인 후 **회의 참가**
5. 하단 **법률 AI** 탭에서 국가·미팅 맥락을 설정하고 법률·세무 리스크 점검
6. 중요 알림은 **참가자에게 공유** 버튼으로 전체에 브로드캐스트

## 법률 AI 아키텍처

```
[참가자 UI] → legal-query (WebSocket) → [Django Consumer]
                                              ↓
                                    [OpenAI Chat Completions]
                                    (gpt-5.6-terra)
                                              ↓
                                    legal-response → 요청자 UI

[공유] legal-share → WebSocket broadcast → legal-alert (전체 참가자)
```

관할(국가)별 계약·세금·데이터 규제·IP·고용 등을 점검합니다.  
**일반 정보 제공용**이며 formal legal advice가 아닙니다.

## 프로젝트 구조

```
lion_hack/
├── config/           # Django 설정 (settings, asgi, urls)
├── meetings/         # 메인 앱
│   ├── consumers.py  # WebSocket (시그널링 + 법률 AI)
│   ├── legal_service.py   # OpenAI 법률·세무 자문
│   ├── legal_countries.py # 관할 국가 목록
│   ├── views.py      # HTTP views
│   └── templates/    # HTML 템플릿
├── static/
│   ├── css/style.css
│   └── js/
│       └── room.js       # WebRTC + UI 로직
├── deploy/           # AWS 배포 스크립트
├── requirements.txt
└── .env              # API 키 (git 제외)
```

## 트러블슈팅

| 문제 | 해결 |
|------|------|
| 법률 AI 안 됨 | `.env`에 `GPT_API_KEY` 확인, `sudo systemctl restart lion-meet` |
| 영상 연결 안 됨 | EC2 보안 그룹 UDP 허용, STUN 서버 접근 확인 |
| WebSocket 끊김 | Nginx `proxy_read_timeout 86400` 설정 확인 |
| static 파일 404 | `python manage.py collectstatic --noinput` 실행 |

## 라이선스

MIT
