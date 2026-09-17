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
Immich / Drive
  → auth.rinolab.org/auth (Authorization Code; Immich는 PKCE 필수)
  → portal_session interaction (매 authorization마다 현재 포털 계정 확인)
  → rinolab.org의 기존 세션 확인
     ├─ 로그인됨: 일회용 handoff 발급
     └─ 미로그인: 기존 login.html → 일회용 handoff 발급
  → auth.rinolab.org에서 handoff를 한 번만 소비
  → 포털 세션이 여전히 유효한지 확인하고 OIDC 세션 동기화
     ├─ 같은 계정: 세션과 기존 권한 동의 재사용
     └─ 다른 계정: oidc-provider의 end-session 처리 후 새 계정으로 재개
  → 필요한 scope 권한 동의 (새로운 권한일 때만)
  → authorization code 발급
  → client가 /token에서 code 교환
  → ID Token, Access Token 발급
  → Access Token으로 /me UserInfo 조회
```

포털 세션 쿠키를 `.rinolab.org` 전체에 공유하지 않는다. 대신 SHA-256 hash만 저장한
256비트 일회용 token을 `oidc_handoffs` 컬렉션에 2분 동안 보관한다. 이 방식은
포털 쿠키가 Drive, Photo 등 다른 서브도메인으로 전달되는 것을 막으면서 기존 로그인
세션을 재사용한다.

handoff에는 account ID, interaction UID와 발급한 포털 session ID를 함께 묶는다. 소비 시점,
동의 시점 및 authorization 재개 시점마다 같은 session store에서 로그인 유효성을 재확인한다.
`remember`는 포털의 로그인 유지 설정에 따르며 OIDC session만 독립적으로 장기 로그인하지 않는다.
`sub=accounts._id`, `username=account.username`, `preferred_username=account.email`은 유지한다.

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

Authorization Code Flow만 client response type으로 허용한다. PKCE는 client registry의
`pkce_required` 정책에 따라 요구하며, 사용할 때 method는 `S256`이다. Immich에는 계속
PKCE를 강제하고 FileBrowser Quantum v1.5.x 기반 Drive에는 강제하지 않는다. Dynamic
Client Registration은 비활성화되어 있다.

## 4. Scope와 claim

지원 scope:

```text
openid profile email offline_access
```

| Scope | Claim |
| --- | --- |
| `openid` | `sub` |
| `email` | `email`, `email_verified` |
| `profile` | `name`, `preferred_username`, `username`, `rinolab_role` |

`sub`는 변경 가능한 이메일이 아니라 MongoDB `accounts._id`의 문자열 표현이다.
`preferred_username`은 Immich 호환성을 위해 기존처럼 email이다. `username`은 Linux/Samba와
Drive에 사용할 안정적인 ID이며 계정에 값이 있을 때만 노출한다. email로부터 추측해 만들지
않는다. 현재 이메일 검증 절차가 없으므로 `email_verified`는 거짓이다. `rinolab_role`은 향후
Rinolab 서비스의 권한 정책에 사용할 수 있지만 이번 단계에서는 Immich 관리자 권한으로
자동 변환하지 않는다.

표준 Authorization Code Flow에서는 profile/email claim을 UserInfo endpoint에서 얻는다.
ID Token은 RS256 비대칭키로 서명된다.

## 5. Client 등록

client는 `/etc/rinolab/oidc-clients.json`의 정적 registry에 등록한다. redirect URI는 완전히
일치해야 하며 wildcard를 허용하지 않는다. Client ID에는 영문, 숫자, `_`, `-`만 사용한다.
`pkce_required`는 Rinolab 내부 정책이며 `oidc-provider` client metadata로 전달하지 않는다.

운영 파일 예시는 `deploy/examples/oidc-clients.example.json`에 있다. 주요 차이는 다음과 같다.

| Client | token auth | grant | PKCE |
| --- | --- | --- | --- |
| `immich` | `client_secret_post` | authorization code, refresh token | 필수 |
| `rinolab-drive` | `client_secret_basic` | authorization code | 현재 선택 |

Drive redirect URI는 `https://drive.rinolab.org/api/auth/oidc/callback`이며 scope는 `openid
profile email`, FileBrowser `userIdentifier`는 `username`이다. FileBrowser Quantum v1.5.x의
공식 OIDC 설정 및 provider 예제에는 PKCE 설정이나 authorization request의 challenge가
명시되지 않으므로 현재 Drive 정책은 `false`다. 향후 stable 코드에서 S256 지원을 확인한 뒤
registry 정책만 `true`로 올릴 수 있다.

## 6. 환경변수

| 이름 | 설명 |
| --- | --- |
| `OIDC_ENABLED` | `true`일 때 Provider 활성화 |
| `OIDC_ISSUER` | 외부에서 보이는 issuer URL |
| `OIDC_ACCOUNT_ORIGIN` | 기존 로그인 페이지가 제공되는 origin |
| `OIDC_SIGNING_KEY_PATH` | private JWKS 파일 경로, 운영 권장 |
| `OIDC_SIGNING_KEY` | private JWK/JWKS JSON 문자열, 파일 대신 사용 가능 |
| `OIDC_COOKIE_KEYS` | 현재 키부터 쉼표로 구분한 32자 이상 cookie signing key 두 개 이상 |
| `OIDC_CLIENTS_FILE` | JSON client registry 경로. 설정되면 아래 단일 client 변수가 무시됨 |
| `OIDC_CLIENT_ID` | 정적 client ID |
| `OIDC_CLIENT_NAME` | 사용자 동의 화면에 표시할 이름 |
| `OIDC_CLIENT_SECRET` | confidential client secret |
| `OIDC_REDIRECT_URIS` | 쉼표로 구분한 정확한 redirect URI 목록 |
| `OIDC_POST_LOGOUT_REDIRECT_URIS` | 쉼표로 구분한 logout redirect URI 목록 |
| `OIDC_TOKEN_ENDPOINT_AUTH_METHOD` | Immich 권장값 `client_secret_post` |

`OIDC_ENABLED=false`이면 기존 signup/login/logout/me만 실행되므로 OIDC 설정을 준비하는
동안 기존 기능을 계속 사용할 수 있다.

단일 client 환경변수는 migration fallback으로 남아 있으며 이 경로는 기존 Immich 설정과
PKCE 필수 정책을 그대로 사용한다. 신규 운영 구성은 `OIDC_CLIENTS_FILE`을 사용한다.

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
않는다. 운영에서는 `/etc/rinolab/oidc-jwks.json`처럼 repository 외부 경로에
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

`accounts.username`은 `/^[a-z][a-z0-9_-]{2,31}$/` 규칙으로 저장하며 lowercase로 정규화한다.
string username에만 적용되는 partial unique index를 사용하므로 username이 없는 기존 계정도
서비스 시작과 Immich 로그인이 가능하다. 기존 사용자는 포털 회원정보 페이지에서 최초 한 번
직접 설정하며 이후 일반 사용자는 변경할 수 없다. email에서 자동 생성하지 않는다.

Drive authorization 중 username이 없으면 interaction을 완료하지 않고
`https://rinolab.org/pages/account.html`로 안내한다. Immich의 기존
`preferred_username=email` 동작에는 이 제한을 적용하지 않는다.

