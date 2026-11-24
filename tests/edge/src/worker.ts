import { runScenario } from "./scenario.ts";

/** The Workers entry: each request runs the scenario and answers its results. */
export default {
  async fetch(): Promise<Response> {
    return Response.json(await runScenario());
  },
};
