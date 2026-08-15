import { homedir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { createHostNetwork } from '../../src/hostNetwork/createHostNetwork';
import { deleteHostNetwork } from '../../src/hostNetwork/deleteHostNetwork';
import { detectTakenRanges, findFreeSubnet } from '../../src/hostNetwork/subnetSelection';
import { buildGetVmSwitchCommand } from '../../src/guestSetup/hyperVQueries';
import { parseVmSwitchExistsExact } from '../../src/hostNetwork/hostNetworkSwitchOps';
import { resolveForwardListenAddress } from '../../src/runHosting/forwarder';
import { resolveIsolationNetwork } from '../../src/runHosting/isolationNetwork';
import { queryRuleFilters } from './queryFirewallRuleFilters';

const ISOLATION_NAME = 'test';
const SWITCH_NAME = 'susentorno-test-internal';
const ADAPTER_ALIAS = 'vEthernet (susentorno-test-internal)';
const NAT_ADAPTER_ALIAS = 'vEthernet (Default Switch)';
const exec = createRealPowerShellExec();

function failIfPrompted(): Promise<never> {
  return Promise.reject(new Error('should not be prompted on the refresh path'));
}

async function cleanUp(): Promise<void> {
  await deleteHostNetwork({ exec, isolationName: ISOLATION_NAME, homedir: homedir() });
}

// beforeEach guarantees a clean starting state for every test; afterEach
// cleans up after a passing test; afterAll is the fallback if beforeEach or
// the test body itself throws partway through, so a failure doesn't strand
// susentorno-test-internal for the next run of this suite.
beforeEach(cleanUp);
afterEach(cleanUp);
afterAll(cleanUp);

describe('create-host-network / delete-host-network against real Hyper-V', () => {
  it('creates a switch, IP, and correctly-scoped firewall rules for every rule set', async () => {
    const subnet = findFreeSubnet(detectTakenRanges());
    expect(subnet).not.toBeNull();

    const result = await createHostNetwork({
      exec,
      isolationName: ISOLATION_NAME,
      subnet: subnet!,
      natAdapterAlias: NAT_ADAPTER_ALIAS,
      homedir: homedir(),
      promptSubnet: async () => subnet!,
    });

    expect(result).toEqual({ hostIp: `192.168.${subnet}.1`, refreshedOnly: false });

    const switchResult = await exec.run(buildGetVmSwitchCommand(SWITCH_NAME));
    expect(parseVmSwitchExistsExact(switchResult.stdout, SWITCH_NAME)).toBe(true);

    const envoyRules = await queryRuleFilters(exec, 'susentorno-test Envoy Proxy (VM inbound)');
    expect(envoyRules).toHaveLength(1);
    expect(envoyRules[0]).toMatchObject({
      protocol: 'TCP',
      localPort: '80,443',
      interfaceAlias: ADAPTER_ALIAS,
      localAddress: result.hostIp,
      enabled: true,
      direction: 'Inbound',
      action: 'Allow',
    });
    expect(envoyRules[0].program).toContain('node-copy-with-custom-firewall-rules.exe');

    const dnsRules = await queryRuleFilters(exec, 'susentorno-test DNS stub (VM inbound)');
    expect(dnsRules).toHaveLength(1);
    expect(dnsRules[0]).toMatchObject({
      protocol: 'UDP',
      localPort: '53',
      interfaceAlias: ADAPTER_ALIAS,
      localAddress: result.hostIp,
      enabled: true,
      direction: 'Inbound',
      action: 'Allow',
    });
    expect(dnsRules[0].program).toContain('node-copy-with-custom-firewall-rules.exe');

    const dhcpRules = await queryRuleFilters(exec, 'susentorno-test DHCP (VM inbound)');
    expect(dhcpRules).toHaveLength(1);
    expect(dhcpRules[0]).toMatchObject({
      protocol: 'UDP',
      localPort: '67',
      interfaceAlias: ADAPTER_ALIAS,
      localAddress: 'Any', // the one deliberate exception — DHCP has no fixed destination to scope to
      enabled: true,
      direction: 'Inbound',
      action: 'Allow',
    });
    expect(dhcpRules[0].program).toContain('node-copy-with-custom-firewall-rules.exe');

    const smbRules = await queryRuleFilters(exec, 'susentorno-test share (VM inbound)');
    expect(smbRules).toHaveLength(2);
    const smbInternal = smbRules.find((r) => r.interfaceAlias === ADAPTER_ALIAS);
    const smbNat = smbRules.find((r) => r.interfaceAlias === NAT_ADAPTER_ALIAS);
    const natHostIp = resolveForwardListenAddress(NAT_ADAPTER_ALIAS);
    expect(natHostIp).not.toBeNull();
    expect(smbInternal).toMatchObject({
      protocol: 'TCP',
      localPort: '445',
      localAddress: result.hostIp,
      enabled: true,
      direction: 'Inbound',
      action: 'Allow',
    });
    expect(smbNat).toMatchObject({
      protocol: 'TCP',
      localPort: '445',
      localAddress: natHostIp,
      enabled: true,
      direction: 'Inbound',
      action: 'Allow',
    });
    // Neither SMB rule is -Program-scoped, unlike the other three.
    expect(smbInternal?.program).toBe('Any');
    expect(smbNat?.program).toBe('Any');
  });

  it('refreshes rules without recreating the switch or duplicating rules on a rerun', async () => {
    const subnet = findFreeSubnet(detectTakenRanges())!;
    const first = await createHostNetwork({
      exec,
      isolationName: ISOLATION_NAME,
      subnet,
      natAdapterAlias: NAT_ADAPTER_ALIAS,
      homedir: homedir(),
      promptSubnet: async () => subnet,
    });
    expect(first.refreshedOnly).toBe(false);

    const second = await createHostNetwork({
      exec,
      isolationName: ISOLATION_NAME,
      natAdapterAlias: NAT_ADAPTER_ALIAS,
      homedir: homedir(),
      promptSubnet: failIfPrompted,
    });

    expect(second).toEqual({ hostIp: first.hostIp, refreshedOnly: true });
    expect(await queryRuleFilters(exec, 'susentorno-test Envoy Proxy (VM inbound)')).toHaveLength(
      1,
    );
    expect(await queryRuleFilters(exec, 'susentorno-test DNS stub (VM inbound)')).toHaveLength(1);
    expect(await queryRuleFilters(exec, 'susentorno-test DHCP (VM inbound)')).toHaveLength(1);
    expect(await queryRuleFilters(exec, 'susentorno-test share (VM inbound)')).toHaveLength(2);
  });

  it('resolves the created switch to a real address and netmask through resolveIsolationNetwork', async () => {
    const subnet = findFreeSubnet(detectTakenRanges())!;
    await createHostNetwork({
      exec,
      isolationName: ISOLATION_NAME,
      subnet,
      natAdapterAlias: NAT_ADAPTER_ALIAS,
      homedir: homedir(),
      promptSubnet: async () => subnet,
    });

    // The only place the alias-to-real-adapter mapping is exercised against
    // Windows rather than a fixture — and the only check that the netmask
    // run-hosting hands to DHCP is the switch's real one, not a guessed /24.
    expect(resolveIsolationNetwork(ISOLATION_NAME)).toEqual({
      found: true,
      adapterAlias: ADAPTER_ALIAS,
      address: `192.168.${subnet}.1`,
      netmask: '255.255.255.0',
    });
  });

  it('delete removes the switch and every associated rule, and is idempotent on rerun', async () => {
    const subnet = findFreeSubnet(detectTakenRanges())!;
    await createHostNetwork({
      exec,
      isolationName: ISOLATION_NAME,
      subnet,
      natAdapterAlias: NAT_ADAPTER_ALIAS,
      homedir: homedir(),
      promptSubnet: async () => subnet,
    });

    const result = await deleteHostNetwork({
      exec,
      isolationName: ISOLATION_NAME,
      homedir: homedir(),
    });
    expect(result.switchRemoved).toBe(true);
    expect(result.interfaceSweep.removed).toBeGreaterThan(0);
    expect(result.interfaceSweep.failed).toBe(0);
    expect(result.namedSweep.removed).toBeGreaterThan(0);
    expect(result.namedSweep.failed).toBe(0);

    const switchResult = await exec.run(buildGetVmSwitchCommand(SWITCH_NAME));
    expect(parseVmSwitchExistsExact(switchResult.stdout, SWITCH_NAME)).toBe(false);
    expect(await queryRuleFilters(exec, 'susentorno-test Envoy Proxy (VM inbound)')).toHaveLength(
      0,
    );
    expect(await queryRuleFilters(exec, 'susentorno-test DNS stub (VM inbound)')).toHaveLength(0);
    expect(await queryRuleFilters(exec, 'susentorno-test DHCP (VM inbound)')).toHaveLength(0);
    expect(await queryRuleFilters(exec, 'susentorno-test share (VM inbound)')).toHaveLength(0);

    const rerun = await deleteHostNetwork({
      exec,
      isolationName: ISOLATION_NAME,
      homedir: homedir(),
    });
    expect(rerun).toEqual({
      interfaceSweep: { removed: 0, failed: 0 },
      queryUserSweep: { removed: 0, failed: 0 },
      namedSweep: { removed: 0, failed: 0 },
      switchRemoved: false,
    });
  });
});
