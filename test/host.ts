import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

// Invoked only with the isolated profile/extension directory by --extensionTestsPath.
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('xxh3898.kr-stock-monitor');
  assert.ok(extension, 'Development extension is available');
  const evidence = path.join(extension.extensionPath, 'out', 'host-test-result.json');
  try {
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const suffix of ['connect', 'disconnect', 'demo', 'menu', 'registerKeys', 'addStock', 'removeKeys', 'displayMode', 'registerAccount', 'removeAccount']) {
      assert.ok(commands.includes(`krStockMonitor.${suffix}`), `Command ${suffix}`);
    }
    const config = vscode.workspace.getConfiguration('krStockMonitor');
    assert.equal(config.get('position'), 'right');
    assert.equal(config.get('showProfit'), false);
    await config.update('showProfit', true, vscode.ConfigurationTarget.Global);
    await config.update('stocks', [{ code: '000990', name: 'DB하이텍' }, { code: '204320', name: 'HL만도' }, { code: '108860', name: '셀바스AI' }], vscode.ConfigurationTarget.Global);
    await config.update('displayMode', 'all', vscode.ConfigurationTarget.Global);
    assert.equal(config.get('pollingInterval'), 5);
    await config.update('pollingInterval', 10, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('krStockMonitor.demo');
    for (const position of ['left', 'right', 'left']) {
      const changed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { listener.dispose(); reject(new Error('Position configuration event timed out')); }, 3000);
        const listener = vscode.workspace.onDidChangeConfiguration(event => {
          if (!event.affectsConfiguration('krStockMonitor.position')) return;
          clearTimeout(timer); listener.dispose(); resolve();
        });
      });
      await Promise.all([config.update('position', position, vscode.ConfigurationTarget.Global), changed]);
      assert.equal(vscode.workspace.getConfiguration('krStockMonitor').get('position'), position);
    }
    await new Promise<void>(resolve => setTimeout(resolve, 1100));
    await config.update('rotationInterval', 1, vscode.ConfigurationTarget.Global);
    await config.update('displayMode', 'rotate', vscode.ConfigurationTarget.Global);
    await new Promise<void>(resolve => setTimeout(resolve, 1100));
    await config.update('displayMode', 'all', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('krStockMonitor.disconnect');
    await fs.writeFile(evidence, JSON.stringify({ passed: true, version: extension.packageJSON.version, checks: ['real Extension Host activation', 'position defaults right and changes left/right during demo', 'display mode command registration', 'account command registration and opt-in setting', 'three stocks in isolated configuration', 'demo all/rotate mode switching', 'HTTPS polling configuration', 'disconnect'], liveApiTested: false }, null, 2));
  } catch (error) {
    await fs.writeFile(evidence, JSON.stringify({ passed: false, error: error instanceof Error ? error.message : 'Unknown host failure' }));
    throw error;
  }
}
