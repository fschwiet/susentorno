import { runPrerequisites } from '../prerequisites';
import { proxyStackPrerequisites } from './prerequisites';

export default async function setup() {
  await runPrerequisites(proxyStackPrerequisites);
}
