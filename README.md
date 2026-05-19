# Flutter Pub Cache

GitHub Action for restoring and saving Flutter pub cache archives in Firebase Storage or Google Cloud Storage.

This action is useful when GitHub Actions cache storage is not a good fit, for example when cache size, retention, or cross-runner behavior needs to be controlled by your own storage bucket.

## Usage

```yaml
- name: Restore Flutter pub cache
  uses: openci-org/flutter-pub-cache@v1
  continue-on-error: true
  with:
    action: restore
    service-account: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
    firebase-options-path: apps/dashboard/lib/firebase_options.dart
    namespace: apps-dashboard

- run: flutter pub get
  working-directory: apps/dashboard

- name: Save Flutter pub cache
  if: always()
  uses: openci-org/flutter-pub-cache@v1
  continue-on-error: true
  with:
    action: save
    service-account: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
    firebase-options-path: apps/dashboard/lib/firebase_options.dart
    namespace: apps-dashboard
```

You can pass `storage-bucket` directly instead of reading it from a Firebase options file.

```yaml
with:
  action: restore
  service-account: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
  storage-bucket: my-project.appspot.com
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `action` | required | `restore` or `save`. |
| `service-account` | empty | Google service account JSON. Falls back to `FIREBASE_SERVICE_ACCOUNT`. |
| `storage-bucket` | empty | Bucket name. If omitted, `storageBucket` is read from `firebase-options-path`. |
| `firebase-options-path` | `lib/firebase_options.dart` | Firebase options file containing `storageBucket`. |
| `cache-path` | `~/.pub-cache` | Pub cache directory to archive. |
| `key-prefix` | `caches/flutter-pub` | Storage object prefix. |
| `namespace` | `default` | Extra cache namespace for monorepos or multiple apps. |
| `dependency-paths` | pubspec files | Newline-delimited file or glob patterns used to compute the dependency hash. |
| `working-directory` | `.` | Base directory for dependency paths and `firebase-options-path`. |
| `repository` | current repository | Repository component used in the storage object name. |

## Outputs

| Output | Description |
| --- | --- |
| `cache-hit` | `true` when restore downloaded an archive. |
| `cache-saved` | `true` when save uploaded a new archive. |
| `object-name` | Google Cloud Storage object name used for the archive. |

## Cache Key

The object name is built from:

- `key-prefix`
- repository
- `namespace`
- host OS and architecture
- Flutter and Dart SDK versions
- a dependency hash from `dependency-paths`
- archive extension, preferring zstd when available

Existing cache objects are immutable. `save` skips upload when the object already exists.

## Permissions

The service account needs permission to read and write objects in the selected bucket.
