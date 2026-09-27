/**
 * The Claude plugin in plugins/zoteus, which is what the Claude directory lists.
 *
 * `claude plugin validate` only checks that the files are well-formed. The directory's own
 * checks go further, and two of them fail on a routine release rather than on an edit to the
 * plugin: `.mcp.json` must launch an exactly pinned package (an unpinned npx launcher blocks
 * submission), and that pin has to move with every release or the listing keeps serving the
 * old server. The skills also name tools by their registered names, so a renamed tool would
 * leave a skill pointing at nothing. These tests catch both, plus the directory's README,
 * license and file rules, in `npm test` rather than in the portal.
 */
import { lstatSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tools } from '../src/tools/index.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(repo, 'plugins', 'zoteus');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

const pkg = readJson(join(repo, 'package.json'));
const manifest = readJson(join(pluginDir, '.claude-plugin', 'plugin.json'));
const mcp = readJson(join(pluginDir, '.mcp.json'));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return lstatSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** The front matter of a SKILL.md as flat `key: value` lines, which is all these files use. */
function frontMatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return {};
  return Object.fromEntries(
    match[1]!.split('\n').map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
}

const skillDirs = readdirSync(join(pluginDir, 'skills'));

describe('Claude plugin manifest', () => {
  it('is versioned in lockstep with the package', () => {
    expect(manifest.name).toBe('zoteus');
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.description).toBeTruthy();
    expect(manifest.author?.name).toBeTruthy();
    expect(manifest.license).toBe(pkg.license);
  });

  it('launches exactly the package version this commit releases', () => {
    const servers = Object.values(mcp.mcpServers) as Array<{ command: string; args: string[] }>;
    expect(servers).toHaveLength(1);
    const [server] = servers;
    expect(server!.command).toBe('npx');
    const spec = server!.args.find((a) => a.startsWith(`${pkg.name}@`));
    // An exact version: the directory blocks a range, a tag such as @latest, or no version.
    expect(spec).toBe(`${pkg.name}@${pkg.version}`);
  });

  it('takes secrets only through userConfig, each with a default so Cowork still starts it', () => {
    const env = Object.values(mcp.mcpServers).flatMap((s: any) =>
      Object.values(s.env ?? {}),
    ) as string[];
    const refs = env.flatMap((v) => [...v.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]!));
    for (const ref of refs) {
      // A bare ${ZOTERO_API_KEY} would read a credential from the user's environment, which
      // the directory holds for review; ${user_config.*} is the route it accepts.
      expect(ref).toMatch(/^user_config\./);
      const option = manifest.userConfig?.[ref.slice('user_config.'.length)];
      expect(option, `${ref} is not declared in userConfig`).toBeDefined();
      // Cowork does not prompt for values and ignores a server whose option has no default.
      expect(option.default, `${ref} has no default`).toBeDefined();
    }
    expect(manifest.userConfig.zotero_api_key.sensitive).toBe(true);
  });

  it('is the plugin the repository marketplace lists', () => {
    const market = readJson(join(repo, '.claude-plugin', 'marketplace.json'));
    const entry = market.plugins.find((p: { name: string }) => p.name === manifest.name);
    expect(entry).toBeDefined();
    expect(resolve(repo, entry.source)).toBe(pluginDir);
  });
});

describe('Claude plugin skills', () => {
  const toolNames = new Set(tools.map((t) => t.name));

  it('has skills to check', () => {
    expect(skillDirs.length).toBeGreaterThan(0);
  });

  for (const dir of skillDirs) {
    const text = readFileSync(join(pluginDir, 'skills', dir, 'SKILL.md'), 'utf8');

    it(`${dir}: front matter names the folder and describes when to use it`, () => {
      const fm = frontMatter(text);
      expect(fm.name).toBe(dir);
      expect(fm.description).toBeTruthy();
      // A plain YAML scalar: no ": " or " #" inside, and not opening as a list or a quote,
      // which would parse as something other than the single string the directory requires.
      expect(fm.description).not.toMatch(/: | #|^[-[{'"&*!|>%@`]/);
    });

    it(`${dir}: names only tools the server registers`, () => {
      const named = new Set(text.match(/\bzotero_[a-z_]+\b/g) ?? []);
      expect([...named].filter((n) => !toolNames.has(n))).toEqual([]);
    });
  }
});

describe('Claude plugin folder, against the directory checklist', () => {
  const files = walk(pluginDir);

  it('has a README of at least 40 words outside code blocks', () => {
    const readme = readFileSync(join(pluginDir, 'README.md'), 'utf8').replace(
      /```[\s\S]*?```/g,
      '',
    );
    expect(readme.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
  });

  it('carries the same license as the repository', () => {
    expect(readFileSync(join(pluginDir, 'LICENSE'), 'utf8')).toBe(
      readFileSync(join(repo, 'LICENSE'), 'utf8'),
    );
  });

  it('holds only small regular text files, and nothing that installs packages on its own', () => {
    for (const file of files) {
      const rel = relative(pluginDir, file);
      const stat = lstatSync(file);
      expect(stat.isFile(), `${rel} is not a regular file`).toBe(true);
      expect(stat.size, `${rel} is over 256 KiB`).toBeLessThan(256 * 1024);
      expect(rel).not.toMatch(
        /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\.npmrc|package(-lock)?\.json|npm-shrinkwrap\.json|bun\.lockb?)$/,
      );
    }
    // A top-level bin/ stops claude.ai and Cowork from installing the plugin at all.
    expect(existsSync(join(pluginDir, 'bin'))).toBe(false);
  });
});