| Collection | 용도 | 만료 |
| --- | --- | --- |
| `accounts` | 기존 사용자 원본 | 없음 |
| `sessions` | 기존 Rinolab Express 세션 | `connect-mongo` 관리 |
| `oidc_state` | code, token, grant, OIDC session, interaction | TTL index |
| `oidc_handoffs` | 포털 세션에서 OIDC interaction으로 넘기는 일회용 상태 | 2분 TTL |
| `oidc_session_bindings` | OIDC session UID → 포털 session ID 연결 | 30일 TTL, 사용 시 갱신 |

`oidc_state` document는 model 이름과 `payload`를 분리하며 authorization code와 token
소비 여부도 adapter가 저장한다. production에서 메모리 adapter를 사용하지 않는다.

## 9. 개발 실행 및 확인

```bash
MONGO_ROOT_PASSWORD='<local-mongodb-password>' \
docker compose --env-file deploy/docker/.env.dev \
  -f deploy/docker/compose.dev.yml up -d mongodb

cd api
npm install
npm run oidc:generate-key

export MONGODB_URI='mongodb://<user>:<password>@127.0.0.1:27017/?authSource=admin'
export SESSION_SECRET='<local-session-secret>'
export OIDC_COOKIE_KEYS='<current-cookie-key>,<previous-cookie-key>'
export OIDC_CLIENT_SECRET='<local-client-secret>' # 단일-client fallback일 때만
npm run dev
```

