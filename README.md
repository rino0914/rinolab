# Rinolab

Rinolab 홈 포털과 계정 API, 홈랩 배포 설정을 관리하는 저장소다.

## 구성

- `web/`: 로그인, 회원가입 및 대시보드 프런트엔드
- `api/`: 세션 기반 계정 API
- `deploy/`: MongoDB와 Caddy 배포 설정
- `docs/`: 기능 명세 및 운영 문서

## 운영 문서

- [네트워크 및 Cloudflare Tunnel 구성](docs/operations/network-architecture.md)

운영 환경은 공인 IP로 Caddy를 직접 노출하는 방식이 아니다. 외부 웹 요청은
Cloudflare Tunnel을 통해 홈랩 서버로 전달되며, Caddy는 필요한 경우 내부 HTTP
reverse proxy로만 사용한다.
