import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts");
const deploy = readFileSync(join(scripts, "deploy.sh"), "utf8");
const common = readFileSync(join(scripts, "lib/common.sh"), "utf8");
const rollback = readFileSync(join(scripts, "rollback.sh"), "utf8");
const health = readFileSync(join(scripts, "health-check.sh"), "utf8");
const functions = (source) => [...source.matchAll(/^\w+\(\) \{\n[\s\S]*?^\}/gm)].map(([body]) => body).join("\n");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const globals = deploy.slice(deploy.indexOf('API_STAGE=""'), deploy.indexOf("read_env_value()"));
const traps = deploy.slice(deploy.indexOf("trap finish_deployment EXIT"), deploy.lastIndexOf('main "$@"'));

function fixture(t, { initial = false } = {}) {
    const root = mkdtempSync(join(tmpdir(), "rinolab-deploy-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const paths = {
        API_ROOT: root, API_DIR: join(root, "api"), API_PREVIOUS: join(root, "api.previous"),
        PORTAL_ROOT: join(root, "portal"), PORTAL_PREVIOUS: join(root, "portal.previous"),
        ENV_FILE: join(root, "env"), ENV_PREVIOUS: join(root, "env.previous"),
        SOURCE_SERVICE: join(root, "unit.new"), SERVICE_CONFIG: join(root, "unit"),
        SERVICE_PREVIOUS: join(root, "unit.previous"), SERVICE_PREVIOUS_ABSENT: join(root, "unit.previous.absent"),
        SOURCE_CADDY: join(root, "caddy.new"), CADDY_CONFIG: join(root, "caddy"),
        HEALTH_CHECK_SCRIPT: join(root, "health.sh"), REPO_DIR: root
    };
    for (const name of ["api.next", "portal.next", "api.previous", "portal.previous", ...(!initial ? ["api", "portal"] : [])]) {
        mkdirSync(join(root, name, "src"), { recursive: true });
        writeFileSync(join(root, name, "src/server.js"), name.endsWith("previous") ? "stale" : name.endsWith("next") ? "new" : "old");
    }
    for (const [name, data] of Object.entries({
        "env.stage": "new-env", "env.previous": "stale-env", "unit.new": "new-unit", "unit.previous": "stale-unit",
        "caddy": "old-caddy", "caddy.new": "new-caddy", "active": initial ? "0" : "1", "enabled": initial ? "disabled" : "enabled",
        ...(!initial ? { env: "old-env", unit: "old-unit" } : {})
    })) writeFileSync(join(root, name), data);
    writeFileSync(paths.HEALTH_CHECK_SCRIPT, '#!/bin/bash\nif [ "$MODE" = health ]; then exit 74; fi\n');
    const setup = Object.entries(paths).map(([key, value]) => `${key}=${quote(value)}`).join("\n");
    const mocks = `
ROOT=${quote(root)}
API_STAGE="$ROOT/api.next"
PORTAL_STAGE="$ROOT/portal.next"
ENV_STAGE="$ROOT/env.stage"
DEPLOY_USER=mock
API_SERVICE=mock-api
trace() { printf '%s\\n' "$*" >> "$ROOT/events"; }
fail_once() {
    if [ "$MODE" = "$1" ] && [ ! -e "$ROOT/injected" ]; then
        touch "$ROOT/injected"
        return 0
    fi
    return 1
}
mv() {
    if [ "$1" = "$API_DIR" ] && [ "$2" = "$API_PREVIOUS" ] && fail_once api-old-rename; then return 73; fi
    if [ "$1" = "$API_STAGE" ] && [ "$2" = "$API_DIR" ] && fail_once api-new-rename; then return 73; fi
    if [ "$1" = "$PORTAL_STAGE" ] && [ "$2" = "$PORTAL_ROOT" ] && fail_once portal-new-rename; then return 73; fi
    command mv "$@"
    if [ "$2" = "$API_DIR" ]; then
        if fail_once signal-term; then kill -s TERM "$$"; fi
        if fail_once signal-int; then kill -s INT "$$"; fi
    fi
}
sudo() {
    case "$1" in
        -v) return 0 ;;
        systemctl)
            shift
            trace "systemctl $*"
            case "$1" in
                is-active) [ "$(cat "$ROOT/active")" = 1 ] ;;
                is-enabled) cat "$ROOT/enabled"; [ "$(cat "$ROOT/enabled")" = enabled ] ;;
                stop) printf 0 > "$ROOT/active" ;;
                restart) if fail_once restart; then return 75; fi; printf 1 > "$ROOT/active" ;;
                enable) printf enabled > "$ROOT/enabled" ;;
                disable) printf disabled > "$ROOT/enabled" ;;
                reload) if fail_once caddy; then return 76; fi ;;
                daemon-reload) return 0 ;;
                *) return 99 ;;
            esac ;;
        install)
            shift
            local directory=0
            while [[ "$1" == -* ]]; do
                if [ "$1" = -d ]; then directory=1; shift; else shift 2; fi
            done
            if [ "$directory" = 1 ]; then trace "mkdir $1"; command mkdir -p "$1"; return; fi
            if [ "$2" = "$ENV_FILE" ] && fail_once env-install; then printf partial > "$2"; return 72; fi
            command cp "$1" "$2" ;;
        mv) shift; mv "$@" ;;
        *) command "$@" ;;
    esac
}
`;
    return {
        root,
        run(body, { mode = "success", manual = false } = {}) {
            const source = `set -Eeuo pipefail\numask 027\n${setup}\n${functions(common)}\n${globals}\n${functions(manual ? rollback : deploy)}\n${mocks}\n${manual ? "" : traps}\n${body}\n`;
            const script = join(root, "run.sh");
            writeFileSync(script, source);
            return spawnSync("bash", [script], { encoding: "utf8", timeout: 10000, env: { ...process.env, MODE: mode } });
        },
        read(name) { return readFileSync(join(root, name), "utf8"); },
        exists(name) { return existsSync(join(root, name)); }
    };
}

const activateAndVerify = "activate_release\nrestart_and_verify_api\ndeploy_caddy_config\nACTIVATION_STARTED=0";

for (const [mode, status] of [["env-install", 72], ["api-old-rename", 73], ["api-new-rename", 73], ["portal-new-rename", 73], ["restart", 75], ["health", 74], ["caddy", 76], ["signal-int", 130], ["signal-term", 143]]) {
    test(`restores this deployment after ${mode}, preserving its failure status`, (t) => {
        const f = fixture(t);
        const result = f.run(activateAndVerify, { mode });
        assert.equal(result.status, status, result.stderr);
        assert.equal(f.read("api/src/server.js"), "old");
        assert.equal(f.read("portal/src/server.js"), "old");
        assert.equal(f.read("env"), "old-env");
        assert.equal(f.read("unit"), "old-unit");
        assert.equal(f.read("caddy"), "old-caddy");
        assert.equal(f.read("active"), "1");
        assert.equal(f.read("enabled"), "enabled");
        assert.equal(f.exists("env.stage"), false);
    });
}

test("explicit fail after activation also restores the release", (t) => {
    const f = fixture(t);
    const result = f.run('activate_release\nfail "mock failure"');
    assert.equal(result.status, 1, result.stderr);
    assert.equal(f.read("api/src/server.js"), "old");
    assert.equal(f.read("unit"), "old-unit");
});

for (const mode of ["env-install", "api-new-rename", "portal-new-rename", "restart", "health"]) {
    test(`first deployment failure (${mode}) leaves no active release or new service`, (t) => {
        const f = fixture(t, { initial: true });
        const result = f.run(activateAndVerify, { mode });
        assert.notEqual(result.status, 0, result.stderr);
        for (const path of ["api", "portal", "env", "unit", "env.stage"]) assert.equal(f.exists(path), false, path);
        assert.equal(f.read("active"), "0");
        assert.equal(f.read("enabled"), "disabled");
    });
}

test("successful activation cleans temporary files and supports manual unit rollback", (t) => {
    const f = fixture(t);
    const result = f.run(activateAndVerify);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.read("api/src/server.js"), "new");
    assert.equal(f.read("api.previous/src/server.js"), "old");
    assert.equal(f.exists("env.stage"), false);
    assert.equal(f.exists("api.next"), false);
    assert.equal(f.exists("portal.next"), false);
    const restored = f.run("assert_deploy_user() { :; }\nacquire_deploy_lock() { :; }\nmain", { manual: true });
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(f.read("api/src/server.js"), "old");
    assert.equal(f.read("portal/src/server.js"), "old");
    assert.equal(f.read("env"), "old-env");
    assert.equal(f.read("unit"), "old-unit");
    assert.equal(f.read("caddy"), "new-caddy", "manual rollback retains Caddy config");
});

