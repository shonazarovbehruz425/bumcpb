# Implementation Plan: flow-mcp-run-setup

## Overview

Quick Plan. Make the MCP server run-ready on Windows by introducing one cross-platform path helper (`src/utils/paths.js`), wiring the browser layer to it, adding a Node setup script that pre-fills `config/flow.config.json`, providing native Windows scripts, and fixing `package.json` plus README docs. Language: JavaScript (Node.js, ES modules). Each task builds on the previous and ends with wiring everything together.

## Tasks

- [x] 1. Create cross-platform path helper `src/utils/paths.js`
  - [x] 1.1 Implement path resolution functions
    - Create `src/utils/paths.js` (ES module) importing `os`, `path`, `fs`, and `FlowError`/`ErrorCodes` from `../utils/errors.js`
    - Implement `getHomeDir()` returning `os.homedir()` with `USERPROFILE`/`HOME` fallback
    - Implement `windowsChromeCandidates()` returning standard Chrome install locations (ProgramFiles, ProgramFiles(x86), LocalAppData) in priority order
    - Implement `resolveChromePath(chromePathFromConfig)`: return config value if it points to an existing file; else first existing candidate; else throw `FlowError(CONFIG_ERROR)` with an actionable "Chrome executable not found" message
    - Implement `resolveProfileSource(userDataDir, profile)` as `path.join(userDataDir, profile)`
    - Implement `makeTempProfileDir()` returning a unique path under `os.tmpdir()`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ]* 1.2 Write property test for Chrome path resolution precedence
    - **Property 1: Chrome path resolution precedence** (stub `fs.existsSync` for candidate/config existence)
    - **Validates: Requirements 1.1, 1.2**

  - [ ]* 1.3 Write property test for unresolvable Chrome path error
    - **Property 2: Unresolvable Chrome path raises an error** (stub existence checks to always fail)
    - **Validates: Requirements 1.3**

  - [ ]* 1.4 Write property test for profile source composition
    - **Property 3: Profile source composition**
    - **Validates: Requirements 1.4**

  - [ ]* 1.5 Write property test for temp profile directory location
    - **Property 4: Temp profile directory location** (assert under `os.tmpdir()` and distinct across calls)
    - **Validates: Requirements 1.5**

- [x] 2. Wire browser layer to the path helper
  - [x] 2.1 Update `src/browser/launch-profile.js`
    - Remove the hardcoded `const CHROME_PATH = '/opt/google/chrome/chrome'`
    - Import `resolveChromePath`, `resolveProfileSource` from `../utils/paths.js` and `get` from `../utils/config.js`
    - Resolve `chromePath` via `resolveChromePath(get('chromePath'))`, `userDataDir` via `get('chromeUserDataDir')`, `profileName` via `get('chromeProfile', 'Profile 3')`, and `profileSource` via `resolveProfileSource(...)`
    - Pass resolved `chromePath` into `launchChromeDirect({ chromePath, ... })`; remove any `process.env.HOME` usage
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 2.2 Update `src/browser/connect.js`
    - Replace both `'/opt/google/chrome/chrome'` defaults with `resolveChromePath(options.chromePath || get('chromePath'))`
    - Replace `path.resolve(process.env.HOME, '.config/google-chrome/Profile 3')` with `resolveProfileSource(get('chromeUserDataDir'), get('chromeProfile', 'Profile 3'))`
    - Replace the `/tmp/chrome-kiara-cdp-${Date.now()}` literal with `makeTempProfileDir()`
    - Use the configured profile name for `--profile-directory` and the `fs.cpSync` target instead of the literal `'Profile 3'`
    - _Requirements: 1.1, 1.2, 1.4, 1.5_

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement the Setup_Process `scripts/setup.mjs`
  - [x] 4.1 Implement config generation and detection logic
    - Create `scripts/setup.mjs` resolving project root from `import.meta.url`
    - Determine `configPath` (`config/flow.config.json`) and `examplePath` (`config/flow.config.example.json`)
    - If `configPath` exists: load it and set `preserveExisting = true` (do not overwrite); else load the example as the base object
    - `detectUserDataDir()`: `%LOCALAPPDATA%\Google\Chrome\User Data`
    - `detectChromePath()`: reuse the Chrome candidate scan (via `resolveChromePath`/candidates) with detection failures logged as non-fatal warnings
    - `enumerateProfiles(userDataDir)`: read directories matching `Default` or `/^Profile \d+$/`
    - When not preserving: write `chromeUserDataDir`, `chromePath`, first enumerated `chromeProfile` (if any), and `expectedAccount` placeholder, then write pretty JSON to `configPath`
    - When preserving: leave file untouched and print current values
    - Print final one-step setup instructions
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 5.1_

  - [ ]* 4.2 Write property test for selected profile membership
    - **Property 5: Selected profile is an available profile** (stub directory enumeration)
    - **Validates: Requirements 2.4**

  - [ ]* 4.3 Write property test for existing config preservation
    - **Property 6: Existing config preservation (idempotence)** (stub filesystem read/write)
    - **Validates: Requirements 2.6**

  - [ ]* 4.4 Write smoke tests for setup output
    - Fresh-workspace config creation (2.1), detected-value writes (2.2, 2.3), placeholder account (2.5)
    - _Requirements: 2.1, 2.2, 2.3, 2.5_

- [x] 5. Create native Windows scripts
  - [x] 5.1 Create `scripts/start-browser.cmd`
    - Launch Chrome with `--user-data-dir`, `--profile-directory`, `--remote-debugging-port=9222`, `--no-first-run`, `--no-default-browser-check`, `--disable-blink-features=AutomationControlled`
    - Mirror `start-browser.sh` behavior using `%LOCALAPPDATA%` and the detected Chrome path
    - _Requirements: 3.1_

  - [x] 5.2 Create `scripts/start-mcp.cmd`
    - `cd` to project root and run `node src\index.js`
    - _Requirements: 3.2_

  - [x] 5.3 Create `scripts/test.cmd`
    - Run `node scripts\test-e2e.mjs`
    - _Requirements: 3.3_

- [x] 6. Fix `package.json` scripts
  - [x] 6.1 Update the scripts block
    - Add `"setup": "node scripts/setup.mjs"`
    - Fix `"test"` to `"node scripts/test-e2e.mjs"` (replacing the invalid `.sh` entry)
    - Keep `"start": "node src/index.js"`
    - _Requirements: 3.4_

- [x] 7. Update `README.md` documentation
  - [x] 7.1 Add run and client documentation
    - Document the generic command `node path\to\src\index.js` for launching the server
    - Add the copy-paste Claude Desktop MCP client snippet referencing `src\index.js`
    - Document the one-step final sequence: `npm install` → `npm run setup` → edit `expectedAccount` → `npm start`
    - Confirm `scripts/register-opencode.sh` remains referenced/unchanged
    - _Requirements: 4.1, 4.2, 4.3, 5.1, 5.2_

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP.
- Each task references specific requirements for traceability.
- Property tests validate the universal correctness properties (Properties 1–6) from the design; filesystem existence checks and directory enumeration are stubbed so logic is tested in isolation.
- `scripts/test-e2e.mjs` is the end-to-end check (Req 5.2); run it manually since it launches Chrome.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "5.1", "5.2", "5.3", "6.1", "7.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5", "2.1", "2.2", "4.1"] },
    { "id": 2, "tasks": ["4.2", "4.3", "4.4"] }
  ]
}
```
