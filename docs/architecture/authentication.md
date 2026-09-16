# 인증 및 계정 구조

## 개요
- Collection: accounts
- 목적: 사용자 계정 및 인증 정보 관리

## Fields

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

## Index

| Field | Type | Unique | Purpose |
|---|---|---:|---|
| _id | 기본 | Y | PK |
| email | ASC | Y | 로그인 및 이메일 중복 방지 |

## Example

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
