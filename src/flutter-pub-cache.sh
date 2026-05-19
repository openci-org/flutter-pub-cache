#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <restore|save>" >&2
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi

action="$1"

case "$action" in
  restore|save) ;;
  *)
    usage
    exit 2
    ;;
esac

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

write_output() {
  local name="$1"
  local value="$2"

  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$name" "$value" >> "$GITHUB_OUTPUT"
  fi
}

expand_path() {
  local path="$1"

  case "$path" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${path#"~/"}" ;;
    *) printf '%s\n' "$path" ;;
  esac
}

absolute_path() {
  local path="$1"
  local base="$2"

  path="$(expand_path "$path")"
  case "$path" in
    /*) printf '%s\n' "$path" ;;
    *) printf '%s/%s\n' "$base" "$path" ;;
  esac
}

sanitize_component() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
}

work_dir="$(absolute_path "${INPUT_WORKING_DIRECTORY:-.}" "${GITHUB_WORKSPACE:-$PWD}")"
cache_dir="$(expand_path "${INPUT_CACHE_PATH:-${PUB_CACHE:-${HOME}/.pub-cache}}")"
service_account="${INPUT_SERVICE_ACCOUNT:-${FIREBASE_SERVICE_ACCOUNT:-}}"

storage_bucket() {
  local configured_bucket="${INPUT_STORAGE_BUCKET:-}"
  local firebase_options_path

  if [ -n "$configured_bucket" ]; then
    printf '%s\n' "$configured_bucket"
    return 0
  fi

  firebase_options_path="$(absolute_path "${INPUT_FIREBASE_OPTIONS_PATH:-lib/firebase_options.dart}" "$work_dir")"
  if [ ! -f "$firebase_options_path" ]; then
    return 0
  fi

  python3 - "$firebase_options_path" <<'PY'
import re
import sys

path = sys.argv[1]
with open(path, encoding="utf-8", errors="replace") as f:
    text = f.read()

patterns = [
    r"storageBucket\s*:\s*['\"]([^'\"]+)['\"]",
    r"['\"]storageBucket['\"]\s*:\s*['\"]([^'\"]+)['\"]",
]

for pattern in patterns:
    match = re.search(pattern, text)
    if match:
        print(match.group(1))
        break
PY
}

urlencode() {
  python3 - "$1" <<'PY'
import sys
import urllib.parse

print(urllib.parse.quote(sys.argv[1], safe=""))
PY
}

json_object_metadata() {
  python3 - "$1" "$2" <<'PY'
import json
import sys

print(json.dumps({"name": sys.argv[1], "contentType": sys.argv[2]}, separators=(",", ":")))
PY
}

file_size() {
  python3 - "$1" <<'PY'
import os
import sys

print(os.path.getsize(sys.argv[1]))
PY
}

sha256_digest() {
  python3 - "$1" <<'PY'
import hashlib
import sys

digest = hashlib.sha256()
with open(sys.argv[1], "rb") as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b""):
        digest.update(chunk)
print(digest.hexdigest())
PY
}

compression_extension() {
  if command -v zstd >/dev/null 2>&1; then
    echo "tar.zst"
  else
    echo "tar.gz"
  fi
}

compression_content_type() {
  if command -v zstd >/dev/null 2>&1; then
    echo "application/zstd"
  else
    echo "application/gzip"
  fi
}

create_archive() {
  local archive_path="$1"
  local cache_parent
  local cache_name

  cache_parent="$(dirname "$cache_dir")"
  cache_name="$(basename "$cache_dir")"

  if command -v zstd >/dev/null 2>&1; then
    tar -cf - \
      --exclude "${cache_name}/_temp" \
      --exclude "${cache_name}/log" \
      -C "$cache_parent" "$cache_name" \
      | zstd -T0 -1 -q -o "$archive_path"
  else
    tar -czf "$archive_path" \
      --exclude "${cache_name}/_temp" \
      --exclude "${cache_name}/log" \
      -C "$cache_parent" "$cache_name"
  fi
}

extract_archive() {
  local archive_path="$1"

  rm -rf "$cache_dir"
  mkdir -p "$(dirname "$cache_dir")"
  if [ "${archive_path##*.}" = "zst" ]; then
    zstd -dc "$archive_path" | tar -xf - -C "$(dirname "$cache_dir")"
  else
    tar -xzf "$archive_path" -C "$(dirname "$cache_dir")"
  fi
}

access_token() {
  local service_account_file="$tmp_dir/firebase-service-account.json"
  local private_key_file="$tmp_dir/private-key.pem"
  local signing_input_file="$tmp_dir/signing-input.txt"
  local client_email
  local jwt_header
  local jwt_payload
  local jwt_signature
  local jwt_assertion

  printf '%s' "$service_account" > "$service_account_file"
  client_email="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["client_email"])' "$service_account_file")"
  python3 -c 'import json, sys; open(sys.argv[2], "w").write(json.load(open(sys.argv[1]))["private_key"])' "$service_account_file" "$private_key_file"

  jwt_header="$(python3 -c 'import base64, json; print(base64.urlsafe_b64encode(json.dumps({"alg":"RS256","typ":"JWT"}, separators=(",", ":")).encode()).decode().rstrip("="))')"
  jwt_payload="$(python3 - "$client_email" <<'PY'
import base64
import json
import sys
import time

now = int(time.time())
payload = {
    "iss": sys.argv[1],
    "scope": "https://www.googleapis.com/auth/devstorage.read_write",
    "aud": "https://oauth2.googleapis.com/token",
    "iat": now,
    "exp": now + 3600,
}
print(base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("="))
PY
  )"
  printf '%s.%s' "$jwt_header" "$jwt_payload" > "$signing_input_file"
  jwt_signature="$(openssl dgst -sha256 -sign "$private_key_file" "$signing_input_file" | python3 -c 'import base64, sys; print(base64.urlsafe_b64encode(sys.stdin.buffer.read()).decode().rstrip("="))')"
  jwt_assertion="${jwt_header}.${jwt_payload}.${jwt_signature}"

  curl -fsS -X POST "https://oauth2.googleapis.com/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer" \
    --data-urlencode "assertion=${jwt_assertion}" \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["access_token"])'
}

dependency_hash() {
  local patterns_file="$tmp_dir/dependency-paths.txt"
  local dependency_paths="${INPUT_DEPENDENCY_PATHS:-}"

  printf '%s\n' "$dependency_paths" > "$patterns_file"

  python3 - "$work_dir" "$patterns_file" <<'PY'
import glob
import hashlib
import os
import sys

work_dir = os.path.abspath(sys.argv[1])
patterns_file = sys.argv[2]

with open(patterns_file, encoding="utf-8") as f:
    patterns = [line.strip() for line in f if line.strip() and not line.lstrip().startswith("#")]

ignored_dirs = {
    ".dart_tool",
    ".firebase",
    ".fvm",
    ".git",
    ".pub-cache",
    ".swiftpm",
    "build",
    "node_modules",
}

files = []
seen = set()

def is_ignored(path):
    rel = os.path.relpath(path, work_dir)
    if rel == ".":
        return False
    return any(part in ignored_dirs for part in rel.split(os.sep))

def add_file(path):
    path = os.path.abspath(path)
    if os.path.isfile(path) and not is_ignored(path) and path not in seen:
        seen.add(path)
        files.append(path)

if patterns:
    for pattern in patterns:
        path_pattern = pattern if os.path.isabs(pattern) else os.path.join(work_dir, pattern)
        if any(ch in pattern for ch in "*?["):
            matches = sorted(glob.glob(path_pattern, recursive=True))
            for match in matches:
                add_file(match)
        else:
            add_file(path_pattern)
else:
    for root, dirs, names in os.walk(work_dir):
        dirs[:] = sorted(d for d in dirs if d not in ignored_dirs)
        for name in ("pubspec.yaml", "pubspec.lock"):
            if name in names:
                add_file(os.path.join(root, name))

digest = hashlib.sha256()
for path in files:
    display = os.path.relpath(path, work_dir)
    digest.update(display.encode())
    digest.update(b"\n")
    with open(path, "rb") as f:
        file_digest = hashlib.sha256()
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            file_digest.update(chunk)
    digest.update(file_digest.hexdigest().encode())
    digest.update(b"  ")
    digest.update(display.encode())
    digest.update(b"\n")

print(digest.hexdigest()[:20])
PY
}

flutter_cache_key_component() {
  local version_file="$tmp_dir/flutter-version.json"
  if command -v flutter >/dev/null 2>&1 && flutter --version --machine > "$version_file" 2>/dev/null; then
    python3 - "$version_file" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    data = json.load(f)
value = "-".join(
    part
    for part in [
        data.get("frameworkVersion"),
        (data.get("frameworkRevision") or "")[:12],
        data.get("dartSdkVersion"),
    ]
    if part
)
print(re.sub(r"[^a-zA-Z0-9._-]+", "-", value or "unknown-flutter").strip("-").lower())
PY
  else
    echo "unknown-flutter"
  fi
}

host_cache_key_component() {
  sanitize_component "$(uname -s)-$(uname -m)"
}

cache_object_name() {
  local repo
  local host_component
  local flutter_component
  local deps_component
  local archive_extension
  local key_prefix

  repo="${INPUT_REPOSITORY:-${GITHUB_REPOSITORY:-unknown-repository}}"
  host_component="$(host_cache_key_component)"
  flutter_component="$(flutter_cache_key_component)"
  deps_component="$(dependency_hash)"
  archive_extension="$(compression_extension)"
  key_prefix="${INPUT_KEY_PREFIX:-caches/flutter-pub}"

  printf '%s/%s/%s/%s/deps-%s.%s' \
    "${key_prefix%/}" \
    "$repo" \
    "$host_component" \
    "$flutter_component" \
    "$deps_component" \
    "$archive_extension"
}

object_exists() {
  local bucket="$1"
  local token="$2"
  local object_name="$3"
  local encoded_object_name
  local response_path="$tmp_dir/object-metadata.json"
  local http_code

  encoded_object_name="$(urlencode "$object_name")"
  if ! http_code="$(curl -sS -w '%{http_code}' -o "$response_path" \
    -H "Authorization: Bearer ${token}" \
    "https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encoded_object_name}?fields=name,size,updated")"; then
    echo "Failed to inspect Flutter pub cache object" >&2
    sed -n '1,80p' "$response_path" >&2 || true
    return 2
  fi

  if [ "$http_code" = "404" ]; then
    return 1
  fi

  case "$http_code" in
    ''|*[!0-9]*)
      echo "Failed to inspect Flutter pub cache object (HTTP ${http_code:-unknown})" >&2
      sed -n '1,80p' "$response_path" >&2 || true
      return 2
      ;;
  esac

  if [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
    echo "Failed to inspect Flutter pub cache object (HTTP ${http_code})" >&2
    sed -n '1,80p' "$response_path" >&2 || true
    return 2
  fi

  return 0
}

restore_cache() {
  local bucket="$1"
  local token="$2"
  local object_name="$3"
  local encoded_object_name
  local archive_path
  local http_code

  archive_path="$tmp_dir/flutter-pub-cache.$(compression_extension)"
  encoded_object_name="$(urlencode "$object_name")"
  echo "Restoring Flutter pub cache from gs://${bucket}/${object_name}"

  if ! http_code="$(curl -sS -L -w '%{http_code}' -o "$archive_path" \
    -H "Authorization: Bearer ${token}" \
    "https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encoded_object_name}?alt=media")"; then
    echo "Failed to download Flutter pub cache" >&2
    return 1
  fi

  if [ "$http_code" = "404" ]; then
    echo "Flutter pub cache miss"
    write_output "cache-hit" "false"
    return 0
  fi

  if [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
    echo "Failed to download Flutter pub cache (HTTP ${http_code})" >&2
    sed -n '1,80p' "$archive_path" >&2 || true
    return 1
  fi

  echo "Downloaded Flutter pub cache archive:"
  du -sh "$archive_path"

  extract_archive "$archive_path"

  echo "Restored Flutter pub cache:"
  du -sh "$cache_dir"
  find "$cache_dir" -type f | wc -l | awk '{ print "File count: " $1 }'
  write_output "cache-hit" "true"
}

save_cache() {
  local bucket="$1"
  local token="$2"
  local object_name="$3"
  local archive_path
  local archive_size
  local content_type
  local headers_file="$tmp_dir/upload-headers.txt"
  local upload_url
  local exists_status

  write_output "cache-saved" "false"

  if object_exists "$bucket" "$token" "$object_name"; then
    echo "Flutter pub cache already exists; skipping upload: gs://${bucket}/${object_name}"
    return 0
  else
    exists_status="$?"
    if [ "$exists_status" -ne 1 ]; then
      return 1
    fi
  fi

  archive_path="$tmp_dir/flutter-pub-cache.$(compression_extension)"
  if [ ! -d "$cache_dir" ]; then
    echo "Flutter pub cache not found; nothing to save: $cache_dir"
    return 0
  fi

  echo "Creating Flutter pub cache archive:"
  du -sh "$cache_dir"
  create_archive "$archive_path"
  du -sh "$archive_path"
  archive_size="$(file_size "$archive_path")"
  content_type="$(compression_content_type)"

  echo "Uploading Flutter pub cache to gs://${bucket}/${object_name}"
  curl -fsS -X POST \
    -D "$headers_file" \
    -o /dev/null \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json; charset=UTF-8" \
    -H "X-Upload-Content-Type: ${content_type}" \
    -H "X-Upload-Content-Length: ${archive_size}" \
    --data "$(json_object_metadata "$object_name" "$content_type")" \
    "https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=resumable"

  upload_url="$(python3 - "$headers_file" <<'PY'
import sys

with open(sys.argv[1], encoding="utf-8", errors="replace") as f:
    for line in f:
        if line.lower().startswith("location:"):
            print(line.split(":", 1)[1].strip())
PY
  )"

  if [ -z "$upload_url" ]; then
    echo "Could not read resumable upload URL" >&2
    sed -n '1,80p' "$headers_file" >&2 || true
    return 1
  fi

  curl -fsS -X PUT \
    -H "Content-Type: ${content_type}" \
    --data-binary "@${archive_path}" \
    "$upload_url" \
    > /dev/null

  echo "Uploaded Flutter pub cache"
  write_output "cache-saved" "true"
}

write_output "cache-hit" "false"
write_output "cache-saved" "false"

object_name="$(cache_object_name)"
write_output "object-name" "$object_name"

if [ -z "$service_account" ]; then
  echo "service-account is not set; skipping remote Flutter pub cache ${action}"
  exit 0
fi

bucket="$(storage_bucket)"
if [ -z "$bucket" ]; then
  echo "storage-bucket is not set and storageBucket could not be read from ${INPUT_FIREBASE_OPTIONS_PATH:-lib/firebase_options.dart}" >&2
  exit 2
fi

token="$(access_token)"

case "$action" in
  restore)
    restore_cache "$bucket" "$token" "$object_name"
    ;;
  save)
    save_cache "$bucket" "$token" "$object_name"
    ;;
esac
