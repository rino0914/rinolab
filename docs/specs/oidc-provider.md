# Rinolab OIDC Provider

## 1. 목적

Rinolab Account를 OpenID Connect Provider로 확장해 Immich와 향후 Rinolab
서비스가 기존 `accounts` 사용자를 통합 로그인에 사용할 수 있게 한다. 사용자 비밀번호는
OIDC client에 전달되지 않으며 client가 Rinolab MongoDB를 직접 조회하지 않는다.

운영 issuer는 다음과 같다.

```text
https://auth.rinolab.org
```

실제 값은 `OIDC_ISSUER` 환경변수로 관리한다. Cloudflare DNS와 Tunnel ingress는 이
저장소의 코드 변경만으로 생성되지 않으므로 운영자가 별도로 설정해야 한다.

## 2. 인증 흐름

```text
Immich
  → auth.rinolab.org/auth (Authorization Code + PKCE)
  → OIDC interaction
  → rinolab.org의 기존 세션 확인
     ├─ 로그인됨: 일회용 handoff 발급
     └─ 미로그인: 기존 login.html → 일회용 handoff 발급
  → auth.rinolab.org에서 handoff를 한 번만 소비
  → 필요한 scope Immich 권한 동의
  → authorization code 발급
  → Immich가 /token에서 code 교환
  → ID Token, Access Token 발급
  → Access Token으로 /me UserInfo 조회
```

포털 세션 쿠키를 `.rinolab.org` 전체에 공유하지 않는다. 대신 SHA-256 hash만 저장한
256비트 일회용 token을 `oidc_handoffs` 컬렉션에 2분 동안 보관한다. 이 방식은
포털 쿠키가 Drive, Photo 등 다른 서브도메인으로 전달되는 것을 막으면서 기존 로그인
세션을 재사용한다.

## 3. Endpoint

Discovery 문서에서 최종 URL을 확인해야 한다.

| 기능 | URL |
| --- | --- |
| Discovery | `https://auth.rinolab.org/.well-known/openid-configuration` |
| Authorization | `https://auth.rinolab.org/auth` |
| Token | `https://auth.rinolab.org/token` |
| UserInfo | `https://auth.rinolab.org/me` |
| JWKS | `https://auth.rinolab.org/jwks` |
| RP-Initiated Logout | `https://auth.rinolab.org/session/end` |

Authorization Code Flow만 client response type으로 허용하며 모든 authorization 요청에
PKCE를 요구한다. PKCE method는 `S256`이다. Dynamic Client Registration은 비활성화되어
있다.

## 4. Scope와 claim

지원 scope:

```text
openid profile email offline_access
```

| Scope | Claim |
| --- | --- |
| `openid` | `sub` |
| `email` | `email`, `email_verified` |
| `profile` | `name`, `preferred_username`, `rinolab_role` |

`sub`는 변경 가능한 이메일이 아니라 MongoDB `accounts._id`의 문자열 표현이다.
현재 이메일 검증 절차가 없으므로 `email_verified`는 거짓이다. `rinolab_role`은 향후
Rinolab 서비스의 권한 정책에 사용할 수 있지만 이번 단계에서는 Immich 관리자 권한으로
자동 변환하지 않는다.

표준 Authorization Code Flow에서는 profile/email claim을 UserInfo endpoint에서 얻는다.
ID Token은 RS256 비대칭키로 서명된다.

## 5. Client 등록

첫 client는 환경변수로 정적으로 등록한다. redirect URI는 완전히 일치해야 하며 wildcard를
허용하지 않는다. Client ID에는 영문, 숫자, `_`, `-`만 사용한다.

Immich 운영 예시:

```dotenv
OIDC_CLIENT_ID=immich
OIDC_CLIENT_NAME=Immich
OIDC_CLIENT_SECRET=<32바이트 이상의 무작위 값>
OIDC_REDIRECT_URIS=https://photo.rinolab.org/auth/login,https://photo.rinolab.org/user-settings,https://photo.rinolab.org/api/oauth/mobile-redirect
OIDC_POST_LOGOUT_REDIRECT_URIS=https://photo.rinolab.org/
OIDC_TOKEN_ENDPOINT_AUTH_METHOD=client_secret_post
```

여러 client와 client 관리 UI는 이번 단계에 포함하지 않는다. 두 번째 client를 추가하기
전에 단일 client 환경변수를 JSON 또는 MongoDB 기반 client registry로 확장한다.

## 6. 환경변수

| 이름 | 설명 |
| --- | --- |
| `OIDC_ENABLED` | `true`일 때 Provider 활성화 |
| `OIDC_ISSUER` | 외부에서 보이는 issuer URL |
| `OIDC_ACCOUNT_ORIGIN` | 기존 로그인 페이지가 제공되는 origin |
| `OIDC_SIGNING_KEY_PATH` | private JWKS 파일 경로, 운영 권장 |
| `OIDC_SIGNING_KEY` | private JWK/JWKS JSON 문자열, 파일 대신 사용 가능 |
| `OIDC_COOKIE_KEYS` | 현재 키부터 쉼표로 구분한 32자 이상 cookie signing key 두 개 이상 |
| `OIDC_CLIENT_ID` | 정적 client ID |
| `OIDC_CLIENT_NAME` | 사용자 동의 화면에 표시할 이름 |
| `OIDC_CLIENT_SECRET` | confidential client secret |
| `OIDC_REDIRECT_URIS` | 쉼표로 구분한 정확한 redirect URI 목록 |
| `OIDC_POST_LOGOUT_REDIRECT_URIS` | 쉼표로 구분한 logout redirect URI 목록 |
| `OIDC_TOKEN_ENDPOINT_AUTH_METHOD` | Immich 권장값 `client_secret_post` |

