import { MongoClient } from "mongodb";

let client;
let database;

export async function connectDB(options = {}) {
    const uri = options.uri ?? process.env.MONGODB_URI;
    const databaseName = options.databaseName ?? process.env.MONGODB_DB;

    if (!uri || !databaseName) {
        throw new Error("MongoDB 환경변수가 설정되지 않았습니다.");
    }

    client = new MongoClient(uri);
    await client.connect();

    database = client.db(databaseName);
    await database.collection("accounts").createIndex(
        { email: 1 },
        { unique: true }
    );
    await database.collection("accounts").createIndex(
        { username: 1 },
        {
            unique: true,
            partialFilterExpression: { username: { $type: "string" } }
        }
    );

    console.log("MongoDB connected.");
    return database;
}

export function getDB() {
    if (!database) {
        throw new Error("MongoDB가 아직 연결되지 않았습니다.");
    }

    return database;
}
