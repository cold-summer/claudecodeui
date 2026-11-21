import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { MemberChatRun } from '@/shared/types.js';

import { executeMemberTool, memberToolsAvailable } from '../member-project-tools.js';

test('member modes execute only within the granted project', { skip: !memberToolsAvailable() }, async () => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cloudcli-member-tool-test-')));
  const root = path.join(temp, 'project');
  const privateFile = path.join(temp, 'private-file.txt');
  let approvalCount = 0;
  const server = createServer((socket) => socket.end('outside-sandbox-network'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(root);
    await writeFile(path.join(root, 'readable.txt'), 'authorized contents\n');
    await writeFile(privateFile, 'sibling secret');
    await symlink(privateFile, path.join(root, 'outside.txt'));
    const run: MemberChatRun = {
      projectPath: root,
      permissionMode: 'default',
      hostWorkspaceAccess: false,
      signal: AbortSignal.timeout(15_000),
      approve: async () => { approvalCount += 1; return false; },
      checkAccess: () => {},
    };
    assert.match((await executeMemberTool(run, 'read_file', { path: 'readable.txt' })).content, /authorized contents/);
    assert.equal((await executeMemberTool(run, 'write_file', { path: 'blocked.txt', content: 'abc' })).is_error, true);
    assert.equal(approvalCount, 1);

    run.permissionMode = 'acceptEdits';
    assert.equal((await executeMemberTool(run, 'write_file', { path: 'updated.txt', content: 'saved' })).is_error, undefined);
    assert.equal(await readFile(path.join(root, 'updated.txt'), 'utf8'), 'saved');
    assert.equal((await executeMemberTool(run, 'run_command', { command: 'pwd' })).is_error, true);
    assert.equal(approvalCount, 2);

    run.permissionMode = 'bypassPermissions';
    assert.match((await executeMemberTool(run, 'run_command', { command: 'cat readable.txt' })).content, /authorized contents/);
    for (const command of ['cat outside.txt', `cat "${privateFile}"`, 'echo wrong > outside.txt']) {
      const result = await executeMemberTool(run, 'run_command', { command });
      assert.equal(result.is_error, true);
      assert.doesNotMatch(result.content, /sibling secret/);
    }
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const network = await executeMemberTool(run, 'run_command', { command: `/usr/bin/nc -w 1 127.0.0.1 ${address.port}` });
    assert.equal(network.is_error, true);
    assert.doesNotMatch(network.content, /outside-sandbox-network/);
    assert.equal(await readFile(privateFile, 'utf8'), 'sibling secret');
    assert.equal(approvalCount, 2);

    run.hostWorkspaceAccess = true;
    assert.match((await executeMemberTool(run, 'run_command', { command: `cat "${privateFile}"` })).content, /sibling secret/);
    assert.match((await executeMemberTool(run, 'read_file', { path: privateFile })).content, /sibling secret/);
    const hostNetwork = await executeMemberTool(run, 'run_command', { command: `/usr/bin/nc -w 1 127.0.0.1 ${address.port}` });
    assert.match(hostNetwork.content, /outside-sandbox-network/);
    assert.equal(approvalCount, 2);
  } finally {
    server.close();
    await rm(temp, { recursive: true, force: true });
  }
});
