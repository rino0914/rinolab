import bcrypt from "bcrypt";
import { ObjectId } from "mongodb";
import { getDB } from "../db.js";

const dummyPasswordHash = "$2b$12$r1mcHe0tgqmwGwFBlSvI5OGrGWqngacnLCVfjjKJEsdfTqNySPhEW";

export async function authenticateAccount(email, password, database = getDB()) {
    if (typeof email !== "string" || typeof password !== "string") {
        return undefined;
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !password) {
        return undefined;
    }

    const account = await database.collection("accounts").findOne({
        email: normalizedEmail
    });
    const passwordMatches = await bcrypt.compare(
        password,
        account?.passwordHash ?? dummyPasswordHash
    );

    return account && passwordMatches ? account : undefined;
}

export async function findActiveAccountById(accountId, database = getDB()) {
    if (!ObjectId.isValid(accountId)) {
        return undefined;
    }

    return database.collection("accounts").findOne({
        _id: new ObjectId(accountId),
        status: "ACTIVE"
    });
}
