"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const promises_1 = require("fs/promises");
const os_1 = require("os");
const path_1 = require("path");
const stream_1 = require("stream");
const child_process_1 = require("child_process");
class UsageError extends Error {
}
class OperationError extends Error {
}
const ignoredDependencyDirs = new Set([
    ".dart_tool",
    ".firebase",
    ".fvm",
    ".git",
    ".pub-cache",
    ".swiftpm",
    "build",
    "node_modules",
]);
async function main() {
    let tmpDir = "";
    let inputs;
    try {
        inputs = readInputs();
        tmpDir = await (0, promises_1.mkdtemp)((0, path_1.join)((0, os_1.tmpdir)(), "flutter-pub-cache-"));
        setOutput("cache-hit", "false");
        setOutput("cache-saved", "false");
        const objectName = await cacheObjectName(inputs, tmpDir);
        setOutput("object-name", objectName);
        if (!inputs.serviceAccount) {
            console.log(`service-account is not set; skipping remote Flutter pub cache ${inputs.action}`);
            return;
        }
        const bucket = await storageBucket(inputs);
        if (!bucket) {
            throw new UsageError(`storage-bucket is not set and storageBucket could not be read from ${inputs.firebaseOptionsPath}`);
        }
        const token = await accessToken(inputs.serviceAccount);
        if (inputs.action === "restore") {
            await restoreCache({ bucket, token, objectName, cacheDir: inputs.cachePath, tmpDir });
        }
        else {
            await saveCache({ bucket, token, objectName, cacheDir: inputs.cachePath, tmpDir });
        }
    }
    catch (error) {
        if (error instanceof UsageError) {
            console.error(error.message);
            process.exitCode = 2;
        }
        else if (inputs) {
            await handleError(error, inputs);
        }
        else {
            console.error(messageFrom(error));
            process.exitCode = 1;
        }
    }
    finally {
        if (tmpDir) {
            await (0, promises_1.rm)(tmpDir, { recursive: true, force: true });
        }
    }
}
function readInputs() {
    const actionInput = getInput("action", { required: true });
    if (actionInput !== "restore" && actionInput !== "save") {
        throw new UsageError("Usage: flutter-pub-cache <restore|save>");
    }
    const workingDirectory = absolutePath(getInput("working-directory") || ".", process.env.GITHUB_WORKSPACE || process.cwd());
    return {
        action: actionInput,
        serviceAccount: getInput("service-account") || process.env.FIREBASE_SERVICE_ACCOUNT || "",
        storageBucket: getInput("storage-bucket"),
        firebaseOptionsPath: getInput("firebase-options-path") || "lib/firebase_options.dart",
        cachePath: expandPath(getInput("cache-path") || process.env.PUB_CACHE || "~/.pub-cache"),
        keyPrefix: getInput("key-prefix") || "caches/flutter-pub",
        dependencyPaths: getInput("dependency-paths"),
        workingDirectory,
        repository: getInput("repository") || process.env.GITHUB_REPOSITORY || "unknown-repository",
        failOnError: parseBoolean(getInput("fail-on-error")),
    };
}
function getInput(name, options = {}) {
    const envNames = [
        `INPUT_${name.toUpperCase()}`,
        `INPUT_${name.replace(/-/g, "_").toUpperCase()}`,
        `INPUT_${name.replace(/ /g, "_").toUpperCase()}`,
    ];
    const value = envNames.map((envName) => process.env[envName]).find((item) => item != null) ?? "";
    const trimmed = value.trim();
    if (options.required && !trimmed) {
        throw new UsageError(`Input required and not supplied: ${name}`);
    }
    return trimmed;
}
function setOutput(name, value) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath) {
        return;
    }
    require("fs").appendFileSync(outputPath, `${name}=${value}\n`);
}
function warning(message) {
    console.log(`::warning::${message.replace(/\r?\n/g, "%0A")}`);
}
async function handleError(error, inputs) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError) {
        console.error(message);
        process.exitCode = 2;
        return;
    }
    if (inputs.failOnError) {
        console.error(message);
        process.exitCode = 1;
        return;
    }
    warning(`Flutter pub cache ${inputs.action} failed; continuing because fail-on-error is false. ${message}`);
}
function parseBoolean(value) {
    return /^(1|true|yes)$/i.test(value);
}
function expandPath(path) {
    if (path === "~") {
        return process.env.HOME || path;
    }
    if (path.startsWith("~/")) {
        return (0, path_1.join)(process.env.HOME || "", path.slice(2));
    }
    return path;
}
function absolutePath(path, base) {
    const expanded = expandPath(path);
    return (0, path_1.isAbsolute)(expanded) ? expanded : (0, path_1.join)(base, expanded);
}
async function storageBucket(inputs) {
    if (inputs.storageBucket) {
        return inputs.storageBucket;
    }
    const optionsPath = absolutePath(inputs.firebaseOptionsPath, inputs.workingDirectory);
    if (!(0, fs_1.existsSync)(optionsPath)) {
        return "";
    }
    const text = await (0, promises_1.readFile)(optionsPath, "utf8");
    const patterns = [
        /storageBucket\s*:\s*['"]([^'"]+)['"]/,
        /['"]storageBucket['"]\s*:\s*['"]([^'"]+)['"]/,
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
            return match[1];
        }
    }
    return "";
}
function base64Url(input) {
    return Buffer.from(input).toString("base64url");
}
async function accessToken(serviceAccountJson) {
    let serviceAccount;
    try {
        serviceAccount = JSON.parse(serviceAccountJson);
    }
    catch (error) {
        throw new OperationError(`Could not parse service account JSON: ${messageFrom(error)}`);
    }
    if (!serviceAccount.client_email || !serviceAccount.private_key) {
        throw new OperationError("Service account JSON must contain client_email and private_key");
    }
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64Url(JSON.stringify({
        iss: serviceAccount.client_email,
        scope: "https://www.googleapis.com/auth/devstorage.read_write",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
    }));
    const signingInput = `${header}.${payload}`;
    const signature = (0, crypto_1.createSign)("RSA-SHA256").update(signingInput).sign(serviceAccount.private_key);
    const assertion = `${signingInput}.${base64Url(signature)}`;
    const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
        }),
    });
    if (!response.ok) {
        throw new OperationError(`Failed to get Google access token (HTTP ${response.status}): ${await bodySnippet(response)}`);
    }
    const data = (await response.json());
    if (!data.access_token) {
        throw new OperationError("Google token response did not contain access_token");
    }
    return data.access_token;
}
async function cacheObjectName(inputs, tmpDir) {
    const host = await hostCacheKeyComponent();
    const flutter = await flutterCacheKeyComponent(tmpDir);
    const deps = await dependencyHash(inputs);
    const extension = await compressionExtension();
    return [
        inputs.keyPrefix.replace(/\/+$/, ""),
        inputs.repository,
        host,
        flutter,
        `deps-${deps}.${extension}`,
    ].join("/");
}
async function hostCacheKeyComponent() {
    const os = await run("uname", ["-s"], { ignoreFailure: true });
    const arch = await run("uname", ["-m"], { ignoreFailure: true });
    if (os.code === 0 && arch.code === 0) {
        return sanitizeComponent(`${os.stdout.trim()}-${arch.stdout.trim()}`);
    }
    return sanitizeComponent(`${process.platform}-${process.arch}`);
}
function sanitizeComponent(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-+/g, "-");
}
async function flutterCacheKeyComponent(tmpDir) {
    const versionFile = (0, path_1.join)(tmpDir, "flutter-version.json");
    const result = await run("flutter", ["--version", "--machine"], { stdoutFile: versionFile, ignoreFailure: true });
    if (result.code !== 0) {
        return "unknown-flutter";
    }
    try {
        const data = JSON.parse(await (0, promises_1.readFile)(versionFile, "utf8"));
        const value = [
            data.frameworkVersion,
            data.frameworkRevision?.slice(0, 12),
            data.dartSdkVersion,
        ].filter(Boolean).join("-");
        return sanitizeComponent(value || "unknown-flutter");
    }
    catch {
        return "unknown-flutter";
    }
}
async function dependencyHash(inputs) {
    const files = inputs.dependencyPaths
        ? await dependencyFilesFromPatterns(inputs.workingDirectory, inputs.dependencyPaths)
        : await autoDetectDependencyFiles(inputs.workingDirectory);
    const digest = (0, crypto_1.createHash)("sha256");
    for (const file of files) {
        const display = (0, path_1.relative)(inputs.workingDirectory, file);
        digest.update(display);
        digest.update("\n");
        digest.update(await sha256Digest(file));
        digest.update("  ");
        digest.update(display);
        digest.update("\n");
    }
    return digest.digest("hex").slice(0, 20);
}
async function dependencyFilesFromPatterns(workDir, patternsText) {
    const patterns = patternsText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
    const files = [];
    const seen = new Set();
    for (const pattern of patterns) {
        const matches = hasGlob(pattern)
            ? await globFiles(workDir, pattern)
            : [(0, path_1.isAbsolute)(pattern) ? pattern : (0, path_1.join)(workDir, pattern)];
        for (const match of matches) {
            await addDependencyFile(files, seen, workDir, match);
        }
    }
    return files;
}
async function autoDetectDependencyFiles(workDir) {
    const files = [];
    const seen = new Set();
    async function visit(dir) {
        const entries = await (0, promises_1.readdir)(dir, { withFileTypes: true });
        const names = new Set(entries.map((entry) => entry.name));
        for (const name of ["pubspec.yaml", "pubspec.lock"]) {
            if (names.has(name)) {
                await addDependencyFile(files, seen, workDir, (0, path_1.join)(dir, name));
            }
        }
        for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
            if (!ignoredDependencyDirs.has(entry.name)) {
                await visit((0, path_1.join)(dir, entry.name));
            }
        }
    }
    await visit(workDir);
    return files;
}
async function globFiles(workDir, pattern) {
    const matches = [];
    const absolutePattern = (0, path_1.isAbsolute)(pattern) ? pattern : (0, path_1.join)(workDir, pattern);
    const root = globRoot(absolutePattern);
    const matcher = globMatcher(absolutePattern);
    async function visit(dir) {
        const entries = await (0, promises_1.readdir)(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const path = (0, path_1.join)(dir, entry.name);
            if (entry.isDirectory()) {
                if (!ignoredDependencyDirs.has(entry.name)) {
                    await visit(path);
                }
            }
            else if (matcher(path)) {
                matches.push(path);
            }
        }
    }
    await visit(root);
    return matches.sort();
}
function globRoot(pattern) {
    const parts = pattern.split(path_1.sep);
    const rootParts = [];
    for (const part of parts) {
        if (/[?*[]/.test(part)) {
            break;
        }
        rootParts.push(part);
    }
    const root = rootParts.join(path_1.sep) || path_1.sep;
    return (0, fs_1.existsSync)(root) ? root : (0, path_1.dirname)(root);
}
function globMatcher(pattern) {
    const normalizedPattern = pattern.split(path_1.sep).join("/");
    const escaped = normalizedPattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\0")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\0/g, ".*");
    const regex = new RegExp(`^${escaped}$`);
    return (path) => regex.test(path.split(path_1.sep).join("/"));
}
function hasGlob(pattern) {
    return /[*?[]/.test(pattern);
}
async function addDependencyFile(files, seen, workDir, path) {
    const absolute = (0, path_1.resolve)(path);
    if (seen.has(absolute) || isIgnoredDependencyPath(workDir, absolute)) {
        return;
    }
    const info = await (0, promises_1.stat)(absolute).catch(() => null);
    if (info?.isFile()) {
        seen.add(absolute);
        files.push(absolute);
    }
}
function isIgnoredDependencyPath(workDir, path) {
    const rel = (0, path_1.relative)(workDir, path);
    if (!rel || rel.startsWith("..")) {
        return false;
    }
    return rel.split(path_1.sep).some((part) => ignoredDependencyDirs.has(part));
}
async function sha256Digest(path) {
    const digest = (0, crypto_1.createHash)("sha256");
    for await (const chunk of (0, fs_1.createReadStream)(path)) {
        digest.update(chunk);
    }
    return digest.digest("hex");
}
async function compressionExtension() {
    const result = await run("zstd", ["--version"], { ignoreFailure: true });
    return result.code === 0 ? "tar.zst" : "tar.gz";
}
async function compressionContentType() {
    return (await compressionExtension()) === "tar.zst" ? "application/zstd" : "application/gzip";
}
async function createArchive(cacheDir, archivePath) {
    const parent = (0, path_1.dirname)(cacheDir);
    const name = (0, path_1.basename)(cacheDir);
    if ((await compressionExtension()) === "tar.zst") {
        await pipeCommands(["tar", ["-cf", "-", "--exclude", `${name}/_temp`, "--exclude", `${name}/log`, "-C", parent, name]], ["zstd", ["-T0", "-1", "-q", "-o", archivePath]]);
        return;
    }
    await run("tar", [
        "-czf",
        archivePath,
        "--exclude",
        `${name}/_temp`,
        "--exclude",
        `${name}/log`,
        "-C",
        parent,
        name,
    ]);
}
async function extractArchive(cacheDir, archivePath) {
    const parent = (0, path_1.dirname)(cacheDir);
    await (0, promises_1.rm)(cacheDir, { recursive: true, force: true });
    await (0, promises_1.mkdir)(parent, { recursive: true });
    if (archivePath.endsWith(".zst")) {
        await pipeCommands(["zstd", ["-dc", archivePath]], ["tar", ["-xf", "-", "-C", parent]]);
        return;
    }
    await run("tar", ["-xzf", archivePath, "-C", parent]);
}
async function restoreCache(options) {
    const archivePath = (0, path_1.join)(options.tmpDir, `flutter-pub-cache.${await compressionExtension()}`);
    const encodedObjectName = encodeURIComponent(options.objectName);
    const url = `https://storage.googleapis.com/storage/v1/b/${options.bucket}/o/${encodedObjectName}?alt=media`;
    console.log(`Restoring Flutter pub cache from gs://${options.bucket}/${options.objectName}`);
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${options.token}` },
    });
    if (response.status === 404) {
        console.log("Flutter pub cache miss");
        setOutput("cache-hit", "false");
        return;
    }
    if (!response.ok || !response.body) {
        throw new OperationError(`Failed to download Flutter pub cache (HTTP ${response.status}): ${await bodySnippet(response)}`);
    }
    await (0, promises_1.writeFile)(archivePath, stream_1.Readable.fromWeb(response.body));
    console.log("Downloaded Flutter pub cache archive:");
    await du(archivePath);
    await extractArchive(options.cacheDir, archivePath);
    console.log("Restored Flutter pub cache:");
    await du(options.cacheDir);
    console.log(`File count: ${await countFiles(options.cacheDir)}`);
    setOutput("cache-hit", "true");
}
async function saveCache(options) {
    setOutput("cache-saved", "false");
    if (await objectExists(options.bucket, options.token, options.objectName)) {
        console.log(`Flutter pub cache already exists; skipping upload: gs://${options.bucket}/${options.objectName}`);
        return;
    }
    if (!(0, fs_1.existsSync)(options.cacheDir)) {
        console.log(`Flutter pub cache not found; nothing to save: ${options.cacheDir}`);
        return;
    }
    const archivePath = (0, path_1.join)(options.tmpDir, `flutter-pub-cache.${await compressionExtension()}`);
    console.log("Creating Flutter pub cache archive:");
    await du(options.cacheDir);
    await createArchive(options.cacheDir, archivePath);
    await du(archivePath);
    const size = (await (0, promises_1.stat)(archivePath)).size;
    const contentType = await compressionContentType();
    console.log(`Uploading Flutter pub cache to gs://${options.bucket}/${options.objectName}`);
    const uploadUrl = await createUploadSession({
        bucket: options.bucket,
        token: options.token,
        objectName: options.objectName,
        contentType,
        size,
    });
    await uploadFile(uploadUrl, archivePath, contentType);
    console.log("Uploaded Flutter pub cache");
    setOutput("cache-saved", "true");
}
async function objectExists(bucket, token, objectName) {
    const encodedObjectName = encodeURIComponent(objectName);
    const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodedObjectName}?fields=name,size,updated`;
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 404) {
        return false;
    }
    if (!response.ok) {
        throw new OperationError(`Failed to inspect Flutter pub cache object (HTTP ${response.status}): ${await bodySnippet(response)}`);
    }
    return true;
}
async function createUploadSession(options) {
    const response = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${options.bucket}/o?uploadType=resumable`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${options.token}`,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": options.contentType,
            "X-Upload-Content-Length": String(options.size),
        },
        body: JSON.stringify({ name: options.objectName, contentType: options.contentType }),
    });
    if (!response.ok) {
        throw new OperationError(`Failed to create Flutter pub cache upload session (HTTP ${response.status}): ${await bodySnippet(response)}`);
    }
    const uploadUrl = response.headers.get("location");
    if (!uploadUrl) {
        throw new OperationError("Could not read resumable upload URL");
    }
    return uploadUrl;
}
async function uploadFile(uploadUrl, archivePath, contentType) {
    const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: (0, fs_1.createReadStream)(archivePath),
        duplex: "half",
    });
    if (!response.ok) {
        throw new OperationError(`Failed to upload Flutter pub cache (HTTP ${response.status}): ${await bodySnippet(response)}`);
    }
}
async function bodySnippet(response) {
    const text = await response.text().catch(() => "");
    return text.slice(0, 1000);
}
async function du(path) {
    const result = await run("du", ["-sh", path], { ignoreFailure: true });
    if (result.stdout.trim()) {
        console.log(result.stdout.trim());
    }
}
async function countFiles(path) {
    let count = 0;
    async function visit(dir) {
        const entries = await (0, promises_1.readdir)(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const child = (0, path_1.join)(dir, entry.name);
            if (entry.isDirectory()) {
                await visit(child);
            }
            else if (entry.isFile()) {
                count += 1;
            }
        }
    }
    await visit(path);
    return count;
}
async function run(command, args, options = {}) {
    return new Promise((resolvePromise, reject) => {
        const child = (0, child_process_1.spawn)(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        const stdout = [];
        const stderr = [];
        child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
        child.on("error", (error) => {
            if (options.ignoreFailure) {
                resolvePromise({ code: 127, stdout: "", stderr: messageFrom(error) });
            }
            else {
                reject(error);
            }
        });
        child.on("close", async (code) => {
            const stdoutText = Buffer.concat(stdout).toString();
            const stderrText = Buffer.concat(stderr).toString();
            if (options.stdoutFile) {
                await (0, promises_1.writeFile)(options.stdoutFile, stdoutText);
            }
            if (code && !options.ignoreFailure) {
                reject(new OperationError(`${command} ${args.join(" ")} failed with exit code ${code}: ${stderrText}`));
            }
            else {
                resolvePromise({ code: code || 0, stdout: stdoutText, stderr: stderrText });
            }
        });
    });
}
async function pipeCommands(from, to) {
    await new Promise((resolvePromise, reject) => {
        const first = (0, child_process_1.spawn)(from[0], from[1], { stdio: ["ignore", "pipe", "inherit"] });
        const second = (0, child_process_1.spawn)(to[0], to[1], { stdio: ["pipe", "inherit", "inherit"] });
        let firstCode = null;
        let secondCode = null;
        first.on("error", reject);
        second.on("error", reject);
        first.stdout.pipe(second.stdin);
        const maybeDone = () => {
            if (firstCode == null || secondCode == null) {
                return;
            }
            if (firstCode !== 0) {
                reject(new OperationError(`${from[0]} ${from[1].join(" ")} failed with exit code ${firstCode}`));
            }
            else if (secondCode !== 0) {
                reject(new OperationError(`${to[0]} ${to[1].join(" ")} failed with exit code ${secondCode}`));
            }
            else {
                resolvePromise();
            }
        };
        first.on("close", (code) => {
            firstCode = code ?? 0;
            maybeDone();
        });
        second.on("close", (code) => {
            secondCode = code ?? 0;
            maybeDone();
        });
    });
}
function messageFrom(error) {
    return error instanceof Error ? error.message : String(error);
}
void main();