`api/.env.dev`의 일반 설정은 Git에서 관리하고 위 secret은 빈 값으로 유지한다. `dotenv`는
이미 export된 환경변수를 덮어쓰지 않으므로 개발자별 secret은 shell 환경에서 주입할 수 있다.

개발 환경에서는 Express가 `portal/` 정적 파일도 제공하므로 다음 주소를 사용할 수 있다.

```text
http://localhost:3000/pages/login.html
http://localhost:3000/.well-known/openid-configuration
```

자동 검증:

```bash
cd api
npm test
```

테스트는 복수 client와 auth method, client별 PKCE, Discovery/JWKS, username claim, 잘못된
redirect와 wildcard 거부, MongoDB ObjectId 기반 `sub`, 비활성 계정 차단을 확인한다.
세션 통합 테스트는 별도 host 쿠키 저장소와 실제 HTTP 서버, Express 로그인/로그아웃,
oidc-provider authorization → code 교환 → UserInfo를 사용한다. gwnam ↔ tester09 양방향 전환,
로그아웃 없는 직접 전환, 포털 쿠키만 삭제한 전환, handoff 재사용/브라우저 간 교환 거부,
포털 세션 만료, 다른 기기 유지, SSO 및 RP-Initiated Logout을 검증한다. MongoDB와 외부 RP는
테스트 대역을 사용하며 테스트 실행에는 loopback HTTP 포트를 열 수 있는 권한이 필요하다.
실제 Immich 연결 전에는 브라우저에서
authorization 요청부터 code 교환 및 UserInfo까지 통합 검증한다.

## 10. Immich 설정

Immich 관리자 화면의 OAuth 설정에 다음 값을 입력한다.

| Immich 항목 | 값 |
| --- | --- |
| Enabled | 켬 |
| Issuer URL | `https://auth.rinolab.org` |
| Client ID | registry의 `immich` |
| Client Secret | registry의 Immich `client_secret` |
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

## 12. Session, logout과 계정 전환

### Cookie와 origin

| Origin | Cookie | 서버 상태 / 역할 |
| --- | --- | --- |
| `https://rinolab.org` | `rinus.sid` | `sessions`: 로그인 계정, 로그인 시각, 로그인 유지 설정 |
| `https://auth.rinolab.org` | `_session`, `_session.sig` | `oidc_state`의 Session: accountId, client별 grant 등 |
| `https://auth.rinolab.org` | `_interaction`, `_interaction_resume` 및 `.sig` | interaction/재개 경로에 제한된 단기 쿠키 |
| `https://auth.rinolab.org` | `rinus_oidc_csrf_{uid}` | 해당 consent POST 경로의 CSRF 검증 |
| `https://photo.rinolab.org`, `https://drive.rinolab.org` | 각 앱 자체 로그인 쿠키 | 각 RP가 관리하는 앱 세션 |

포털과 Provider 쿠키는 host-only이며 `.rinolab.org` Domain으로 공유하지 않는다. 운영에서는
`Secure`, `HttpOnly`를 사용하고 포털/Provider 쿠키는 `SameSite=Lax`, consent CSRF 쿠키는
`SameSite=Strict`다. 동일 프로세스에서 API를 서비스해도 브라우저의 origin별 쿠키는 분리된다.
`oidc_session_bindings`는 서버 전용 연결 정보이며 포털 session ID를 브라우저 HTML이나
OIDC claim으로 전달하지 않는다.

### 현재 계정 확인과 SSO

