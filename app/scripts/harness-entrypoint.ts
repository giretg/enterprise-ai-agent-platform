import { runHarnessEntrypoint } from '../src/harness/job-entrypoint'

runHarnessEntrypoint()
  .then((result) => {
    if (result.status === 'failed') process.exitCode = 1
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
