# SidePulse Status

Show weekly Claude and Codex quota remaining, free disk space, and Rex approval prompts on a SidePulse Pro.

| Light | Meaning |
| --- | --- |
| Orange bar | Claude weekly quota remaining |
| Blue bar | Codex weekly quota remaining |
| Green bar | Available space on the Mac’s data volume |
| Soft yellow pulse | Rex reports a permission prompt or a wait for Touch ID |
| Red double flash | Battery below 10% |

The bars take turns. Yellow takes priority over the bars. Red takes priority over everything. Standalone macOS Touch ID dialogs are not detected.

## Try it

Use a 14-inch or 16-inch MacBook Pro from 2021 or later, a [SidePulse Pro](https://sidepulse.io/sidepulse.html) mounted as a writable drive, and Node.js 24.2 or newer. SidePulse Dot is not supported. Stop any other service that writes to the card while this one runs.

Clone the repo into a folder you plan to keep:

```sh
git clone https://github.com/adstastic/sidepulse-status.git
cd sidepulse-status
node quota.mjs --check
node quota.mjs
```

`--check` reports available readings without writing to the card. The second command runs the display in the foreground. Press Ctrl-C to stop it.

Disk and battery work without an account. Add only the sources you want:

- **Rex:** Install [Rex](https://www.superlogical.com/rex/docs). Yellow uses [program status reported by terminal apps](https://www.superlogical.com/rex/docs/build/program-status), including on configured remote Rex hosts. It does not read terminal screens.
- **Claude:** Install [Claude Swap](https://github.com/realiti4/claude-swap) and add your signed-in Claude account. If you have multiple accounts, run `claude-swap list --json` locally and set `SIDEPULSE_CLAUDE_ORG_UUID` to the desired account’s `organizationUuid`. The Claude bar is skipped if it cannot identify one matching account.
- **Codex:** Install the [CodexBar CLI](https://github.com/steipete/CodexBar/blob/main/docs/cli.md) and sign in to Codex. The script uses CodexBar's OAuth source and reads only the weekly window, not the five-hour limit.

Put `claude-swap` and `codexbar` in `~/.local/bin` or a standard Homebrew bin directory (`/opt/homebrew/bin` or `/usr/local/bin`) if the script cannot find them.

If Rex is installed in a custom location, set `SIDEPULSE_REX` to its absolute CLI path. Set `SIDEPULSE_REX_SOCKET` to the absolute socket path if your local Rex server uses a different one. If macOS mounts your card under a different name, set `SIDEPULSE_VOLUME` to its path under `/Volumes`.

## Start at login

Stop the foreground instance first. From the same folder, run:

```sh
node service.mjs install
```

Set any optional values in your shell before you run the installer. Run `node service.mjs uninstall` to remove the login agent. The login agent uses the folder you cloned into. Uninstall it before you move that folder.

If the card disappears after sleep, check whether Finder still sees it. The service resumes when the volume returns, but it cannot remount an ejected card.

The script sends no telemetry. It reads quota through your existing Claude Swap and CodexBar logins. It does not copy or print credentials.

## Run tests

Install Lua if `lua` is not on your `PATH`. Only the Rex tests need it.

```sh
node --test *.test.mjs
```

The tests use [SidePulse's LED simulator](https://github.com/inteliwear/sidepulse/blob/1e60d9164a46a49f23370987388824caf73ebbdf/src/sidepulse/resources/sdled.wasm) under its [MIT license](LICENSE-sidepulse.txt). No card or signed-in accounts are required for the tests.
