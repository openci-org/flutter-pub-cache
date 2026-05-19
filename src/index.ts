import { createHash, createSign } from "crypto";
import { createReadStream, existsSync } from "fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { Readable } from "stream";
import { spawn } from "child_process";

type Action = "restore" | "save";

class UsageError extends Error {}
class OperationError extends Error {}

type Inputs = {
  action: Action;
  serviceAccount: string;
  storageBucket: string;
  firebaseOptionsPath: string;
  cachePath: string;
  keyPrefix: string;
  dependencyPaths: string;
  workingDirectory: string;
  repository: string;
  failOnError: boolean;
};

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

async function main(): Promise<void> {
  let tmpDir = "";
  let inputs: Inputs | undefined;
  try {
    inputs = readInputs();
    tmpDir = await mkdtemp(join(tmpdir(), "flutter-pub-cache-"));

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
      throw new UsageError(
        `storage-bucket is not set and storageBucket could not be read from ${inputs.firebaseOptionsPath}`,
      );
    }

    const token = await accessToken(inputs.serviceAccount);
    if (inputs.action === "restore") {
      await restoreCache({ bucket, token, objectName, cacheDir: inputs.cachePath, tmpDir });
    } else {
      await saveCache({ bucket, token, objectName, cacheDir: inputs.cachePath, tmpDir });
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 2;
    } else if (inputs) {
      await handleError(error, inputs);
    } else {
      console.error(messageFrom(error));
      process.exitCode = 1;
    }
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}

function readInputs(): Inputs {
  const actionInput = getInput("action", { required: true });
  if (actionInput !== "restore" && actionInput !== "save") {
    throw new UsageError("Usage: flutter-pub-cache <restore|save>");
  }

  const workingDirectory = absolutePath(
    getInput("working-directory") || ".",
    process.env.GITHUB_WORKSPACE || process.cwd(),
  );

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

function getInput(name: string, options: { required?: boolean } = {}): string {
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

function setOutput(name: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  require("fs").appendFileSync(outputPath, `${name}=${value}\n`);
}

function warning(message: string): void {
  console.log(`::warning::${message.replace(/\r?\n/g, "%0A")}`);
}

async function handleError(error: unknown, inputs: Inputs): Promise<void> {
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

function parseBoolean(value: string): boolean {
  return /^(1|true|yes)$/i.test(value);
}

function expandPath(path: string): string {
  if (path === "~") {
    return process.env.HOME || path;
  }
  if (path.startsWith("~/")) {
    return join(process.env.HOME || "", path.slice(2));
  }
  return path;
}

function absolutePath(path: string, base: string): string {
  const expanded = expandPath(path);
  return isAbsolute(expanded) ? expanded : join(base, expanded);
}

async function storageBucket(inputs: Inputs): Promise<string> {
  if (inputs.storageBucket) {
    return inputs.storageBucket;
  }

  const optionsPath = absolutePath(inputs.firebaseOptionsPath, inputs.workingDirectory);
  if (!existsSync(optionsPath)) {
    return "";
  }

  const text = await readFile(optionsPath, "utf8");
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

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

async function accessToken(serviceAccountJson: string): Promise<string> {
  let serviceAccount: { client_email?: string; private_key?: string };
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch (error) {
    throw new OperationError(`Could not parse service account JSON: ${messageFrom(error)}`);
  }

  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new OperationError("Service account JSON must contain client_email and private_key");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/devstorage.read_write",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(serviceAccount.private_key);
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

  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new OperationError("Google token response did not contain access_token");
  }
  return data.access_token;
}

async function cacheObjectName(inputs: Inputs, tmpDir: string): Promise<string> {
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

async function hostCacheKeyComponent(): Promise<string> {
  const os = await run("uname", ["-s"], { ignoreFailure: true });
  const arch = await run("uname", ["-m"], { ignoreFailure: true });
  if (os.code === 0 && arch.code === 0) {
    return sanitizeComponent(`${os.stdout.trim()}-${arch.stdout.trim()}`);
  }
  return sanitizeComponent(`${process.platform}-${process.arch}`);
}

function sanitizeComponent(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

async function flutterCacheKeyComponent(tmpDir: string): Promise<string> {
  const versionFile = join(tmpDir, "flutter-version.json");
  const result = await run("flutter", ["--version", "--machine"], { stdoutFile: versionFile, ignoreFailure: true });
  if (result.code !== 0) {
    return "unknown-flutter";
  }

  try {
    const data = JSON.parse(await readFile(versionFile, "utf8")) as {
      frameworkVersion?: string;
      frameworkRevision?: string;
      dartSdkVersion?: string;
    };
    const value = [
      data.frameworkVersion,
      data.frameworkRevision?.slice(0, 12),
      data.dartSdkVersion,
    ].filter(Boolean).join("-");
    return sanitizeComponent(value || "unknown-flutter");
  } catch {
    return "unknown-flutter";
  }
}

async function dependencyHash(inputs: Inputs): Promise<string> {
  const files = inputs.dependencyPaths
    ? await dependencyFilesFromPatterns(inputs.workingDirectory, inputs.dependencyPaths)
    : await autoDetectDependencyFiles(inputs.workingDirectory);

  const digest = createHash("sha256");
  for (const file of files) {
    const display = relative(inputs.workingDirectory, file);
    digest.update(display);
    digest.update("\n");
    digest.update(await sha256Digest(file));
    digest.update("  ");
    digest.update(display);
    digest.update("\n");
  }
  return digest.digest("hex").slice(0, 20);
}

async function dependencyFilesFromPatterns(workDir: string, patternsText: string): Promise<string[]> {
  const patterns = patternsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const files: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    const matches = hasGlob(pattern)
      ? await globFiles(workDir, pattern)
      : [isAbsolute(pattern) ? pattern : join(workDir, pattern)];
    for (const match of matches) {
      await addDependencyFile(files, seen, workDir, match);
    }
  }

  return files;
}

async function autoDetectDependencyFiles(workDir: string): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name));
    for (const name of ["pubspec.yaml", "pubspec.lock"]) {
      if (names.has(name)) {
        await addDependencyFile(files, seen, workDir, join(dir, name));
      }
    }

    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!ignoredDependencyDirs.has(entry.name)) {
        await visit(join(dir, entry.name));
      }
    }
  }

  await visit(workDir);
  return files;
}

