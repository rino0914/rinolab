/**
 * @file server.js
 * @description API 서버코드 시작점
 */


// ============================================================
// 1. 모듈 Import
// ============================================================

import "dotenv/config";
import express from "express";
import session from "express-session";
import MongoStore from "connect-mongo";
import helmet from "helmet";
import { fileURLToPath } from "node:url";
import { connectDB } from "./db.js";
import authRouter from "./routes/auth.js";
import accountRouter from "./routes/account.js";
import { initializeOidcStorage } from "./oidc/adapter.js";
import { loadOidcConfig } from "./oidc/config.js";
import { createOidcInteractionRouter } from "./oidc/interactions.js";
import { createOidcProvider } from "./oidc/provider.js";
import { createPortalSessionBridge } from "./oidc/portal-session.js";

// ============================================================
// 2. express 초기 화 및 미들웨어 설정
// ============================================================
const app = express();
const port = Number(process.env.PORT ?? 3000);
const isProduction = process.env.NODE_ENV === "production";
const host = process.env.API_BIND_HOST?.trim() ||
    (isProduction ? "127.0.0.1" : "0.0.0.0");
const sessionSecret = process.env.SESSION_SECRET?.trim();
const mongoUri = process.env.MONGODB_URI?.trim();
const databaseName = process.env.MONGODB_DB?.trim();

// 예외 검증
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT는 1부터 65535 사이의 정수여야 합니다.");
}

if (!sessionSecret || !mongoUri || !databaseName) {
    throw new Error("세션 또는 MongoDB 환경변수가 설정되지 않았습니다.");
}

if (isProduction) {
    app.set("trust proxy", 1);
}
// HTTP 응답에 보안관련 헤더 설정
app.use(helmet());
// json 응답 최대 사이즈 설정
app.use(express.json({ limit: "16kb" }));

// MongoDB 저장소 생성
const portalStore = MongoStore.create({
    mongoUrl: mongoUri,
    dbName: databaseName,
    collectionName: "sessions"
});

// 웹 세션 생성
app.use(session({
    name: "rinus.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: portalStore,
    cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
        path: "/"
    }
}));

// API 라우터 등록
app.use("/api/auth", authRouter);
app.use("/api/account", accountRouter);

// 헬스 체크 API
app.get("/api/health", (request, response) => {
    response.json({ success: true });
});



// ============================================================
// 2. 서버 시작
// ============================================================
/**
 * 서버 시작
 */ 
async function startServer() {
    console.info("[SERVER] Starting server.")
    try {
        // 1. DB연결 
        console.debug("[DB] Connecting to MongoDB");
        await connectDB({ uri: mongoUri, databaseName });
        console.info("[DB MongoDB connected");
    
        // 2. 개발 환경 정적 파일 설정
        if (!isProduction) {
            const portalRoot = fileURLToPath(new URL("../../portal", import.meta.url));
            app.use(express.static(portalRoot));
            console.debug(`[PORTAL] Static files enabled: ${portalRoot}`)
        }
        // 2. OIDC 설정
        const oidcConfig = loadOidcConfig();
        if (oidcConfig) {
            console.debug("[OIDC] Iniitalizing storage")
            await initializeOidcStorage();

            const portalSessions = createPortalSessionBridge(portalStore);
            const oidcProvider = createOidcProvider(oidcConfig, { portalSessions });
            
            app.locals.revokeOidcSessions = (id) => portalSessions.revoke(oidcProvider, id);
            app.use(createOidcInteractionRouter(oidcProvider, oidcConfig, { portalSessions }));
            app.use(oidcProvider.callback());
            
            console.log(`[OIDC] Provider enabled: ${oidcConfig.issuer}`);
        } else{
            console.warn("[OIDC] Provider disabled: configuration not found");
        }

        // 3.서버 실행
        const server = app.listen(port, host);
        server.once("listening", () => {
            console.log(`Node server started at http://${host}:${port}.`);
        });

        server.on("error", (error) => {
            console.error("[SERVER] Listen failed:", error);
            // 포트 충돌 등으로 요청을 받을 수 없으면 systemd가 재시작할 수 있도록 실패로 종료한다.
            process.exit(1);
        });
    } catch(error) {
        console.error("[SERVER] Initialization failed:", error);
        throw error
    }
}

startServer().catch((error) => {
    console.error("서버 시작 실패:", error);
    process.exit(1);
});
