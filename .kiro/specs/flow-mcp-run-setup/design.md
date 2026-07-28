# Design Document

## Overview

Quick Plan.

Make `google-flow-browser-mcp` run-ready on Windows by removing Linux-specific hardcoded values and adding a Node setup script plus native Windows scripts. The core idea: introduce one small cross-platform path-resolution helper, wire the browser code to it, and add a `scripts/setup.mjs` that pre-fills `config/flow.config.json` so the only remaining user action is entering their Google account email.

Language: JavaScript (Node.js, ES modules), consistent with the existing codebase.

## Architecture

```
scripts/setup.mjs ──generates──► config/flow.config.json  (from flow.config.example.json)
                     detects: chromePath, chromeUserDataDir, chromeProfile

src/utils/paths.js  (NEW helper)
   ├─ resolveChromePath(config)      ─┐
   ├─ resolveProfileSource(config)    ├─ used by browser layer
   ├─ getHomeDir()                    │
   └─ makeTempProfileDir()           ─┘
        ▲                    ▲
        │                    │
src/browser/launch-profile.js   src/browser/connect.js
        │                    │
        └────► Chrome (direct + CDP) ◄────┘

Native Windows entry points:
scripts/start-browser.cmd · scripts/start-mcp.cmd · scripts/test.cmd
package.json "test" ──► node scripts/test-e2e.mjs
```

## Components and Interfaces

### 1. `src/utils/paths.js` (new)

Central cross-platform path resolution. Keeps platform logic in one place so browser modules stay clean.

```javascript
import os from 'os';
import path from 'path';
import fs from 'fs';

// Cross-platform home directory (replaces process.env.HOME).
export function getHomeDir() {
  return os.homedir() || process.env.USERPROFILE || process.env.HOME;
}

// Standard Windows Chrome install locations, in priority order.
function windowsChromeCandidates() {
  const pf   = process.env['ProgramFiles']        || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)']   || 'C:\\Program Files (x86)';
  const lad  = process.env['LocalAppData']        || path.join(getHomeDir(), 'AppData', 'Local');
  return [
    path.join(pf,   'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(lad,  'Google\\Chrome\\Application\\chrome.exe'),
  ];
}

// Req 1.1/1.2/1.3: config value wins; else first existing candidate; else throw.
export function resolveChromePath(chromePathFromConfig) {
  if (chromePathFromConfig && fs.existsSync(chromePathFromConfig)) {
    return chromePathFromConfig;
  }
  const found = windowsChromeCandidates().find((p) => fs.existsSync(p));
  if (found) return found;
  throw new FlowError(ErrorCodes.CONFIG_ERROR,
    'Chrome executable not found. Set "chromePath" in config/flow.config.json.');
}

// Req 1.4: profile source = userDataDir / profile.
export function resolveProfileSource(userDataDir, profile) {
  return path.join(userDataDir, profile);
}

// Req 1.5: temp profile dir under os.tmpdir().
export function makeTempProfileDir() {
  return path.join(os.tmpdir(), `chrome-kiara-cdp-${Date.now()}`);
}
```

`FlowError`/`ErrorCodes` imported from `../utils/errors.js`.

### 2. `src/browser/launch-profile.js` (edit)

- Remove `const CHROME_PATH = '/opt/google/chrome/chrome'`.
- Resolve values from config + helper instead of `process.env.HOME`:

```javascript
import { get } from '../utils/config.js';
import { resolveChromePath, resolveProfileSource } from '../utils/paths.js';

const chromePath   = resolveChromePath(get('chromePath'));
const userDataDir  = get('chromeUserDataDir');
const profileName  = get('chromeProfile', 'Profile 3');
const profileSource = resolveProfileSource(userDataDir, profileName);
```

- Pass the resolved `chromePath` to `launchChromeDirect({ chromePath, ... })`.

### 3. `src/browser/connect.js` (edit)

- Replace both `'/opt/google/chrome/chrome'` defaults with `resolveChromePath(options.chromePath || get('chromePath'))`.
- Replace `path.resolve(process.env.HOME, '.config/google-chrome/Profile 3')` with `resolveProfileSource(get('chromeUserDataDir'), get('chromeProfile', 'Profile 3'))`.
- Replace `const tempDir = '/tmp/chrome-kiara-cdp-${Date.now()}'` with `const tempDir = makeTempProfileDir()`.
- Use the configured profile name for `--profile-directory` and the `fs.cpSync` target rather than the literal `'Profile 3'`.

### 4. `scripts/setup.mjs` (new — Setup_Process)

