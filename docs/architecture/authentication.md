# 인증 및 계정 구조

## 개요

Rinolab은 MongoDB의 `accounts` 컬렉션을 사용자 원본으로 사용한다. 포털 로그인은
Express 세션을 발급하고, OIDC Provider는 같은 계정을 `sub`와 claim의 원본으로 사용한다.

```text
portal → /api/auth/* → accounts + sessions
OIDC Provider        → accounts + oidc_state + oidc_handoffs
```

## 계정 컬렉션

- Collection: `accounts`
- 목적: 사용자 계정 및 인증 정보 관리

### Fields

| Field | Type | Required | Default | Description |
|---|---|---:|---|---|
| _id | ObjectId | Y | Auto | MongoDB PK |
| email | String | Y | - | 로그인 이메일 |
| username | String | 신규 계정 Y, 기존 계정 N | - | 서비스 공통 고정 ID |
| passwordHash | String | Y | - | 암호화된 비밀번호 |
| name | String | Y | - | 사용자 이름 |
| role | String | Y | USER | 권한 |
| status | String | Y | ACTIVE | 계정 상태 |
| createdAt | Date | Y | now | 생성일 |
| updatedAt | Date | Y | now | 수정일 |

### Index

| Field | Type | Unique | Purpose |
|---|---|---:|---|
| _id | 기본 | Y | PK |
| email | ASC | Y | 로그인 및 이메일 중복 방지 |
| username | ASC partial | Y | string username만 중복 방지 |

### Example

```javascript
{
  "_id": ObjectId("..."),
  "email": "user@rinolab.org",
  "username": "user01",
  "passwordHash": "$2a$...",
  "name": "홍길동",
  "role": "USER",
  "status": "ACTIVE",
  "createdAt": ISODate("2026-08-31T12:00:00Z"),
  "updatedAt": ISODate("2026-08-31T12:00:00Z")
}
```

## 인증 처리

- 회원가입 비밀번호는 bcrypt hash만 저장한다.
- 로그인 성공 시 session fixation을 막기 위해 세션 ID를 재생성한다.
- production 세션 쿠키는 `HttpOnly`, `Secure`, `SameSite=Lax`로 발급한다.
- 비활성 계정은 포털 로그인과 OIDC claim 조회에서 제외한다.
- OIDC `sub`에는 이메일 대신 변경되지 않는 `accounts._id`를 사용한다.

## username 정책과 migration

`username`은 표시 이름이나 로그인 이메일과 별개인 서비스 공통 고정 ID다. Rinolab Account,
OIDC `username` claim, FileBrowser 사용자명, Samba/Linux 계정명과
`/srv/nas/users/{username}` 경로에 동일하게 사용한다.

- 저장 전 lowercase로 정규화한다.
- 정규식은 `^[a-z][a-z0-9_-]{2,31}$`이다.
- MongoDB partial unique index는 string 값이 있는 계정에만 적용한다.
- 신규 가입에서는 필수이며, username이 없는 기존 계정은 계속 로그인할 수 있다.
- 기존 사용자는 `/pages/account.html`에서 최초 한 번 설정한다.
- 한번 저장한 username은 일반 사용자가 변경할 수 없다.
- email, email 앞부분 또는 ObjectId를 fallback으로 사용하지 않는다.

회원정보 API는 `GET /api/account/me`와 `PATCH /api/account/me`다. 두 endpoint 모두 현재
Express session의 자기 계정만 사용하며 password hash, role 등 불필요한 내부 필드를 반환하지
않는다. PATCH는 사전 중복 확인과 unique index의 duplicate-key 오류를 모두 409로 처리한다.

Drive OIDC client는 유효한 username이 없는 계정의 interaction을 중단하고 회원정보 페이지로
안내한다. Immich는 `preferred_username=email` 호환성을 유지하며 기존 계정도 계속 사용할 수 있다.

OIDC 흐름과 client 설정은 [OIDC Provider 명세](../specs/oidc-provider.md)를 참고한다.