async function globFiles(workDir: string, pattern: string): Promise<string[]> {
  const matches: string[] = [];
  const absolutePattern = isAbsolute(pattern) ? pattern : join(workDir, pattern);
  const root = globRoot(absolutePattern);
  const matcher = globMatcher(absolutePattern);

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDependencyDirs.has(entry.name)) {
          await visit(path);
        }
      } else if (matcher(path)) {
        matches.push(path);
      }
    }
  }

  await visit(root);
  return matches.sort();
}

function globRoot(pattern: string): string {
  const parts = pattern.split(sep);
  const rootParts: string[] = [];
  for (const part of parts) {
    if (/[?*[]/.test(part)) {
      break;
    }
    rootParts.push(part);
  }
  const root = rootParts.join(sep) || sep;
  return existsSync(root) ? root : dirname(root);
}

function globMatcher(pattern: string): (path: string) => boolean {
  const normalizedPattern = pattern.split(sep).join("/");
  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\0/g, ".*");
  const regex = new RegExp(`^${escaped}$`);
  return (path) => regex.test(path.split(sep).join("/"));
}

function hasGlob(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

async function addDependencyFile(files: string[], seen: Set<string>, workDir: string, path: string): Promise<void> {
  const absolute = resolve(path);
  if (seen.has(absolute) || isIgnoredDependencyPath(workDir, absolute)) {
    return;
  }
  const info = await stat(absolute).catch(() => null);
  if (info?.isFile()) {
    seen.add(absolute);
    files.push(absolute);
  }
}

function isIgnoredDependencyPath(workDir: string, path: string): boolean {
  const rel = relative(workDir, path);
  if (!rel || rel.startsWith("..")) {
    return false;
  }
  return rel.split(sep).some((part) => ignoredDependencyDirs.has(part));
}

async function sha256Digest(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

async function compressionExtension(): Promise<"tar.zst" | "tar.gz"> {
  const result = await run("zstd", ["--version"], { ignoreFailure: true });
  return result.code === 0 ? "tar.zst" : "tar.gz";
}

async function compressionContentType(): Promise<"application/zstd" | "application/gzip"> {
  return (await compressionExtension()) === "tar.zst" ? "application/zstd" : "application/gzip";
}

async function createArchive(cacheDir: string, archivePath: string): Promise<void> {
  const parent = dirname(cacheDir);
  const name = basename(cacheDir);

  if ((await compressionExtension()) === "tar.zst") {
    await pipeCommands(
      ["tar", ["-cf", "-", "--exclude", `${name}/_temp`, "--exclude", `${name}/log`, "-C", parent, name]],
      ["zstd", ["-T0", "-1", "-q", "-o", archivePath]],
    );
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

async function extractArchive(cacheDir: string, archivePath: string): Promise<void> {
  const parent = dirname(cacheDir);
  await rm(cacheDir, { recursive: true, force: true });
  await mkdir(parent, { recursive: true });

  if (archivePath.endsWith(".zst")) {
    await pipeCommands(["zstd", ["-dc", archivePath]], ["tar", ["-xf", "-", "-C", parent]]);
    return;
  }

  await run("tar", ["-xzf", archivePath, "-C", parent]);
}

async function restoreCache(options: {
  bucket: string;
  token: string;
  objectName: string;
  cacheDir: string;
  tmpDir: string;
}): Promise<void> {
  const archivePath = join(options.tmpDir, `flutter-pub-cache.${await compressionExtension()}`);
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

  await writeFile(archivePath, Readable.fromWeb(response.body as unknown as import("stream/web").ReadableStream));
  console.log("Downloaded Flutter pub cache archive:");
  await du(archivePath);

  await extractArchive(options.cacheDir, archivePath);

  console.log("Restored Flutter pub cache:");
  await du(options.cacheDir);
  console.log(`File count: ${await countFiles(options.cacheDir)}`);
  setOutput("cache-hit", "true");
}

async function saveCache(options: {
  bucket: string;
  token: string;
  objectName: string;
  cacheDir: string;
  tmpDir: string;
}): Promise<void> {
  setOutput("cache-saved", "false");
  if (await objectExists(options.bucket, options.token, options.objectName)) {
    console.log(`Flutter pub cache already exists; skipping upload: gs://${options.bucket}/${options.objectName}`);
    return;
  }

  if (!existsSync(options.cacheDir)) {
    console.log(`Flutter pub cache not found; nothing to save: ${options.cacheDir}`);
    return;
  }

  const archivePath = join(options.tmpDir, `flutter-pub-cache.${await compressionExtension()}`);
  console.log("Creating Flutter pub cache archive:");
  await du(options.cacheDir);
  await createArchive(options.cacheDir, archivePath);
  await du(archivePath);

  const size = (await stat(archivePath)).size;
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

async function objectExists(bucket: string, token: string, objectName: string): Promise<boolean> {
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

async function createUploadSession(options: {
  bucket: string;
  token: string;
  objectName: string;
  contentType: string;
  size: number;
}): Promise<string> {
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

async function uploadFile(uploadUrl: string, archivePath: string, contentType: string): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: createReadStream(archivePath) as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  if (!response.ok) {
    throw new OperationError(`Failed to upload Flutter pub cache (HTTP ${response.status}): ${await bodySnippet(response)}`);
  }
}

async function bodySnippet(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 1000);
}

async function du(path: string): Promise<void> {
  const result = await run("du", ["-sh", path], { ignoreFailure: true });
  if (result.stdout.trim()) {
    console.log(result.stdout.trim());
  }
}

async function countFiles(path: string): Promise<number> {
  let count = 0;
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  }
  await visit(path);
  return count;
}

async function run(command: string, args: string[], options: {
  stdoutFile?: string;
  ignoreFailure?: boolean;
} = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      if (options.ignoreFailure) {
        resolvePromise({ code: 127, stdout: "", stderr: messageFrom(error) });
      } else {
        reject(error);
      }
    });
    child.on("close", async (code) => {
      const stdoutText = Buffer.concat(stdout).toString();
      const stderrText = Buffer.concat(stderr).toString();
      if (options.stdoutFile) {
        await writeFile(options.stdoutFile, stdoutText);
      }
      if (code && !options.ignoreFailure) {
        reject(new OperationError(`${command} ${args.join(" ")} failed with exit code ${code}: ${stderrText}`));
      } else {
        resolvePromise({ code: code || 0, stdout: stdoutText, stderr: stderrText });
      }
    });
  });
}

async function pipeCommands(from: [string, string[]], to: [string, string[]]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const first = spawn(from[0], from[1], { stdio: ["ignore", "pipe", "inherit"] });
    const second = spawn(to[0], to[1], { stdio: ["pipe", "inherit", "inherit"] });
    let firstCode: number | null = null;
    let secondCode: number | null = null;

    first.on("error", reject);
    second.on("error", reject);
    first.stdout.pipe(second.stdin);

    const maybeDone = () => {
      if (firstCode == null || secondCode == null) {
        return;
      }
      if (firstCode !== 0) {
        reject(new OperationError(`${from[0]} ${from[1].join(" ")} failed with exit code ${firstCode}`));
      } else if (secondCode !== 0) {
        reject(new OperationError(`${to[0]} ${to[1].join(" ")} failed with exit code ${secondCode}`));
      } else {
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

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main();