Provider의 기본 login interaction은 `_session`에 accountId가 있으면 생략될 수 있다.
따라서 이 구현은 login prompt보다 앞에 `portal_session` 확인을 둔다. 매 authorization마다
브라우저가 포털로 잠깐 이동해 **지금 가진 포털 쿠키**를 확인한다. 서버에 남아 있는 옛 포털
세션이 유효하더라도, 브라우저가 그 쿠키를 삭제하고 새 계정으로 로그인한 경우를 구분하기 위해서다.

포털 로그인 상태가 유지되면 비밀번호를 다시 요구하지 않는다. 계정과 허용 scope가 같으면
기존 동의를 재사용한다. 모든 요청에 `prompt=login`이나 `max_age=0`을 추가하지 않는다.

새 authorization의 `prompt=none`은 포털 확인을 생략하고 옛 계정으로 성공시키지 않도록
`login_required`를 반환한다. client는 일반 authorization으로 다시 시작해야 한다. 포털에
로그인되어 있으면 이때도 비밀번호 입력 없이 진행된다.

### 포털 logout과 전환

1. `POST /api/auth/logout`이 현재 Express 세션을 삭제한다.
2. 해당 포털 session ID에 연결된 OIDC Session을 Provider의 `Session.destroy()`로 폐기한다.
3. 포털 응답은 `rinus.sid`를 삭제하고 기존처럼 204를 반환한다.
4. 다른 계정으로 로그인하면 새 포털 session ID를 발급한다. 로그아웃 없이 `/api/auth/login`을
   호출해도 기존 포털 세션을 regenerate하면서 연결된 OIDC Session을 폐기한다.
5. 다음 Drive/Immich authorization은 새 포털 계정을 확인하고 그 계정으로만 발급한다.

포털 응답으로 다른 host의 `_session` 쿠키를 지울 수는 없다. 브라우저에 값이 잠시 남더라도
서버 Session이 없으므로 인증 근거가 되지 않으며, 다음 Provider 접근에서 새 값으로 교체된다.
다른 브라우저/기기의 같은 계정까지 일괄 로그아웃시키지는 않는다.

연결 정보가 없는 배포 이전 OIDC 세션도 매 authorization의 포털 확인을 통과해야 한다.
포털 쿠키만 삭제해 옛 Provider 세션이 남아 있는 경우, handoff가 현재 계정을 확인한다.
서로 다른 accountId가 감지되면 oidc-provider 9.x의 내장 account-switch 경로가 CSRF token을
갖춘 `/session/end/confirm` POST로 이전 OP 세션을 종료한 뒤 authorization을 재개한다.
이 동작은 직접 accountId를 덮어써 이전 계정의 grant를 이어받는 것을 방지한다.

### RP-Initiated Logout과 범위

`/session/end`는 계속 표준 RP-Initiated Logout endpoint다. 실제 RP가 발급받은
`id_token_hint`, 등록된 `post_logout_redirect_uri`, `state`를 검증하고, logout 확인과
CSRF 검증은 oidc-provider에 맡긴다. 포털은 OIDC RP가 아니므로 ID Token을 갖고 있지 않다.
포털 logout에는 위의 서버 세션 연결을 사용하며, 다른 client의 ID Token을 만들거나 표준
logout 확인을 무조건 생략하지 않는다.
[RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)을 기준으로
검토했으며, 구현은 설치된 oidc-provider의 session 및 authorization-resume lifecycle을 따른다.

RP에서 OP logout만 수행하면 포털 로그인은 유지되므로 다음 authorization은 포털의 현재 계정으로
다시 SSO할 수 있다. 포털 logout은 새 OIDC 인증에 옛 계정 세션을 재사용하지 못하게 하지만,
이미 발급된 access/refresh token이나 Immich/FileBrowser 자체 로그인까지 전부 종료하는 기능은
아니다. 각 RP의 앱 세션 종료에는 해당 앱 logout 또는 별도로 합의된 back-channel logout이 필요하다.

배포 시 새 MongoDB 연결 컬렉션과 index는 API 시작 단계에서 생성한다. signing key, client secret,
Cloudflare 설정 변경은 필요하지 않다. 진행 중이던 옛 handoff는 새 세션 검증을 통과하지 못하면
서비스에서 다시 로그인해야 한다.
