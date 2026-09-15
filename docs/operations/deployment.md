# Rinolab 운영 배포

## 1. 최종 디렉터리 구조

```text
/srv/nas/shared/gwnam/source/rinolab/  Git checkout, 의존성 설치, 테스트
/opt/rinolab/api/                     systemd가 실행하는 production API
/opt/rinolab/api.previous/            직전 API rollback 사본
/var/www/rinolab/                     Caddy 정적 웹 root
/var/www/rinolab.previous/            직전 웹 rollback 사본
/etc/rinolab/api.env                  production 환경변수
/etc/rinolab/oidc-jwks.json           OIDC private signing JWKS
/etc/systemd/system/rinolab-api.service
/etc/caddy/Caddyfile
```

Git checkout은 빌드·테스트 입력으로만 사용한다. `rinolab-api.service`에는 NAS source
경로를 `InaccessiblePaths`로 지정해 production Node.js 프로세스가 source workspace를
읽지 못하게 한다.

## 2. 최초 디렉터리와 권한 설정

Ubuntu의 Caddy package가 `caddy` 사용자와 그룹을 생성했다는 전제다.

```bash
id gwnam
getent group caddy

sudo install -d -o gwnam -g gwnam -m 0750 /opt/rinolab
sudo install -d -o gwnam -g gwnam -m 0750 /opt/rinolab/api
sudo install -d -o root -g gwnam -m 0750 /etc/rinolab
sudo install -d -o gwnam -g caddy -m 0750 /var/www/rinolab
```

`/opt/rinolab`은 배포 사용자 `gwnam`이 새 release를 준비하고 교체할 수 있어야 한다.
systemd service 내부에서는 `ReadOnlyPaths=/opt/rinolab/api`가 적용되므로 실행 중인 Node.js
프로세스는 production 코드를 변경할 수 없다.

`/etc/rinolab`은 `root:gwnam`과 `0750`, 그 안의 secret은 `root:gwnam`과 `0640`을
사용한다. 일반 사용자는 내용을 읽을 수 없고 `gwnam`으로 실행되는 API만 읽을 수 있다.

## 3. 기존 환경변수와 JWKS 이전

새 목적지에 파일이 이미 있으면 아래 명령은 덮어쓰지 않고 중단한다. 기존 원본도 삭제하지
않으므로 새 구조의 동작을 확인한 뒤 별도로 보관 정책을 정한다.

```bash
SOURCE_ENV=/srv/nas/shared/gwnam/source/rinolab/api/.env.prd
TARGET_ENV=/etc/rinolab/api.env

if sudo test -e "$TARGET_ENV"; then
    echo "Target already exists: $TARGET_ENV"
else
    sudo install -o root -g gwnam -m 0640 "$SOURCE_ENV" "$TARGET_ENV"
fi

SOURCE_JWKS=/opt/rinolab/secrets/oidc-jwks.json
TARGET_JWKS=/etc/rinolab/oidc-jwks.json

if sudo test -e "$TARGET_JWKS"; then
    echo "Target already exists: $TARGET_JWKS"
else
    sudo install -o root -g gwnam -m 0640 "$SOURCE_JWKS" "$TARGET_JWKS"
fi
```

`/etc/rinolab/api.env`에서 다음 값을 확인한다.

```dotenv
PORT=3000
API_BIND_HOST=127.0.0.1
NODE_ENV=production
OIDC_SIGNING_KEY_PATH=/etc/rinolab/oidc-jwks.json
```

필요하면 `sudoedit /etc/rinolab/api.env`로 수정한다. 기존 private JWKS를 새로 생성하면
기존 token 검증에 영향을 주므로 이전할 파일이 있으면 반드시 그대로 복사한다.

API 계정의 읽기 권한은 다음 명령으로 확인한다.

```bash
sudo -u gwnam test -r /etc/rinolab/api.env
sudo -u gwnam test -r /etc/rinolab/oidc-jwks.json
sudo stat -c '%U:%G %a %n' /etc/rinolab/api.env /etc/rinolab/oidc-jwks.json
```

기대 권한은 `root:gwnam 640`이다.

## 4. node_modules 배포 방식

다음과 같은 staging release 방식을 사용한다.

1. source workspace에서 `npm ci`와 `npm test`를 실행한다.
2. `node_modules`, test, `.env*`, `.oidc`를 제외한 API 코드를 `/opt/rinolab` 아래 임시
   디렉터리로 rsync한다.
3. 임시 디렉터리에서 `npm ci --omit=dev`를 실행한다.
4. 모든 준비가 성공하면 임시 디렉터리를 `/opt/rinolab/api`로 전환한다.
5. 직전 실행본은 `/opt/rinolab/api.previous`에 한 세대 보관한다.

이는 선택지 C에 해당한다. source의 `node_modules`를 복사하는 A 방식보다 NAS I/O와 불필요한
개발 의존성을 줄이고, 실행 중인 `/opt/rinolab/api/node_modules`를 직접 지우는 B 방식보다
설치 실패와 부분 배포에 안전하다. Docker image나 Kubernetes 없이도 한 세대 rollback이
가능하다.

## 5. systemd 서비스

저장소의 [`deploy/rinolab-api.service`](../../deploy/rinolab-api.service)를 사용한다.

중요한 실행 설정은 다음과 같다.

