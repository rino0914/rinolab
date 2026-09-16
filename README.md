# Rinolab

Rinolab 홈 포털, 계정 API, OIDC Provider와 홈랩 배포 설정을 관리하는 저장소다.

## 디렉터리

```text
rinolab/
├── api/                  Node.js 계정 API 및 OIDC Provider
│   ├── src/
│   │   ├── auth/         계정 조회와 세션 유틸리티
│   │   ├── routes/       HTTP API 라우터
│   │   ├── oidc/         OIDC Provider 구현
│   │   ├── db.js         MongoDB 연결
│   │   └── server.js     애플리케이션 진입점
│   └── test/
├── portal/               정적 웹 포털
│   ├── pages/
│   ├── assets/
│   └── src/
├── deploy/
│   ├── caddy/            Caddy 설정
│   ├── docker/           로컬 개발용 서비스
│   ├── systemd/          운영 API unit
│   └── scripts/
│       ├── deploy.sh     전체 배포 진입점
│       ├── health-check.sh
│       ├── rollback.sh
│       └── lib/common.sh
└── docs/
    ├── architecture/     구조와 인증·네트워크 설계
    ├── operations/       운영 절차
    └── specs/            기능 명세
```

## 주요 문서

- [전체 구조](docs/architecture/overview.md)
- [인증 및 계정 구조](docs/architecture/authentication.md)
- [네트워크 및 Cloudflare Tunnel](docs/architecture/network.md)
- [운영 배포 절차](docs/operations/deployment.md)
- [OIDC Provider 및 Immich 연결](docs/specs/oidc-provider.md)

운영에서는 Git 작업 영역과 실행 영역을 분리한다. API는 `/opt/rinolab/api`, 정적 포털은
`/var/www/rinolab`, 운영 설정과 secret은 `/etc/rinolab`에서 사용한다.

저장소 어느 위치에서든 다음처럼 배포, 상태 확인, rollback을 실행할 수 있다.

```bash
bash deploy/scripts/deploy.sh
bash deploy/scripts/health-check.sh
bash deploy/scripts/rollback.sh
```
