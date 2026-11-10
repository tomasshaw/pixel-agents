import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { accountById, accountForConfigDir, accountForFile, accountsForOffice, listAccounts } =
  await import('../src/accounts.js');
const { parseAccounts, readConfig } = await import('../src/configPersistence.js');
const { directoriesLoadedMessage, directoryAccount, saveUserDirectory } =
  await import('../src/directories.js');
const { claudeProvider } = await import('../src/providers/index.js');
const { normalizeProjectPath } = await import('../../core/src/normalizeProjectPath.js');

function writeConfig(config: unknown): void {
  fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
  fs.writeFileSync(path.join(tmpBase, '.pixel-agents', 'config.json'), JSON.stringify(config));
}

const TWO_ACCOUNTS = [
  { id: 'main', name: 'Main', configDir: '~/.claude' },
  { id: 'work', name: 'Work', configDir: '~/.claude_work' },
];

beforeEach(() => {
  // Resolved, so paths compare equal to what the code derives from them.
  tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-accounts-')));
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('parseAccounts', () => {
  it('keeps well-formed entries, names a nameless one after its id', () => {
    expect(
      parseAccounts([
        { id: 'main', name: 'Main', configDir: '~/.claude' },
        { id: 'work', configDir: '/w' },
      ]),
    ).toEqual([
      { id: 'main', name: 'Main', configDir: '~/.claude' },
      { id: 'work', name: 'work', configDir: '/w' },
    ]);
  });

  it.each([
    ['not an array', { id: 'a', configDir: '/a' }],
    ['a bad id', [{ id: 'has space', configDir: '/a' }]],
    ['no config directory', [{ id: 'a', name: 'A' }]],
    ['an empty config directory', [{ id: 'a', configDir: '  ' }]],
  ])('drops %s', (_label, raw) => {
    expect(parseAccounts(raw)).toEqual([]);
  });

  it('takes letters of either case, digits, _ and - in an id', () => {
    expect(parseAccounts([{ id: 'Claude_work-2', configDir: '/a' }])).toHaveLength(1);
  });

  it('says so once when it drops a hand-written entry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = [{ id: 'not ok', configDir: '/only-reported-once' }];
    parseAccounts(bad);
    parseAccounts(bad);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('not ok');
    warn.mockRestore();
  });

  it('keeps the first of a repeated id', () => {
    expect(
      parseAccounts([
        { id: 'a', configDir: '/first' },
        { id: 'a', configDir: '/second' },
      ]),
    ).toEqual([{ id: 'a', name: 'a', configDir: '/first' }]);
  });
});

describe('accounts', () => {
  it('lists none without a config', () => {
    expect(listAccounts()).toEqual([]);
    expect(accountById('main')).toBeUndefined();
  });

  it('resolves a leading ~ against the home directory', () => {
    writeConfig({ accounts: TWO_ACCOUNTS });
    expect(listAccounts()).toEqual([
      { id: 'main', name: 'Main', configDir: path.join(tmpBase, '.claude') },
      { id: 'work', name: 'Work', configDir: path.join(tmpBase, '.claude_work') },
    ]);
  });

  it('keeps a config directory as the user spelled it, past the ~', () => {
    // Claude Code keys a login on the exact string: no normalizing.
    writeConfig({ accounts: [{ id: 'w', configDir: '~/.claude_work/' }] });
    expect(listAccounts()[0].configDir).toBe(path.join(tmpBase, '.claude_work') + path.sep);
  });

  it('matches a config directory through a symlink to it', () => {
    writeConfig({ accounts: TWO_ACCOUNTS });
    fs.mkdirSync(path.join(tmpBase, '.claude_work'));
    fs.symlinkSync(path.join(tmpBase, '.claude_work'), path.join(tmpBase, 'link'));
    expect(accountForConfigDir(path.join(tmpBase, 'link'))?.id).toBe('work');
  });

  it('tells the office ids and names only, never paths', () => {
    writeConfig({ accounts: TWO_ACCOUNTS });
    expect(accountsForOffice()).toEqual([
      { id: 'main', name: 'Main' },
      { id: 'work', name: 'Work' },
    ]);
  });

  it('finds the account a transcript is filed under', () => {
    writeConfig({ accounts: TWO_ACCOUNTS });
    const file = (dir: string) => path.join(tmpBase, dir, 'projects', '-p', 's.jsonl');
    expect(accountForFile(file('.claude'))?.id).toBe('main');
    // `.claude_work` starts with `.claude`: a prefix alone must not match.
    expect(accountForFile(file('.claude_work'))?.id).toBe('work');
    expect(accountForFile(file('.elsewhere'))).toBeUndefined();
  });
});

describe('a Directory account', () => {
  const project = () => path.join(tmpBase, 'project');

  beforeEach(() => {
    fs.mkdirSync(project());
    writeConfig({ accounts: TWO_ACCOUNTS });
  });

  it('is stored with the Directory and survives a reload', () => {
    const saved = saveUserDirectory({ name: 'P', path: project(), account: 'work' });
    expect(saved).toMatchObject({ ok: true, directory: { account: 'work' } });
    expect(readConfig().directories).toEqual([{ name: 'P', path: project(), account: 'work' }]);
    expect(directoryAccount(project())?.configDir).toBe(path.join(tmpBase, '.claude_work'));
  });

  it('is kept beside default characters', () => {
    saveUserDirectory({ name: 'P', path: project(), account: 'work', characters: [2, 1] });
    expect(readConfig().directories).toEqual([
      { name: 'P', path: project(), account: 'work', characters: [2, 1] },
    ]);
  });

  it('is not shown to the office once the config stops listing its account', () => {
    saveUserDirectory({ name: 'P', path: project(), account: 'work' });
    writeConfig({
      accounts: [TWO_ACCOUNTS[0]],
      directories: [{ name: 'P', path: project(), account: 'work' }],
    });
    expect(directoriesLoadedMessage([]).directories).toEqual([
      { name: 'P', path: project(), source: 'user' },
    ]);
    expect(directoryAccount(project())).toBeUndefined();
  });

  it('is dropped when the config lists no such account', () => {
    const saved = saveUserDirectory({ name: 'P', path: project(), account: 'gone' });
    expect(saved).toMatchObject({ ok: true });
    expect(readConfig().directories).toEqual([{ name: 'P', path: project() }]);
    expect(directoryAccount(project())).toBeUndefined();
  });

  it('is cleared by saving the Directory without one', () => {
    saveUserDirectory({ name: 'P', path: project(), account: 'work' });
    saveUserDirectory({ name: 'P', path: project(), previousPath: project() });
    expect(directoryAccount(project())).toBeUndefined();
  });

  it('rides the directoriesLoaded message, with the accounts to pick from', () => {
    saveUserDirectory({ name: 'P', path: project(), account: 'work' });
    expect(directoriesLoadedMessage([])).toEqual({
      type: 'directoriesLoaded',
      directories: [{ name: 'P', path: project(), account: 'work', source: 'user' }],
      accounts: [
        { id: 'main', name: 'Main' },
        { id: 'work', name: 'Work' },
      ],
    });
  });

  it('leaves accounts out of directoriesLoaded when none are configured', () => {
    writeConfig({});
    expect(directoriesLoadedMessage([])).toEqual({ type: 'directoriesLoaded', directories: [] });
  });
});

describe('claudeProvider under an account', () => {
  const work = () => path.join(tmpBase, '.claude_work');
  const main = () => path.join(tmpBase, '.claude');
  const launchEnv = (configDir?: string) => {
    const launch = claudeProvider.buildLaunchCommand?.('sid', '/p', { configDir });
    return { env: launch?.env, unsetEnv: launch?.unsetEnv };
  };

  afterEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it('launches with the account config directory in the environment', () => {
    expect(claudeProvider.buildLaunchCommand?.('sid', '/p', { configDir: work() })).toEqual({
      command: 'claude',
      args: ['--session-id', 'sid'],
      env: { PWD: '/p', CLAUDE_CONFIG_DIR: work() },
    });
  });

  it('leaves the environment alone without one', () => {
    expect(launchEnv()).toEqual({ env: { PWD: '/p' }, unsetEnv: undefined });
  });

  // Claude Code keeps a login made with CLAUDE_CONFIG_DIR=~/.claude apart from
  // one made with it unset, so the default directory must never be SET.
  it('never sets the variable for the default directory', () => {
    expect(launchEnv(main())).toEqual({ env: { PWD: '/p' }, unsetEnv: undefined });
  });

  it('unsets an inherited variable to reach the default directory', () => {
    process.env.CLAUDE_CONFIG_DIR = work();
    expect(launchEnv(main())).toEqual({ env: { PWD: '/p' }, unsetEnv: ['CLAUDE_CONFIG_DIR'] });
  });

  it('leaves an inherited variable that already names the account, as spelled', () => {
    process.env.CLAUDE_CONFIG_DIR = main() + path.sep;
    expect(launchEnv(main())).toEqual({ env: { PWD: '/p' }, unsetEnv: undefined });
    process.env.CLAUDE_CONFIG_DIR = work();
    expect(launchEnv(work())).toEqual({ env: { PWD: '/p' }, unsetEnv: undefined });
  });

  it('looks for sessions under the account config directory', () => {
    const missing = path.join(tmpBase, 'no-such-project');
    expect(claudeProvider.getSessionDirs?.(missing, work())).toEqual([
      path.join(work(), 'projects', normalizeProjectPath(missing)),
    ]);
    expect(claudeProvider.getSessionDirs?.(missing)).toEqual([
      path.join(main(), 'projects', normalizeProjectPath(missing)),
    ]);
  });

  it('without an account, looks where the inherited environment points', () => {
    process.env.CLAUDE_CONFIG_DIR = work();
    const missing = path.join(tmpBase, 'no-such-project');
    expect(claudeProvider.getSessionDirs?.(missing)).toEqual([
      path.join(work(), 'projects', normalizeProjectPath(missing)),
    ]);
  });

  it('scans every account for sessions, each real directory once', () => {
    expect(claudeProvider.getAllSessionRoots?.()).toEqual([path.join(main(), 'projects')]);
    writeConfig({ accounts: TWO_ACCOUNTS });
    expect(claudeProvider.getAllSessionRoots?.()).toEqual([
      path.join(main(), 'projects'),
      path.join(work(), 'projects'),
    ]);

    // An account that is a symlink to the default directory is the same place.
    fs.mkdirSync(main());
    fs.symlinkSync(main(), path.join(tmpBase, 'alias'));
    writeConfig({ accounts: [{ id: 'alias', configDir: '~/alias' }] });
    expect(claudeProvider.getAllSessionRoots?.()).toEqual([path.join(main(), 'projects')]);
  });
});
