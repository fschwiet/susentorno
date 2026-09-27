import { checkDockerComposeAvailable } from '../checkDockerComposeAvailable';
import { checkDockerRunning } from '../checkDockerRunning';
import { checkNoRunningProxy } from '../checkNoRunningProxy';
import { checkNodeNotFirewallBlocked } from '../checkNodeNotFirewallBlocked';
import type { Prerequisite } from '../prerequisites';

// Cheap host-side checks first, matching the guest suite: Docker Desktop down or
// a live run-hosting fighting this suite for the Envoy containers are the most
// common self-inflicted failures. The proxy-stack suite runs `docker compose
// down` on the same stack, so a live run-hosting is left serving :80/:443 with
// no backend — the real VM silently loses egress. Fail fast instead.
//
// A stale Windows Firewall Block rule on this node.exe (see
// checkNodeNotFirewallBlocked.ts) breaks mockUpstream.ts's 0.0.0.0 listener
// silently, at the network layer — no in-process error to catch, so this has
// to be checked proactively rather than surfaced by a failing bind().
export const proxyStackPrerequisites: readonly Prerequisite[] = [
  { name: 'Docker running', check: checkDockerRunning },
  { name: 'Docker Compose available', check: checkDockerComposeAvailable },
  { name: 'no running proxy', check: checkNoRunningProxy },
  { name: 'node.exe not blocked by Windows Firewall', check: checkNodeNotFirewallBlocked },
];