```ini
WorkingDirectory=/opt/rinolab/api
EnvironmentFile=/etc/rinolab/api.env
ExecStart=/usr/bin/node /opt/rinolab/api/src/server.js
ReadOnlyPaths=/opt/rinolab/api
ReadOnlyPaths=/etc/rinolab
InaccessiblePaths=/srv/nas/shared/gwnam/source/rinolab
```

`After=network-online.target mongod.service`는 `mongod.service`가 존재할 때 시작 순서만
지정한다. MongoDB가 Docker 등 다른 방식으로 실행되어도 API 시작을 강제로 차단하지 않는다.
MongoDB를 반드시 같은 systemd의 `mongod.service`로 관리하고 함께 시작해야 하는 환경만
별도 drop-in에서 `Requires=mongod.service`를 추가한다.

## 6. systemd 최초 등록

아직 `/opt/rinolab/api`에 배포본이 없으므로 unit을 등록하고 enable만 한 뒤 배포 스크립트를
실행한다.

```bash
cd /srv/nas/shared/gwnam/source/rinolab

sudo install -o root -g root -m 0644 \
    deploy/rinolab-api.service \
    /etc/systemd/system/rinolab-api.service

sudo systemctl daemon-reload
sudo systemctl enable rinolab-api
sudo systemd-analyze verify /etc/systemd/system/rinolab-api.service
```

배포 스크립트도 매번 unit을 설치하고 `daemon-reload`하므로 이후 unit 변경은 일반 배포에
포함된다.

## 7. 최초 및 반복 배포

Node.js 22.1 이상 또는 24 LTS가 `/usr/bin/node`에 설치되어 있어야 한다. 현재 권장 버전은
24 LTS다.

```bash
/usr/bin/node --version
/usr/bin/node -p 'typeof URL.parse'
```

두 번째 명령은 `function`을 출력해야 한다. Git 변경을 commit하고 `main`에 push한 뒤
다음처럼 배포한다.

```bash
cd /srv/nas/shared/gwnam/source/rinolab
chmod 0750 deploy/run_deploy.sh
./deploy/run_deploy.sh
```

스크립트는 다음 순서로 실행된다.

```text
origin/main fetch와 checkout
→ 환경·secret·Node·Caddy·systemd preflight
→ source npm ci와 npm test
→ /opt/rinolab의 API staging에서 npm ci --omit=dev
→ /var/www의 web staging
→ systemd unit 설치
→ API와 web release 전환
→ rinolab-api restart
→ 최대 10회, 1초 간격 health check
→ 실패 시 직전 API와 web rollback
→ Caddyfile 설치 및 reload
```

`/opt/rinolab/.deploy.lock`의 `flock`으로 동시 배포를 막는다. Jenkins도 별도 배포 로직을
복제하지 않고 이 스크립트를 `gwnam` 권한으로 호출한다. `systemctl`, Caddyfile 설치와 web
release 전환에 필요한 명령만 passwordless sudo로 제한하는 것을 권장한다.

## 8. 정상 동작 확인

```bash
sudo systemctl status rinolab-api --no-pager
sudo systemctl status caddy --no-pager

curl --fail --show-error http://127.0.0.1:3000/api/health
curl --fail --show-error https://rinolab.org/api/health
curl --fail --show-error https://auth.rinolab.org/.well-known/openid-configuration
curl --fail --show-error https://auth.rinolab.org/jwks
```

실행 경로와 적용 환경 파일도 확인한다.

```bash
sudo systemctl show rinolab-api \
    -p User -p Group -p WorkingDirectory -p FragmentPath
sudo readlink -f /proc/$(systemctl show -p MainPID --value rinolab-api)/cwd
```

두 번째 명령은 `/opt/rinolab/api`를 출력해야 한다.

## 9. 로그와 장애 확인

```bash
sudo journalctl -u rinolab-api -n 100 --no-pager
sudo journalctl -u rinolab-api -f
sudo journalctl -u caddy -n 100 --no-pager

sudo systemctl status rinolab-api --no-pager -l
sudo systemctl status caddy --no-pager -l
sudo caddy validate --config /etc/caddy/Caddyfile
```

health check rollback이 발생하면 실패한 release가 다음 중 하나로 남는다.

```text
/opt/rinolab/api.failed.<UTC timestamp>
/var/www/rinolab.failed.<UTC timestamp>
```

원인을 확인한 후 운영자가 제거한다.

## 10. 변경되는 경로

| 기존 | 변경 후 | 역할 |
| --- | --- | --- |
| `/srv/nas/shared/gwnam/source/rinolab/api` | `/opt/rinolab/api` | production API 실행 |
| source 내부 `.env.prd` | `/etc/rinolab/api.env` | production 환경변수 |
| `/opt/rinolab/secrets/oidc-jwks.json` | `/etc/rinolab/oidc-jwks.json` | OIDC private JWKS |
| `/var/www/rinolab` | 유지 | Caddy 정적 웹 root |
| `/etc/caddy/Caddyfile` | 유지 | Caddy 운영 설정 |
| source 내부 `deploy/rinolab-api.service` | `/etc/systemd/system/rinolab-api.service` | 설치되는 systemd unit |

source workspace의 `.env.prd`와 기존 JWKS는 새 경로의 파일 및 서비스 동작을 확인하기 전까지
삭제하지 않는다. production 배포 스크립트의 rsync 대상에는 `/etc/rinolab`이 포함되지 않으므로
Git checkout이나 일반 배포로 secret이 덮어써지지 않는다.
