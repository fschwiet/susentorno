import { checkElevated } from './checkElevated';

export default async function setup() {
  await checkElevated();
}
