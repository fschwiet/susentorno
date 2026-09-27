import { checkElevated } from '../checkElevated';
import { checkHypervAvailable } from '../checkHypervAvailable';
import type { Prerequisite } from '../prerequisites';

export const hostNetworkPrerequisites: readonly Prerequisite[] = [
  { name: 'elevated shell', check: checkElevated },
  { name: 'Hyper-V available', check: checkHypervAvailable },
];
