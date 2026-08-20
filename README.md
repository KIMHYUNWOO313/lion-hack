# Lion Meet 🦁

Zoom 스타일 화상회의 웹앱 — Django + WebRTC + AI 법률·세무 자문

## 배포 · 저장소 (해커톤 제출)

| 항목 | URL |
|------|-----|
| **Live Demo** | https://3-34-197-18.sslip.io |
| **GitHub (FE / BE)** | https://github.com/KIMHYUNWOO313/lion-hack |
| **브랜치** | `main` |
| **AI 코드** | 동일 레포 (`meetings/legal_service.py`, `legal_risk_service.py`, `stt_service.py`) |

> 단일 레포(monorepo) 구조: Django 백엔드 + Vanilla JS 프론트(`static/`, `templates/`)  
> FE·BE 제출 시 **동일 GitHub URL**을 입력하세요. AI 별도 레포는 없습니다.

## 기능

- **HD 화상회의**: WebRTC P2P 메시 토폴로지 (영상/음성)
- **화면 공유**: 원클릭 데스크톱/창 공유
- **법률·세무 AI**: 국제 미팅 시 관할별 법률·세금·컴플라이언스 리스크 점검 및 참가자 공유
- **채팅**: 회의 중 텍스트 채팅
- **Firebase 녹화**: 회의 영상·음성·채팅 Firebase Storage/Firestore 저장
- **WebSocket 시그널링**: Django Channels 기반

## 기술 스택

| 구분 | 기술 |
|------|------|
| Backend | Django 5, Django Channels, Daphne |
| Frontend | HTML, CSS, JavaScript (Vanilla) |
| 영상/음성 | WebRTC (P2P mesh) |
| Auth / 녹화 | Firebase Auth, Storage, Firestore |
| Legal AI | OpenAI Chat Completions (`gpt-5.6-terra`) |
| Server | AWS EC2 (배포 예시) |

## 로컬 실행

### 1. 환경 설정

프로젝트 루트에 `.env` 파일을 만들고 API 키 등을 설정하세요 (`.env`는 Git에 포함되지 않습니다).

```env
GPT_API_KEY=sk-your-openai-api-key
DJANGO_SECRET_KEY=your-random-secret-key
DEBUG=True
ALLOWED_HOSTS=localhost,127.0.0.1
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_SERVICE_ACCOUNT_JSON=
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

배포 대상 서버 정보(IP, SSH 키, 도메인)는 **저장소에 포함하지 마세요.**  
로컬에서 `deploy/` 스크립트의 호스트 값을 본인 환경에 맞게 설정한 뒤 사용하세요.

### SSH 접속 (예시)

```bash
ssh -i your-key.pem ubuntu@YOUR_EC2_HOST
```

### 배포 (Windows)

```bat
deploy\deploy_from_windows.bat
```

### 배포 (Linux/Mac)

```bash
scp -i your-key.pem -r config meetings static deploy manage.py requirements.txt ubuntu@YOUR_EC2_HOST:/tmp/lion_meet_upload/
ssh -i your-key.pem ubuntu@YOUR_EC2_HOST "bash /tmp/lion_meet_upload/deploy/setup_ec2.sh"
```

### EC2 보안 그룹

| 포트 | 용도 |
|------|------|
| 22 | SSH |
| 80 | HTTP (Nginx) |
| 443 | HTTPS |
| 8000 | Daphne (내부, Nginx 프록시) |

WebRTC를 위해 UDP 포트도 필요할 수 있습니다 (STUN/TURN).

### 배포 후 설정

```bash
sudo nano /opt/lion_meet/.env
# GPT_API_KEY, FIREBASE_SERVICE_ACCOUNT_JSON 등 설정 후:
sudo systemctl restart lion-meet
```

## 사용 방법

1. 배포된 URL(또는 `http://127.0.0.1:8000`) 접속
2. **회원가입 / 로그인** 후 **새 회의** 또는 **회의 참가**
3. 카메라/마이크 허용 후 회의 참가
4. **법률 AI** · **리스크 모니터** 탭에서 실시간 점검
5. **녹화본** 메뉴에서 Firebase에 저장된 기록 확인

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
│   ├── consumers.py  # WebSocket (시그널링 + STT + 법률 AI)
│   ├── firebase_store.py  # Firestore / 녹화 메타
│   ├── views.py      # HTTP views
│   └── templates/    # HTML 템플릿
├── static/
│   ├── css/style.css
│   └── js/           # WebRTC, Firebase auth/recording
├── deploy/           # AWS 배포 스크립트
├── requirements.txt
└── .env              # API 키 (git 제외)
```

## 트러블슈팅

| 문제 | 해결 |
|------|------|
| 법률 AI 안 됨 | `.env`에 `GPT_API_KEY` 확인, 서비스 재시작 |
| 녹화본 안 보임 | Firebase Firestore/Storage 활성화, Service Account 설정 |
| 영상 연결 안 됨 | EC2 보안 그룹 UDP 허용, STUN 서버 접근 확인 |
| WebSocket 끊김 | Nginx `proxy_read_timeout 86400` 설정 확인 |
| static 파일 404 | `python manage.py collectstatic --noinput` 실행 |

## 라이선스

MIT
