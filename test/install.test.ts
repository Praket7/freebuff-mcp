import assert from 'node:assert/strict';
import test from 'node:test';
import { installCodex } from '../src/install/codex.js';
import { installClaude } from '../src/install/claude.js';
import { codexConfigPath, claudeConfigPaths } from '../src/install/common.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('codex installer: printed config includes tool timeout and command', async () => {
  const output = await installCodex(false);
  assert.match(output, /tool_timeout_sec = 3600/);
  assert.match(output, /startup_timeout_sec/);
  assert.match(output, /mcp_servers\.freebuff/);
  assert.match(output, /serve/);
});

test('codex installer: write refuses to overwrite an existing freebuff entry', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-install-'));
  const originalHome = os.homedir;
  // Temporarily relocate HOME so the config path lands in our temp dir.
  const configPath = path.join(dir, '.codex', 'config.toml');
  (os as unknown as { homedir: () => string }).homedir = () => dir;
  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, '[mcp_servers.freebuff]\ncommand = "existing"\n', 'utf8');
    const message = await installCodex(true);
    assert.match(message, /already exists|no changes/);
    const content = await fs.readFile(configPath, 'utf8');
    assert.match(content, /command = "existing"/, 'existing entry untouched');
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHome;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('codex installer: write appends to an existing config without corrupting it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-install-'));
  const originalHome = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => dir;
  try {
    const configPath = path.join(dir, '.codex', 'config.toml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, '[profile.default]\nmodel = "gpt-5"', 'utf8');
    const message = await installCodex(true);
    assert.match(message, /Added Freebuff configuration/);
    const content = await fs.readFile(configPath, 'utf8');
    assert.match(content, /\[profile\.default\]/, 'existing content preserved');
    assert.match(content, /\[mcp_servers\.freebuff\]/, 'new entry appended');
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHome;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('claude installer: printed output includes the CLI registration and JSON config', async () => {
  const output = await installClaude(false, 'user');
  assert.match(output, /claude mcp add/);
  assert.match(output, /freebuff/);
  assert.match(output, /mcpServers|"freebuff"/);
});

test('claude installer: user-scope write merges into existing config without data loss', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-claude-'));
  const originalHome = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => dir;
  try {
    const { user } = claudeConfigPaths();
    await fs.mkdir(path.dirname(user), { recursive: true });
    await fs.writeFile(user, JSON.stringify({ theme: 'dark', mcpServers: { other: { type: 'stdio', command: 'x' } } }), 'utf8');
    const message = await installClaude(true, 'user');
    assert.match(message, /Added the freebuff MCP server/);
    const parsed = JSON.parse(await fs.readFile(user, 'utf8')) as { theme?: string; mcpServers: Record<string, unknown> };
    assert.equal(parsed.theme, 'dark', 'unrelated keys preserved');
    assert.ok(parsed.mcpServers.other, 'other MCP servers preserved');
    assert.ok(parsed.mcpServers['freebuff'], 'freebuff entry added');
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHome;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('claude installer: write refuses to clobber a differing freebuff entry', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-claude-'));
  const originalHome = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => dir;
  try {
    const { user } = claudeConfigPaths();
    await fs.mkdir(path.dirname(user), { recursive: true });
    await fs.writeFile(user, JSON.stringify({ mcpServers: { freebuff: { type: 'stdio', command: 'someone-else' } } }), 'utf8');
    const message = await installClaude(true, 'user');
    assert.match(message, /differing|no changes/);
    const parsed = JSON.parse(await fs.readFile(user, 'utf8')) as { mcpServers: Record<string, { command: string } | undefined> };
    assert.equal(parsed.mcpServers.freebuff?.command, 'someone-else', 'existing entry untouched');
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHome;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('codex config path is platform-appropriate', () => {
  const configPath = codexConfigPath();
  if (process.platform === 'win32') assert.match(configPath, /\\.codex\\config\.toml$/);
  else assert.match(configPath, /\.codex\/config\.toml$/);
});
