import "dotenv/config";
import express from "express";
import session from "express-session";
import MongoStore from "connect-mongo";
import helmet from "helmet";
import { fileURLToPath } from "node:url";
import { connectDB } from "./db.js";
import authRouter from "./routes/auth.js";
import { initializeOidcStorage } from "./oidc/adapter.js";
import { loadOidcConfig } from "./oidc/config.js";
import { createOidcInteractionRouter } from "./oidc/interactions.js";
import { createOidcProvider } from "./oidc/provider.js";

const app = express();
const port = process.env.PORT ?? 3000;
const isProduction = process.env.NODE_ENV === "production";
const host = process.env.API_BIND_HOST?.trim() ||
    (isProduction ? "127.0.0.1" : "0.0.0.0");
const sessionSecret = process.env.SESSION_SECRET;
const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB;

if (!sessionSecret || !mongoUri || !databaseName) {
    throw new Error("세션 또는 MongoDB 환경변수가 설정되지 않았습니다.");
}

if (isProduction) {
    app.set("trust proxy", 1);
}

app.use(helmet());
app.use(express.json({ limit: "16kb" }));
app.use(session({
    name: "rinus.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: mongoUri,
        dbName: databaseName,
        collectionName: "sessions"
    }),
    cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
        path: "/"
    }
}));
app.use("/api/auth", authRouter);

app.get("/api/health", (request, response) => {
    response.json({ success: true });
});

async function startServer() {
    await connectDB();

    if (!isProduction) {
        const webRoot = fileURLToPath(new URL("../../web", import.meta.url));
        app.use(express.static(webRoot));
    }

    const oidcConfig = loadOidcConfig();
    if (oidcConfig) {
        await initializeOidcStorage();
        const oidcProvider = createOidcProvider(oidcConfig);
        app.use(createOidcInteractionRouter(oidcProvider, oidcConfig));
        app.use(oidcProvider.callback());
        console.log(`OIDC Provider enabled: ${oidcConfig.issuer}`);
    }

    app.listen(port, host, () => {
        console.log(`Node server started at http://${host}:${port}.`);
    });
}

startServer().catch((error) => {
    console.error("서버 시작 실패:", error);
    process.exit(1);
});