`OIDC_ENABLED=false`이면 기존 signup/login/logout/me만 실행되므로 OIDC 설정을 준비하는
동안 기존 기능을 계속 사용할 수 있다.

Cookie key와 client secret은 예를 들어 다음처럼 생성한다.

```bash
openssl rand -base64 48
```

## 7. Signing key 관리

개발용 RS256 private JWKS를 생성한다.

```bash
cd api
npm run oidc:generate-key
```

기본 출력은 Git에서 제외된 `api/.oidc/oidc-jwks.json`이며 파일이 이미 있으면 덮어쓰지
않는다. 운영에서는 `/opt/rinolab/secrets/oidc-jwks.json` 같은 repository 외부 경로에
권한 `0600`으로 저장하고 해당 파일을 API process 또는 container에 read-only로 제공한다.

키를 재시작마다 다시 생성하면 기존 ID Token 검증과 logout hint 검증이 깨진다. 키 교체는
다음 순서로 수행한다.

1. 새 private JWK를 JWKS 배열 끝에 추가한다.
2. 재시작해 새 public key를 JWKS endpoint에 공개한다.
3. 새 key를 배열 맨 앞으로 옮긴다.
4. 다시 재시작해 새 key로 서명을 시작한다.
5. 기존 token의 최대 수명이 지난 후 이전 key를 제거한다.

private JWK나 client secret을 Git에 commit하지 않는다.

## 8. MongoDB 데이터

기존 `accounts`와 `sessions` 컬렉션은 그대로 유지한다.

| Collection | 용도 | 만료 |
| --- | --- | --- |
| `accounts` | 기존 사용자 원본 | 없음 |
| `sessions` | 기존 Rinolab Express 세션 | `connect-mongo` 관리 |
| `oidc_state` | code, token, grant, OIDC session, interaction | TTL index |
| `oidc_handoffs` | 포털 세션에서 OIDC interaction으로 넘기는 일회용 상태 | 2분 TTL |

`oidc_state` document는 model 이름과 `payload`를 분리하며 authorization code와 token
소비 여부도 adapter가 저장한다. production에서 메모리 adapter를 사용하지 않는다.

## 9. 개발 실행 및 확인

```bash
docker compose --env-file deploy/.env.dev.example \
  -f deploy/compose.dev.yml up -d mongodb

cd api
cp .env.dev.example .env.dev
npm install
npm run oidc:generate-key
npm run dev
```

개발 환경에서는 Express가 `web/` 정적 파일도 제공하므로 다음 주소를 사용할 수 있다.

```text
http://localhost:3000/pages/login.html
http://localhost:3000/.well-known/openid-configuration
```

자동 검증:

```bash
cd api
npm test
```

테스트는 Discovery와 JWKS endpoint, 필수 endpoint/scope, PKCE 없는 요청 거부, S256,
RS256, wildcard redirect URI 거부, MongoDB ObjectId 기반 `sub` claim mapping을 확인한다.
실제 Immich 연결 전에는 브라우저에서
authorization 요청부터 code 교환 및 UserInfo까지 통합 검증한다.

## 10. Immich 설정

Immich 관리자 화면의 OAuth 설정에 다음 값을 입력한다.

| Immich 항목 | 값 |
| --- | --- |
| Enabled | 켬 |
| Issuer URL | `https://auth.rinolab.org` |
| Client ID | `OIDC_CLIENT_ID`와 같은 값 |
| Client Secret | `OIDC_CLIENT_SECRET`와 같은 값 |
| Scope | `openid email profile` |
| Signing Algorithm | `RS256` |
| Token Endpoint Auth Method | `client_secret_post` |
| Storage Label Claim | `preferred_username` |
| Auto Register | 운영 정책에 따라 설정 |

`oidc-provider`의 confidential web client는 custom URI scheme을 redirect URI로 받지
않는다. 모바일 앱을 사용하려면 Immich의 Mobile Redirect URI Override를 활성화하고
`https://photo.rinolab.org/api/oauth/mobile-redirect`를 사용한다.

## 11. 네트워크 및 운영 후속 작업

저장소의 Caddy 예제에는 다음 origin routing이 포함되어 있다.

```caddyfile
http://auth.rinolab.org {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-Proto https
    }
}
```

운영자가 직접 수행할 작업:

1. Cloudflare에 `auth.rinolab.org` Tunnel public hostname을 추가한다.
2. Caddy 설정을 validate하고 reload한다.
3. 운영 환경변수와 영구 signing JWKS를 배치한다.
4. API를 재시작한다.
5. 외부 Discovery와 JWKS endpoint를 확인한다.
6. Immich redirect URI를 실제 외부 URL과 정확히 맞춘다.
7. Immich 관리자 화면에서 OAuth를 활성화한다.

공인 IP에 80/443을 직접 공개하거나 공유기 포트포워딩을 추가할 필요는 없다.

## 12. Logout 동작

`/session/end` RP-Initiated Logout endpoint는 OIDC Provider 세션을 종료하고 등록된
post-logout redirect URI를 검증한다. 기존 포털의 `/api/auth/logout`은 기존 Express
세션을 종료한다.

현재 두 세션의 전역 logout은 연결하지 않았다. 따라서 Immich에서 OIDC logout을 해도
포털 세션이 남아 있으면 다음 authorization에서 다시 SSO될 수 있다. 전 서비스 logout,
front-channel logout 또는 back-channel logout은 각 client의 요구사항을 정한 뒤 후속
단계에서 구현한다.
