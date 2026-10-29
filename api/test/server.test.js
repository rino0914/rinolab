import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const serverFile = fileURLToPath(new URL("../src/server.js", import.meta.url));

// 실제 진입점을 실행하되 외부 MongoDB 연결만 대체한다. 운영 환경파일은 로드하지 않는다.
const replacements = [
    [new URL("../src/db.js", import.meta.url).href, `
        export async function connectDB() {
            if (process.env.TEST_DB_START_FAILURE === "true") {
                throw new Error("test database startup failure");
            }
        }
        export function getDB() { throw new Error("Unexpected database access in startup test"); }
    `],
    [import.meta.resolve("connect-mongo"), `
        import session from ${JSON.stringify(import.meta.resolve("express-session"))};
        export default { create: () => new session.MemoryStore() };
    `]
];
const loader = `
    const replacements = new Map(${JSON.stringify(replacements)});
    export async function load(url, context, nextLoad) {
        if (replacements.has(url)) {
            return { format: "module", shortCircuit: true, source: replacements.get(url) };
        }
        return nextLoad(url, context);
    }
`;
const registerLoader = `import { register } from "node:module";
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)});`;

async function reservePort(t) {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return server;
}

function startProcess(t, port, extraEnvironment = {}) {
    const child = spawn(process.execPath, [
        "--import", `data:text/javascript,${encodeURIComponent(registerLoader)}`,
        serverFile
    ], {
        env: {
            ...process.env,
            DOTENV_CONFIG_PATH: "/dev/null",
            NODE_ENV: "production",
            PORT: String(port),
            API_BIND_HOST: "127.0.0.1",
            MONGODB_URI: "mongodb://unused.invalid/test",
            MONGODB_DB: "test",
            SESSION_SECRET: "startup-test-only",
            OIDC_ENABLED: "false",
            TEST_DB_START_FAILURE: "false",
            ...extraEnvironment
        },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const exited = once(child, "exit");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
    t.after(async () => {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await exited;
    });
    return { child, exited, output: () => output };
}

describe("production server startup", () => {
    it("starts the real entry point and serves the health endpoint", async (t) => {
        const reservation = await reservePort(t);
        const port = reservation.address().port;
        await new Promise((resolve) => reservation.close(resolve));
        const process = startProcess(t, port);

        const ready = new Promise((resolve, reject) => {
            const cleanup = () => {
                process.child.stdout.off("data", onData);
                process.child.off("exit", onExit);
            };
            const onData = () => {
                if (process.output().includes("Node server started")) {
                    cleanup();
                    resolve();
                }
            };
            const onExit = () => {
                cleanup();
                reject(new Error(`Server exited before listening:\n${process.output()}`));
            };
            process.child.stdout.on("data", onData);
            process.child.once("exit", onExit);
        });
        await ready;
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
            signal: AbortSignal.timeout(3000)
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { success: true });
        assert.equal(process.child.exitCode, null, process.output());
    });

    it("exits with failure when the port is already occupied", async (t) => {
        const reservation = await reservePort(t);
        const process = startProcess(t, reservation.address().port);
        const [code, signal] = await process.exited;
        assert.equal(signal, null, process.output());
        assert.equal(code, 1, process.output());
        assert.match(process.output(), /EADDRINUSE/);
        assert.doesNotMatch(process.output(), /Node server started/);
    });

    it("exits with failure when database initialization fails", async (t) => {
        const process = startProcess(t, 3000, { TEST_DB_START_FAILURE: "true" });
        const [code, signal] = await process.exited;
        assert.equal(signal, null, process.output());
        assert.equal(code, 1, process.output());
        assert.match(process.output(), /test database startup failure/);
        assert.doesNotMatch(process.output(), /Node server started/);
    });
});
