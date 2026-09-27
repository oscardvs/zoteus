#!/usr/bin/env node
// Ship the lockfile inside the npm package, as npm-shrinkwrap.json, and only there.
//
//   node scripts/shrinkwrap.mjs create   # prepack: write it from package-lock.json
//   node scripts/shrinkwrap.mjs remove   # postpack: take it away again
//
// npm never publishes package-lock.json, but it does publish npm-shrinkwrap.json and honours
// it when the package is installed, npx included. So `npx @oscardvs/zoteus@X.Y.Z`, which is
// how the Claude plugin starts the server, installs exactly the dependency tree this
// repository tested instead of whatever the ranges resolve to that day. The Claude
// directory holds a plugin that runs a pinned npx package without one.
//
// Dev-only entries are left out. npm installs every entry a dependency's shrinkwrap lists,
// dev or not: 1.22.1 shipped the lock whole, and `npx @oscardvs/zoteus@1.22.1` fetched the
// test and build tools with it: 278 packages and 228 MB, where this installs 99 and 132 MB
// on Linux. The root's devDependencies go with them, so the file describes only what runs.
//
// The repository keeps package-lock.json as its one lockfile (the Dockerfile and
// scripts/mcpb-bundle.ts read it), so the shrinkwrap exists only while npm packs. The lock
// records every platform's optional binaries, so one file serves every OS.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

/** The lock without the packages only development needs. */
export function runtimeLock(lock) {
  const packages = {};
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (entry.dev) continue;
    packages[path] = path === '' ? { ...entry, devDependencies: undefined } : entry;
  }
  return { ...lock, packages };
}

const [action] = process.argv.slice(2);
if (action === 'create') {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  writeFileSync('npm-shrinkwrap.json', `${JSON.stringify(runtimeLock(lock), null, 2)}\n`);
} else if (action === 'remove') {
  rmSync('npm-shrinkwrap.json', { force: true });
} else if (action !== undefined) {
  console.error('usage: node scripts/shrinkwrap.mjs create|remove');
  process.exit(2);
}
