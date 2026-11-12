# Changelog

Notable changes to `@rescor-llc/aw2ms365`. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security
- `aw2ms365 init` now writes `~/.aw2ms365/config.yaml` with owner-only permissions (`0600`), in both interactive and `--non-interactive` modes. The file holds the WorkMail password and the MS365 client secret. Config files created by 0.2.0 or earlier keep their old permissions; run `chmod 600 ~/.aw2ms365/config.yaml` to tighten one.
- README troubleshooting examples no longer put passwords on the command line.

### Changed
- Releases are published to GitHub Packages only. npmjs.org has versions up to 0.2.0 and gets no new ones. The recommended install is now `npm install -g github:RESCOR-LLC/aw2ms365.rescor.net`.
- CI: added Gitleaks and Kingfisher secret scanning, and merged jobs to reduce CI runs.

### Documentation
- Added Microsoft IMAP migration workarounds (2 GB limit, transient failures) to the migration guide.
- Documented the `imap` → `semver` advisory under Known Issues.
- Corrected the install command in the migration guide.

## [0.2.0] - 2026-04-08

### Security
- Fixed XML injection in EWS requests.
- Added a SAST pipeline (CodeQL, `npm audit`) and 34 unit tests.

### Documentation
- Expanded troubleshooting and lessons learned from live migrations.

## [0.1.1] – [0.1.10] - 2026-04-07

Initial releases.
- IMAP UID-based fetch from WorkMail, EWS `MimeContent` import to MS365, with folder preservation, checkpoints, retry with backoff, and rate limiting.
- Duplicate detection, refined across 0.1.7–0.1.10: Message-ID matching was replaced by subject and sent-date matching, with MIME header decoding and a date window.

[Unreleased]: https://github.com/RESCOR-LLC/aw2ms365.rescor.net/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/RESCOR-LLC/aw2ms365.rescor.net/compare/v0.1.10...v0.2.0
