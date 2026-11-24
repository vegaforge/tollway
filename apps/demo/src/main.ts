import { reportFailure, runCli } from "./run-cli.js";
import { runAllModels } from "./scenarios/all-models.js";

const output = { log: console.log, error: console.error };

runCli(process.argv.slice(2), { env: process.env, output, runAllModels })
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    reportFailure(error, output);
    process.exitCode = 1;
  });
