import './setup';
import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import { clearConfigValues, setConfigValue } from './mockVscode';
import { ConfigurationService } from '../src/services/configuration';

// 每例前清空配置，保证默认值判断不受污染
beforeEach(() => {
  clearConfigValues();
});

test('getPort 默认值为 3080', () => {
  assert.equal(ConfigurationService.getInstance().getPort(), 3080);
});

test('getPort 读取配置值', () => {
  setConfigValue('dsh-web.port', 5000);
  assert.equal(ConfigurationService.getInstance().getPort(), 5000);
});

test('getTimeout 默认值为 5000', () => {
  assert.equal(ConfigurationService.getInstance().getTimeout(), 5000);
});

test('getTimeout 读取配置值', () => {
  setConfigValue('dsh-web.timeout', 3000);
  assert.equal(ConfigurationService.getInstance().getTimeout(), 3000);
});

test('getKillOnExit 默认值为 true', () => {
  assert.equal(ConfigurationService.getInstance().getKillOnExit(), true);
});

test('getKillOnExit 读取配置值', () => {
  setConfigValue('dsh-web.killOnExit', false);
  assert.equal(ConfigurationService.getInstance().getKillOnExit(), false);
});

test('getTerminalStartupDelay 默认值为 0', () => {
  assert.equal(ConfigurationService.getInstance().getTerminalStartupDelay(), 0);
});