```javascript
// Pseudocode / control flow
1. Resolve project root from import.meta.url.
2. configPath = config/flow.config.json; examplePath = config/flow.config.example.json.
3. If configPath exists  -> load it, mark preserveExisting = true (Req 2.6: no overwrite).
   Else                  -> load example as base object.
4. detectUserDataDir():  os.homedir()\AppData\Local\Google\Chrome\User Data  (Req 2.2)
5. detectChromePath():   reuse resolveChromePath(undefined) candidate scan   (Req 2.3)
6. enumerateProfiles(userDataDir): read dirs matching "Default" | /^Profile \d+$/ (Req 2.4)
7. If NOT preserveExisting:
     config.chromeUserDataDir = detected user data dir
     config.chromePath        = detected chrome path
     config.chromeProfile     = first enumerated profile (if any)
     config.expectedAccount   = "<enter-your-google-email>"  (Req 2.5 placeholder)
     write configPath (pretty JSON)                          (Req 2.1)
   Else: leave file untouched, print current values.
8. Print final one-step instructions (Req 5.1).
```

Detection failures are non-fatal: the script writes what it can and prints a note telling the user which key to fill manually.

### 5. Native Windows scripts (new)

- `scripts/start-browser.cmd` — launches Chrome with `--user-data-dir`, `--profile-directory`, `--remote-debugging-port=9222`, `--no-first-run`, `--no-default-browser-check`, `--disable-blink-features=AutomationControlled`; mirrors `start-browser.sh` behavior using `%LOCALAPPDATA%` and detected Chrome path.
- `scripts/start-mcp.cmd` — `cd` to project root and `node src\index.js`.
- `scripts/test.cmd` — runs `node scripts\test-e2e.mjs`.
- `scripts/register-opencode.sh` left unchanged (Req 4.3).

### 6. `package.json` (edit)

```json
"scripts": {
  "start": "node src/index.js",
  "setup": "node scripts/setup.mjs",
  "test": "node scripts/test-e2e.mjs"
}
```

Fixes the invalid `node scripts/test-flow-image.sh` entry (Req 3.4).

### 7. Documentation (`README.md` additions)

- Generic MCP client command: `node path\to\src\index.js` (Req 4.1).
- Copy-paste Claude Desktop snippet (Req 4.2):

```json
{
  "mcpServers": {
    "google-flow": {
      "command": "node",
      "args": ["D:\\FLOWmcp\\google-flow-browser-mcp\\src\\index.js"]
    }
  }
}
```

- One-step final sequence (Req 5.1): `npm install` → `npm run setup` → edit `expectedAccount` in `config/flow.config.json` → `npm start`.

## Data Models

`config/flow.config.json` keys touched by this feature (all others copied verbatim from the example):

| Key | Source | Notes |
|-----|--------|-------|
| `chromePath` | detected / user | Absolute path to `chrome.exe` |
| `chromeUserDataDir` | detected | `%LOCALAPPDATA%\Google\Chrome\User Data` |
| `chromeProfile` | enumerated | e.g. `Default`, `Profile 3` |
| `expectedAccount` | user | Placeholder until email entered |

## Error Handling

- `resolveChromePath` throws `FlowError(CONFIG_ERROR)` with an actionable message when no executable is found (Req 1.3).
- Setup detection failures are logged as warnings, never throw; the config is still written with placeholders so the user can complete it manually.
- Missing `chromeUserDataDir`/profile at launch surfaces the existing `FlowError(CONFIG_ERROR)` from `launch-profile.js`.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Chrome path resolution precedence

*For any* config value and any set of candidate install locations, `resolveChromePath` returns the config value when it points to an existing file; otherwise it returns the first existing candidate in priority order.

**Validates: Requirements 1.1, 1.2**

### Property 2: Unresolvable Chrome path raises an error

*For any* absent/empty config value where no candidate location exists, `resolveChromePath` throws an error identifying that the Chrome executable was not found.

**Validates: Requirements 1.3**

### Property 3: Profile source composition

*For any* user data directory and profile name, `resolveProfileSource` returns the platform path join of the two.

**Validates: Requirements 1.4**

### Property 4: Temp profile directory location

*For any* invocation, `makeTempProfileDir` returns a path located under `os.tmpdir()`, and repeated invocations produce distinct paths.

**Validates: Requirements 1.5**

### Property 5: Selected profile is an available profile

*For any* user data directory populated with one or more profile directories, the `chromeProfile` value written by the Setup_Process is a member of the set of enumerated available profiles.

**Validates: Requirements 2.4**

### Property 6: Existing config preservation (idempotence)

*For any* pre-existing `config/flow.config.json`, running the Setup_Process leaves the file contents unchanged.

**Validates: Requirements 2.6**

## Testing Strategy

- **Property tests** (min. 100 iterations each) cover Properties 1–6 above, tagged `Feature: flow-mcp-run-setup, Property N: ...`. The filesystem existence checks and directory enumeration are stubbed so the resolver/setup logic is tested in isolation.
- **Example/smoke tests**: fresh-workspace config creation (2.1), detected-value writes (2.2, 2.3), placeholder account (2.5), presence of the three `.cmd` scripts (3.1–3.3), and `package.json test` pointing at `scripts/test-e2e.mjs` (3.4).
- **Documentation checks**: README contains the generic command and MCP snippet (4.1, 4.2) and `register-opencode.sh` is unchanged (4.3).
- **Integration**: `scripts/test-e2e.mjs` serves as the end-to-end check that a fully populated config starts the server (5.2); run manually since it launches Chrome.
