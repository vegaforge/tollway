import { getServices, parseSummarizeBody, SummarizeBodyError } from "../../../lib/services";

/**
 * Paid: 0.005 USDC per summary. The body is checked on a clone before the
 * gate, so a malformed request is refused without charging the agent, and
 * the original body stays unread for the paid handler.
 */
export async function POST(request: Request): Promise<Response> {
  const { routes } = await getServices();
  try {
    parseSummarizeBody(await request.clone().json());
  } catch (error) {
    if (error instanceof SummarizeBodyError || error instanceof SyntaxError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  return routes.summarize(request);
}
