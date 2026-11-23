/** The one error shape every route returns. */
export type ApiErrorBody = {
  error: {
    /** Stable code, for example "unauthorized" or "range-too-large". */
    code: string;
    message: string;
    /** Field-level details for a validation failure. */
    details?: string[];
    /** Set when a request was refused for exceeding a configured limit. */
    limit?: { name: string; value: number };
  };
};

export function apiError(
  code: string,
  message: string,
  extra?: Pick<ApiErrorBody["error"], "details" | "limit">,
): ApiErrorBody {
  return { error: { code, message, ...(extra ?? {}) } };
}
