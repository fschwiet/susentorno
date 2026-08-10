import { describe, it, expect } from 'vitest';
import {
  buildCreateEnvoyRuleCommand,
  buildCreateDnsRuleCommand,
  buildCreateDhcpRuleCommand,
  buildCreateSmbRuleCommand,
  buildRemoveRulesByNameCommand,
  buildRemoveStaleQueryUserRulesCommand,
  buildRemoveRulesByInterfaceCommand,
  parseSweepResult,
} from '../../../src/hostNetwork/hostNetworkFirewallOps';

const ADAPTER = 'vEthernet (susentorno-internal)';
const HOST_IP = '192.168.67.1';
const NODE_PATH = 'C:\\Users\\me\\.susentorno-host\\node-copy-with-custom-firewall-rules.exe';

describe('buildCreateEnvoyRuleCommand', () => {
  it('opens TCP 80/443 scoped to the adapter, address, and dedicated node.exe', () => {
    const command = buildCreateEnvoyRuleCommand(
      'susentorno Envoy Proxy (VM inbound)',
      ADAPTER,
      HOST_IP,
      NODE_PATH,
    );
    expect(command).toContain("-DisplayName 'susentorno Envoy Proxy (VM inbound)'");
    expect(command).toContain('-Protocol TCP');
    expect(command).toContain('-LocalPort 80,443');
    expect(command).toContain(`-Program '${NODE_PATH}'`);
    expect(command).toContain(`-InterfaceAlias '${ADAPTER}'`);
    expect(command).toContain(`-LocalAddress '${HOST_IP}'`);
    expect(command).toContain('-ErrorAction Stop');
  });
});

describe('buildCreateDnsRuleCommand', () => {
  it('opens UDP 53 scoped the same way', () => {
    const command = buildCreateDnsRuleCommand(
      'susentorno DNS stub (VM inbound)',
      ADAPTER,
      HOST_IP,
      NODE_PATH,
    );
    expect(command).toContain('-Protocol UDP');
    expect(command).toContain('-LocalPort 53');
    expect(command).toContain(`-Program '${NODE_PATH}'`);
    expect(command).toContain(`-LocalAddress '${HOST_IP}'`);
  });
});

describe('buildCreateDhcpRuleCommand', () => {
  it('opens UDP 67 scoped to the interface only, no -LocalAddress', () => {
    const command = buildCreateDhcpRuleCommand('susentorno DHCP (VM inbound)', ADAPTER, NODE_PATH);
    expect(command).toContain('-Protocol UDP');
    expect(command).toContain('-LocalPort 67');
    expect(command).toContain(`-InterfaceAlias '${ADAPTER}'`);
    expect(command).not.toContain('-LocalAddress');
  });
});

describe('buildCreateSmbRuleCommand', () => {
  it('opens TCP 445 scoped to whatever adapter/address it is given', () => {
    const command = buildCreateSmbRuleCommand(
      'susentorno share (VM inbound)',
      'vEthernet (Default Switch)',
      '10.0.0.5',
    );
    expect(command).toContain('-Protocol TCP');
    expect(command).toContain('-LocalPort 445');
    expect(command).toContain("-InterfaceAlias 'vEthernet (Default Switch)'");
    expect(command).toContain("-LocalAddress '10.0.0.5'");
    expect(command).not.toContain('-Program');
  });
});

describe('buildRemoveRulesByNameCommand', () => {
  it('removes every matching rule per name, quoted, tracking removed/failed separately', () => {
    const command = buildRemoveRulesByNameCommand(["susentorno's rule", 'another rule']);
    expect(command).toContain("'susentorno''s rule'");
    expect(command).toContain("'another rule'");
    expect(command).toContain('Remove-NetFirewallRule -ErrorAction Stop');
    expect(command).toContain('catch { $failed++ }');
    expect(command).toContain('Write-Output "$removed,$failed"');
  });
});

describe('buildRemoveStaleQueryUserRulesCommand', () => {
  it('matches by Query User name pattern and program-path suffix, tracking removed/failed separately', () => {
    const command = buildRemoveStaleQueryUserRulesCommand(NODE_PATH);
    expect(command).toContain('*Query User*');
    expect(command).toContain(`EndsWith('${NODE_PATH}'`);
    expect(command).toContain('OrdinalIgnoreCase');
    expect(command).toContain('Remove-NetFirewallRule -ErrorAction Stop');
    expect(command).toContain('Write-Output "$removed,$failed"');
  });
});

describe('buildRemoveRulesByInterfaceCommand', () => {
  it('matches rules by interface filter regardless of name, tracking removed/failed separately', () => {
    const command = buildRemoveRulesByInterfaceCommand(ADAPTER);
    expect(command).toContain('Get-NetFirewallInterfaceFilter -AssociatedNetFirewallRule');
    expect(command).toContain(`-eq '${ADAPTER}'`);
    expect(command).toContain('Remove-NetFirewallRule -ErrorAction Stop');
    expect(command).toContain('Write-Output "$removed,$failed"');
  });
});

describe('parseSweepResult', () => {
  it('parses "removed,failed"', () => {
    expect(parseSweepResult('3,0\r\n')).toEqual({ removed: 3, failed: 0 });
  });

  it('parses a nonzero failed count', () => {
    expect(parseSweepResult('2,1')).toEqual({ removed: 2, failed: 1 });
  });

  it('parses "0,0"', () => {
    expect(parseSweepResult('0,0')).toEqual({ removed: 0, failed: 0 });
  });

  it('defaults both to 0 for empty or unexpected output', () => {
    expect(parseSweepResult('')).toEqual({ removed: 0, failed: 0 });
    expect(parseSweepResult('not a number')).toEqual({ removed: 0, failed: 0 });
  });
});
