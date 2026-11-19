import { getServices } from "../../../lib/services";

/** Paid: 0.001 USDC per quote. */
export async function GET(request: Request): Promise<Response> {
  const { routes } = await getServices();
  return routes.quote(request);
}
