import { checkDockerRunning } from '../checkDockerRunning';

export default async function setup() {
  await checkDockerRunning();
}
