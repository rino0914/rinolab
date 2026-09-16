# Rinolab 구조 개요

## 구성 요소

```text
Browser
  → Cloudflare Tunnel
  → Caddy
      ├─ /var/www/rinolab 정적 포털
      ├─ /api/* → Node.js API (127.0.0.1:3000)
      └─ auth.rinolab.org → OIDC Provider (127.0.0.1:3000)
                              └─ MongoDB
```

- `portal/`은 로그인, 회원가입, 대시보드를 포함한 정적 프런트엔드다.
- `api/`는 계정 API, 세션과 OIDC Provider를 제공한다.
- `deploy/`는 실행 환경별 설정을 `caddy`, `docker`, `systemd`, `scripts`로 분리한다.
- `docs/`는 구조 설명, 운영 절차, 기능 명세를 구분해 관리한다.

## 소스와 운영 경로

| 역할 | 경로 |
| --- | --- |
| Git checkout 및 테스트 | `/srv/nas/shared/gwnam/source/rinolab` |
| production API | `/opt/rinolab/api` |
| Caddy 정적 파일 | `/var/www/rinolab` |
| production 환경변수와 JWKS | `/etc/rinolab` |

운영 프로세스는 NAS의 Git checkout을 직접 실행하지 않는다. 배포 스크립트가 테스트를 통과한
API와 포털만 각 운영 경로로 전환한다.

## 포털

`portal/index.html`은 대시보드로 연결하며, 대시보드에서는 Drive, Photo, Console 같은 홈랩
서비스와 계정 기능을 제공한다. 브라우저의 API 요청은 `/api/...` 상대 경로를 사용하므로
외부에서는 포털과 API가 같은 origin으로 보인다.
