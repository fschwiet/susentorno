import { checkElevated } from '../checkElevated';
import type { Prerequisite } from '../prerequisites';

export const hostNetworkPrerequisites: readonly Prerequisite[] = [
  { name: 'elevated shell', check: checkElevated },
];
