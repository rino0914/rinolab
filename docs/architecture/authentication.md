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

### Example

```javascript
{
  "_id": ObjectId("..."),
  "email": "user@rinolab.org",
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

OIDC 흐름과 client 설정은 [OIDC Provider 명세](../specs/oidc-provider.md)를 참고한다.
