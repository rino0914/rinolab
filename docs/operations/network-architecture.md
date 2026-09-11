# 네트워크 및 Cloudflare Tunnel 구성

## 1. 목적

이 문서는 Rinolab 웹 서비스의 네트워크 구조와 배포 시 지켜야 할 기준을 기록한다.
새 서비스를 추가하거나 Caddy 설정을 변경할 때 이 구조를 기본 전제로 사용한다.

## 2. 전체 구조

```text
Browser
   │ HTTPS
   ▼
Cloudflare Edge
   │ Cloudflare Tunnel
   ▼
cloudflared (Ubuntu homelab 서버)
   │ localhost 또는 Docker network
   ▼
Caddy 또는 내부 서비스
```

Cloudflare Edge는 외부 사용자의 HTTPS 연결과 DNS를 처리한다. 홈랩 서버에서 실행되는
`cloudflared`가 Cloudflare로 outbound 연결을 만들기 때문에 외부 사용자의 장치에는
`cloudflared`가 필요하지 않다.

## 3. 네트워크 원칙

- DNS A 레코드로 홈랩의 공인 IP를 직접 노출하지 않는다.
- 일반 웹 서비스를 위해 공유기의 WAN 80/443 포트를 포워딩하지 않는다.
- 외부 사용자의 HTTPS는 Cloudflare Edge에서 종료한다.
- Tunnel의 내부 origin은 `localhost` 또는 격리된 Docker network를 사용한다.
- Caddy를 사용하더라도 인터넷에 노출된 TLS endpoint가 아닌 내부 reverse proxy로 사용한다.
- Caddy에 Let's Encrypt 인증서나 Cloudflare Origin Certificate가 있다는 전제로 애플리케이션을 구성하지 않는다.

FTP/FTPS처럼 Cloudflare Tunnel이 지원하지 않는 프로토콜은 이 문서의 웹 서비스 구조와
분리해 검토한다. 해당 프로토콜의 포트포워딩 여부가 웹 서비스의 80/443 공개를 의미하지는
않는다.

## 4. 내부 서비스

현재 확인된 내부 서비스 포트는 다음과 같다.

| 공개 호스트 | 내부 서비스 | 포트 |
| --- | --- | ---: |
| `rinolab.org` | Rinolab 정적 웹 | Caddy에서 파일 제공 |
| `rinolab.org/api/*` | Rinolab Node API | `3000` |
| `auth.rinolab.org` | Rinolab OIDC Provider | `3000` |
| `drive.rinolab.org` | FileBrowser | `8080` |
| `photo.rinolab.org` | Immich | `2283` |
| `console.rinolab.org` | Cockpit | `9090` |

Cockpit의 포트는 확인되어 있지만 현재 저장소의 Caddyfile에는 프록시가 정의되어 있지 않다.
Tunnel이 Cockpit에 직접 연결되는 경우에는 Caddy 라우팅이 필요하지 않다.

## 5. Caddy의 역할

저장소의 [`deploy/Caddyfile`](../../deploy/Caddyfile)은 다음 요청만 처리한다.

1. `rinolab.org/api/*`를 Node API의 `127.0.0.1:3000`으로 전달한다.
2. 그 밖의 `rinolab.org` 요청에는 `/var/www/rinolab`의 정적 파일을 제공한다.
3. Drive와 Photo 호스트를 각각의 내부 서비스로 전달한다.
4. Auth 호스트의 전체 요청을 Node API의 OIDC Provider로 전달한다.

Caddy 사이트 주소에는 `http://`를 명시한다. 이는 Caddy의 자동 HTTPS 및 HTTP에서
HTTPS로의 리다이렉트를 사용하지 않고 Tunnel 내부에서 HTTP origin으로 동작하게 하기
위함이다.

Cloudflare Edge에서 사용자 HTTPS가 종료되고 Tunnel 내부 구간은 HTTP이므로 Rinolab API와
OIDC reverse proxy는 upstream에 `X-Forwarded-Proto: https`를 명시한다. Express와
`oidc-provider`는 이 값을 바탕으로 production secure cookie를 발급한다. Caddy를 Tunnel
외의 일반 HTTP 진입점으로도 사용하게 된다면 이 고정 header 대신 trusted proxy 구성을
다시 검토해야 한다.

```text
Cloudflare Edge
  → Tunnel
  → cloudflared
  → http://Caddy
  → 정적 파일 또는 내부 서비스
```

`cloudflared`와 Caddy가 모두 호스트에서 실행될 때는 `127.0.0.1`을 사용할 수 있다.
둘 중 하나가 컨테이너에서 실행된다면 컨테이너의 `localhost`는 호스트나 다른 컨테이너를
가리키지 않으므로 같은 Docker network의 서비스 이름으로 연결해야 한다.

## 6. Rinolab 웹 애플리케이션

프런트엔드는 `/api/auth/...`와 같은 동일 출처 상대 경로로 API를 호출한다. 브라우저에서는
웹 페이지와 API가 모두 `https://rinolab.org`로 보이고, 내부에서만 Caddy가 `/api/*`를
Node 프로세스로 분기한다. 따라서 별도의 CORS 설정이나 외부 API 포트를 공개할 필요가 없다.

Node API는 production 환경에서 secure 세션 쿠키를 사용하고 Caddy 뒤에서 동작한다.
프록시 계층이나 실행 위치가 변경되면 Express의 `trust proxy` 설정과 실제 클라이언트 IP
전달 방식을 함께 재검토해야 한다. 홉 수나 Cloudflare 헤더를 확인하지 않은 상태에서 임의로
신뢰 범위를 넓히지 않는다.

## 7. 변경 범위

저장소에서 관리하는 범위는 애플리케이션, Caddyfile 및 필요한 배포 예제다. 다음 항목은
별도의 명시적인 작업 없이 변경하지 않는다.

- Cloudflare DNS 레코드
- Cloudflare Tunnel 및 ingress 설정
- Cloudflare Access 정책
- 공유기 포트포워딩
- 호스트 방화벽
- 운영 서버의 인증서

## 8. 배포 확인

Caddyfile을 운영 서버에 반영하기 전에 서버에서 구문을 검사한다.

```bash
caddy validate --config /etc/caddy/Caddyfile
```

검사가 성공한 경우 설정을 reload하고, 내부 Caddy endpoint에서 Host 헤더를 지정해 API
연결을 확인한다.

```bash
sudo systemctl reload caddy
curl -i -H 'Host: rinolab.org' http://127.0.0.1/api/health
```

정상이라면 API 상태 확인 요청은 HTTP 200과 다음 JSON을 반환한다.

```json
{"success":true}
```

마지막으로 외부에서 `https://rinolab.org`에 접속해 정적 페이지와 로그인 요청이 모두
Tunnel을 통해 정상적으로 전달되는지 확인한다.
