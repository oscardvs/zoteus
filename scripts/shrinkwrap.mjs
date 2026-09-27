#!/usr/bin/env node
// Ship the lockfile inside the npm package, as npm-shrinkwrap.json, and only there.
//
//   node scripts/shrinkwrap.mjs create   # prepack: copy package-lock.json into place
//   node scripts/shrinkwrap.mjs remove   # postpack: take it away again
//
// npm never publishes package-lock.json, but it does publish npm-shrinkwrap.json and honours
// it when the package is installed, npx included. So `npx @oscardvs/zoteus@X.Y.Z`, which is
// how the Claude plugin starts the server, installs exactly the dependency tree this
// repository tested instead of whatever the ranges resolve to that day. The Claude
// directory holds a plugin that runs a pinned npx package without one.
//
// The repository keeps package-lock.json as its one lockfile (the Dockerfile and
// scripts/mcpb-bundle.ts read it), so the shrinkwrap exists only while npm packs. The lock
// records every platform's optional binaries, so one file serves every OS.
import { copyFileSync, rmSync } from 'node:fs';

const [action] = process.argv.slice(2);
if (action === 'create') copyFileSync('package-lock.json', 'npm-shrinkwrap.json');
else if (action === 'remove') rmSync('npm-shrinkwrap.json', { force: true });
else {
  console.error('usage: node scripts/shrinkwrap.mjs create|remove');
  process.exit(2);
}
