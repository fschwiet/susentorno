import { runPrerequisites } from '../prerequisites';
import { hostNetworkPrerequisites } from './prerequisites';

export default async function setup() {
  await runPrerequisites(hostNetworkPrerequisites);
}