test("lock rejection occurs before checkout or other shared changes", (t) => {
    const f = fixture(t);
    const result = f.run(`
assert_deploy_user() { :; }
require_commands() { :; }
acquire_deploy_lock() { trace lock; return 77; }
preserve_legacy_environment() { trace preserve; }
checkout_source() { trace checkout; }
main
`);
    assert.equal(result.status, 77, result.stderr);
    assert.deepEqual(f.read("events").trim().split("\n"), [`mkdir ${f.root}`, "lock"]);
});

test("health retries pass finite connection and request timeouts", (t) => {
    const f = fixture(t);
    const result = f.run(`
${functions(health)}
HEALTH_URL=http://invalid.test
HEALTH_ATTEMPTS=2
HEALTH_INTERVAL_SECONDS=1
HEALTH_CONNECT_TIMEOUT_SECONDS=2
HEALTH_TIMEOUT_SECONDS=5
curl() { trace "curl $*"; return 28; }
sleep() { trace "sleep $*"; }
main
`);
    assert.equal(result.status, 1, result.stderr);
    const events = f.read("events").trim().split("\n");
    assert.deepEqual(events, [
        "curl --fail --silent --connect-timeout 2 --max-time 5 http://invalid.test",
        "sleep 1",
        "curl --fail --silent --connect-timeout 2 --max-time 5 http://invalid.test"
    ]);
});
