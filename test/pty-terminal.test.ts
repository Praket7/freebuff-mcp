import assert from 'node:assert/strict';
import test from 'node:test';
import { CliTerminalScreen, cliTerminalIsReady } from '../src/pty.js';

test('CLI readiness waits for the Connecting indicator to clear from the visible screen', () => {
  const screen = new CliTerminalScreen();
  screen.write('\x1b[2J\x1b[HConnecting...\n\nEnd session  Enter a coding task or / for commands');
  assert.equal(cliTerminalIsReady(screen.text()), false);

  screen.write('\x1b[2J\x1b[HConnected\n\nEnd session  Enter a coding task or / for commands');
  assert.equal(cliTerminalIsReady(screen.text()), true);
});

test('CLI readiness handles split ANSI sequences and does not mistake old PTY output for the screen', () => {
  const screen = new CliTerminalScreen();
  screen.write('\x1b[2');
  screen.write('J\x1b[HConnecting\n\nEnter a coding task or / for commands');
  assert.equal(cliTerminalIsReady(screen.text()), false);

  screen.write('\x1b[2J\x1b[HConnected\n\nEnter a coding task or / for commands');
  assert.equal(cliTerminalIsReady(screen.text()), true);
});

test('CLI readiness tracks line rewrites used by terminal UIs', () => {
  const screen = new CliTerminalScreen();
  screen.write('Connecting...\n\nEnter a coding task or / for commands');
  assert.equal(cliTerminalIsReady(screen.text()), false);

  screen.write('\x1b[3A\r\x1b[2KConnected');
  assert.equal(cliTerminalIsReady(screen.text()), true);
});

test('CLI readiness rejects a timeout screen that never rendered the interactive prompt', () => {
  assert.equal(cliTerminalIsReady(''), false);
  assert.equal(cliTerminalIsReady('Connecting...'), false);
});
