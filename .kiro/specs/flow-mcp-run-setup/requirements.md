# Requirements Document

## Introduction

The google-flow-browser-mcp project currently contains Linux-specific hardcoded paths, bash-only scripts, and a missing runtime config file, which prevent it from running on Windows. This feature makes the project fully run-ready on Windows by replacing hardcoded values with cross-platform equivalents, auto-detecting the Chrome install and profile, generating native Windows scripts, and pre-filling all detectable configuration into `config/flow.config.json`. After setup, the only remaining user action is entering the Google account email, so the server "just works" immediately.

## Glossary

- **MCP_Server**: The Model Context Protocol server implemented in this project, entry point `src/index.js`.
- **Setup_Process**: The setup routine that detects the environment and generates `config/flow.config.json` from `config/flow.config.example.json`.
- **Browser_Launcher**: The browser launch and connection code in `src/browser/launch-profile.js` and `src/browser/connect.js`.
- **Chrome_Path**: The filesystem path to the Chrome executable, resolved from config key `chromePath` or auto-detected.
- **User_Data_Dir**: The Chrome user data directory (`chromeUserDataDir` config key) containing profiles.
- **Chrome_Profile**: The named Chrome profile directory (`chromeProfile` config key), e.g. `Profile 3`.
- **Runtime_Config**: The `config/flow.config.json` file read by `src/utils/config.js` at runtime.
- **Expected_Account**: The Google account email (`expectedAccount` config key) used by the MCP server.
- **Temp_Profile_Dir**: The temporary Chrome user-data directory created during direct+CDP launch.

## Requirements

### Requirement 1: Cross-Platform Browser Paths

**User Story:** As a Windows user, I want the browser code to use cross-platform paths, so that the MCP server launches Chrome without Linux-specific failures.

#### Acceptance Criteria

1. THE Browser_Launcher SHALL resolve Chrome_Path from the `chromePath` config key when the `chromePath` config key is present.
2. IF the `chromePath` config key is absent or empty, THEN THE Browser_Launcher SHALL auto-detect Chrome_Path from the standard Windows Chrome install locations.
3. IF Chrome_Path cannot be resolved from config or auto-detection, THEN THE Browser_Launcher SHALL raise an error identifying that the Chrome executable was not found.
4. THE Browser_Launcher SHALL resolve the profile source directory from the User_Data_Dir and Chrome_Profile config keys.
5. THE Browser_Launcher SHALL create the Temp_Profile_Dir under the operating system temporary directory returned by `os.tmpdir()`.

### Requirement 2: Auto-Generated Runtime Config

**User Story:** As a Windows user, I want the setup to generate a working runtime config, so that the server runs without me editing paths manually.

#### Acceptance Criteria

1. WHEN the Setup_Process runs and `config/flow.config.json` does not exist, THE Setup_Process SHALL create Runtime_Config from `config/flow.config.example.json`.
2. THE Setup_Process SHALL write the detected User_Data_Dir into the `chromeUserDataDir` key of Runtime_Config.
3. THE Setup_Process SHALL write the detected Chrome_Path into the `chromePath` key of Runtime_Config.
4. WHERE one or more Chrome profiles exist in the User_Data_Dir, THE Setup_Process SHALL write an available profile into the `chromeProfile` key of Runtime_Config.
5. THE Setup_Process SHALL leave the `expectedAccount` key as the value requiring the user to enter the Google account email.
6. IF `config/flow.config.json` already exists, THEN THE Setup_Process SHALL preserve the existing Runtime_Config without overwriting user values.

### Requirement 3: Native Windows Scripts

**User Story:** As a Windows user, I want native Windows scripts, so that I can start the browser, start the server, and run tests from cmd.

#### Acceptance Criteria

1. THE Setup_Process SHALL provide a Windows `.cmd` or `.bat` script equivalent to `scripts/start-browser.sh`.
2. THE Setup_Process SHALL provide a Windows `.cmd` or `.bat` script equivalent to `scripts/start-mcp.sh`.
3. THE Setup_Process SHALL provide a Windows `.cmd` or `.bat` script that runs the project test flow.
4. THE MCP_Server SHALL define a `test` script in `package.json` that executes a valid Node-runnable test entry point.

### Requirement 4: Generic MCP Client Documentation

**User Story:** As a user of a generic MCP client, I want copy-paste configuration and documentation, so that I can register the server in Claude Desktop or another MCP client.

#### Acceptance Criteria

1. THE Setup_Process SHALL document the generic command `node path\to\src\index.js` for launching the MCP_Server.
2. THE Setup_Process SHALL provide a copy-paste MCP client configuration snippet referencing the MCP_Server entry point.
3. THE Setup_Process SHALL retain the existing `scripts/register-opencode.sh` script unchanged.

### Requirement 5: One-Step Final Setup

**User Story:** As a user, I want a short final setup path, so that entering my email and running one command is the last step.

#### Acceptance Criteria

1. THE Setup_Process SHALL document a step-by-step sequence whose final user action is entering the Expected_Account email and running the MCP_Server.
2. WHEN the Expected_Account email is present in Runtime_Config and the MCP_Server is started, THE MCP_Server SHALL start without requiring further path or config edits.
