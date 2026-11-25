import { render, screen, within } from "@testing-library/react";
import {
  buildReceipt,
  Ed25519Signer,
  type ReceiptBody,
  type SignedReceipt,
  signReceipt,
} from "@vegaforge/tollway-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock next/navigation before the component is imported.
const pushMock = vi.fn();
const mockSearchParams = vi.hoisted(() => {
  let params = new URLSearchParams();
  return {
    get: (k: string) => params.get(k),
    _set: (p: URLSearchParams) => {
      params = p;
    },
  };
});

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  usePathname: () => "/receipts",
  useRouter: () => ({ push: pushMock }),
}));

const useReceiptsMock = vi.hoisted(() => vi.fn());

vi.mock("@/data/use-receipts", () => ({
  useReceipts: useReceiptsMock,
}));

import { ReceiptsView } from "./receipts-view";

let signer: Ed25519Signer;
let keySet: { source: string; keys: Record<string, Uint8Array> };

beforeAll(async () => {
  signer = await Ed25519Signer.generate("test-key");
  keySet = { source: "/.well-known/tollway-keys.json", keys: { [signer.keyId]: signer.publicKey } };
});

async function makeReceipt(
  overrides: Partial<Omit<ReceiptBody, "version">> = {},
): Promise<SignedReceipt> {
  const body = buildReceipt({
    id: overrides.id ?? "rcpt-1",
    issuedAt: overrides.issuedAt ?? "2026-06-29T12:00:00.000Z",
    payer: overrides.payer ?? "GPAYER0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZAAAAAAAAAAAA",
    payee: overrides.payee ?? "GPAYEE0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZAAAAAAAAAAAA",
    amount: overrides.amount ?? "10000",
    asset: overrides.asset ?? "USDC:GA5Z",
    resource: overrides.resource ?? "/quotes/latest",
    model: overrides.model ?? "x402",
    settlement: overrides.settlement ?? { kind: "transaction", txHash: "abc123" },
    network: overrides.network ?? "testnet",
  });
  return signReceipt(body, signer);
}

function readyState(rows: SignedReceipt[]) {
  return {
    status: "ready" as const,
    page: { rows, nextCursor: null },
    keySet,
  };
}

afterEach(() => {
  useReceiptsMock.mockReset();
  pushMock.mockReset();
  mockSearchParams._set(new URLSearchParams());
});

describe("ReceiptsView", () => {
  it("renders the skeleton while loading", () => {
    useReceiptsMock.mockReturnValue({ status: "loading" });

    render(<ReceiptsView />);

    expect(screen.getByTestId("receipts-skeleton")).toBeInTheDocument();
  });

  it("renders an error surface when the data source rejects", () => {
    useReceiptsMock.mockReturnValue({
      status: "error",
      error: new Error("archive offline"),
    });

    render(<ReceiptsView />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/could not load receipts/i);
    expect(alert).toHaveTextContent(/archive offline/i);
  });

  it("renders the empty message when there are no rows and no filters", () => {
    useReceiptsMock.mockReturnValue(readyState([]));

    render(<ReceiptsView />);

    expect(screen.getByText(/no receipts yet/i)).toBeInTheDocument();
  });

  it("renders an EmptyState naming the active filters when no rows match", async () => {
    mockSearchParams._set(new URLSearchParams({ model: "x402" }));
    useReceiptsMock.mockReturnValue(readyState([]));

    render(<ReceiptsView />);

    expect(screen.getByTestId("receipts-empty-filtered")).toBeInTheDocument();
    expect(screen.getByText(/no receipts match these filters/i)).toBeInTheDocument();
    expect(screen.getByText(/model x402/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear filters/i })).toBeInTheDocument();
  });

  it("renders a row per receipt with payer, payee, amount, model, and settlement", async () => {
    const rows = [
      await makeReceipt({ id: "rcpt-a", model: "x402" }),
      await makeReceipt({
        id: "rcpt-b",
        model: "mpp-channel",
        settlement: { kind: "channel-commitment", channelId: "ch-anth-02", sequence: 7 },
      }),
    ];
    useReceiptsMock.mockReturnValue(readyState(rows));

    render(<ReceiptsView />);

    expect(screen.getByTestId("receipt-row-rcpt-a")).toBeInTheDocument();
    expect(screen.getByTestId("receipt-row-rcpt-b")).toBeInTheDocument();

    const channelRow = screen.getByTestId("receipt-row-rcpt-b");
    expect(within(channelRow).getByText(/MPP channel/i)).toBeInTheDocument();
    expect(within(channelRow).getByText(/ch-anth-02 · seq 7/i)).toBeInTheDocument();
  });

  it("shows a hint inviting the user to select a row when none is selected", async () => {
    useReceiptsMock.mockReturnValue(readyState([await makeReceipt()]));

    render(<ReceiptsView />);

    expect(screen.getByText(/select a row to expand/i)).toBeInTheDocument();
  });

  it("verifies the signature of a selected receipt and marks it valid", async () => {
    const receipt = await makeReceipt({ id: "rcpt-valid" });
    useReceiptsMock.mockReturnValue(readyState([receipt]));

    render(<ReceiptsView />);
    screen.getByTestId("receipt-row-rcpt-valid").click();

    expect(await screen.findByTestId("receipt-verification-valid")).toBeInTheDocument();
    expect(screen.getByTestId("receipt-detail-rcpt-valid")).toBeInTheDocument();
  });

  it("states the key set source in the detail panel after verification", async () => {
    const receipt = await makeReceipt({ id: "rcpt-keyset" });
    useReceiptsMock.mockReturnValue(readyState([receipt]));

    render(<ReceiptsView />);
    screen.getByTestId("receipt-row-rcpt-keyset").click();

    await screen.findByTestId("receipt-verification-valid");
    expect(screen.getByTestId("receipt-detail-rcpt-keyset")).toHaveTextContent(
      "/.well-known/tollway-keys.json",
    );
  });

  it("marks the signature as invalid when the receipt has been tampered with", async () => {
    const receipt = await makeReceipt({ id: "rcpt-tampered" });
    const tampered: SignedReceipt = {
      ...receipt,
      receipt: { ...receipt.receipt, amount: "99999999999" },
    };
    useReceiptsMock.mockReturnValue(readyState([tampered]));

    render(<ReceiptsView />);
    screen.getByTestId("receipt-row-rcpt-tampered").click();

    expect(await screen.findByTestId("receipt-verification-invalid")).toBeInTheDocument();
  });

  it("shows 'Unknown signing key' when the receipt keyId is not in the trusted set", async () => {
    const receipt = await makeReceipt({ id: "rcpt-unknown-key" });
    const unknownKeySet = { source: "/.well-known/tollway-keys.json", keys: {} };
    useReceiptsMock.mockReturnValue({
      status: "ready" as const,
      page: { rows: [receipt], nextCursor: null },
      keySet: unknownKeySet,
    });

    render(<ReceiptsView />);
    screen.getByTestId("receipt-row-rcpt-unknown-key").click();

    expect(await screen.findByTestId("receipt-verification-unknown-key")).toBeInTheDocument();
    expect(screen.queryByTestId("receipt-verification-invalid")).not.toBeInTheDocument();
  });

  it("links channel receipts to their channel detail page", async () => {
    const receipt = await makeReceipt({
      id: "rcpt-channel",
      model: "mpp-channel",
      settlement: { kind: "channel-commitment", channelId: "ch-openai-03", sequence: 12 },
    });
    useReceiptsMock.mockReturnValue(readyState([receipt]));

    render(<ReceiptsView />);
    screen.getByTestId("receipt-row-rcpt-channel").click();

    const link = await screen.findByTestId("receipt-channel-link");
    expect(link).toHaveAttribute("href", "/channels/ch-openai-03");
    expect(link).toHaveTextContent("ch-openai-03");
  });

  it("does not render a channel link for x402 receipts", async () => {
    const receipt = await makeReceipt({ id: "rcpt-x402", model: "x402" });
    useReceiptsMock.mockReturnValue(readyState([receipt]));

    render(<ReceiptsView />);
    screen.getByTestId("receipt-row-rcpt-x402").click();

    await screen.findByTestId("receipt-detail-rcpt-x402");
    expect(screen.queryByTestId("receipt-channel-link")).not.toBeInTheDocument();
  });

  it("toggles the detail panel off when the same row is clicked twice", async () => {
    const receipt = await makeReceipt({ id: "rcpt-toggle" });
    useReceiptsMock.mockReturnValue(readyState([receipt]));

    render(<ReceiptsView />);
    const row = screen.getByTestId("receipt-row-rcpt-toggle");
    row.click();
    expect(await screen.findByTestId("receipt-detail-rcpt-toggle")).toBeInTheDocument();
    row.click();
    expect(await screen.findByText(/select a row to expand/i)).toBeInTheDocument();
    expect(screen.queryByTestId("receipt-detail-rcpt-toggle")).not.toBeInTheDocument();
  });

  it("shows the v2 fields of a v2 receipt", async () => {
    const receipt = await signReceipt(
      buildReceipt({
        id: "rcpt-v2",
        issuedAt: "2026-06-29T12:00:00.000Z",
        payer: "GPAYER0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZAAAAAAAAAAAA",
        payee: "GPAYEE0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZAAAAAAAAAAAA",
        amount: "10000",
        asset: "USDC:GA5Z",
        resource: "/quotes/latest",
        model: "x402",
        settlement: { kind: "transaction", txHash: "abc123" },
        network: "testnet",
        offerHash: "offer-hash-value",
        method: "POST",
      }),
      signer,
    );
    useReceiptsMock.mockReturnValue(readyState([receipt]));

    render(<ReceiptsView />);
    screen.getByTestId("receipt-row-rcpt-v2").click();

    const detail = await screen.findByTestId("receipt-detail-rcpt-v2");
    expect(within(detail).getByText("offer-hash-value")).toBeInTheDocument();
    expect(within(detail).getByText("POST")).toBeInTheDocument();
    expect(within(detail).getByText("Never")).toBeInTheDocument();
  });

  it("shows copy and download buttons in the detail panel", async () => {
    const receipt = await makeReceipt({ id: "rcpt-actions" });
    useReceiptsMock.mockReturnValue(readyState([receipt]));

    render(<ReceiptsView />);
    screen.getByTestId("receipt-row-rcpt-actions").click();

    await screen.findByTestId("receipt-detail-rcpt-actions");
    expect(screen.getByTestId("receipt-copy-json")).toBeInTheDocument();
    expect(screen.getByTestId("receipt-download-json")).toHaveAttribute(
      "download",
      "receipt-rcpt-actions.json",
    );
  });

  it("renders the filter bar when no payee prop is provided", async () => {
    useReceiptsMock.mockReturnValue(readyState([]));

    render(<ReceiptsView />);

    expect(screen.getByTestId("receipts-filter-bar")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: /search receipts/i })).toBeInTheDocument();
  });

  it("hides the filter bar and shows the payee banner when a payee prop is provided", async () => {
    useReceiptsMock.mockReturnValue(readyState([]));

    render(<ReceiptsView payee="GPAYEE-STRIPE" />);

    expect(screen.queryByTestId("receipts-filter-bar")).not.toBeInTheDocument();
    expect(screen.getByTestId("receipts-payee-filter")).toHaveTextContent("GPAYEE-STRIPE");
  });

  it("pushes a URL update when a filter changes", async () => {
    useReceiptsMock.mockReturnValue(readyState([]));

    render(<ReceiptsView />);

    const modelSelect = screen.getByRole("combobox", { name: /model/i });
    // Use fireEvent to change the select value.
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(modelSelect, { target: { value: "x402" } });

    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining("model=x402"));
  });

  it("renders Older/Newer pagination buttons", async () => {
    const receipt = await makeReceipt({ id: "rcpt-page" });
    useReceiptsMock.mockReturnValue({
      status: "ready" as const,
      page: { rows: [receipt], nextCursor: "rcpt-page" },
      keySet,
    });

    render(<ReceiptsView />);

    expect(screen.getByRole("button", { name: /older/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /newer/i })).toBeDisabled();
  });
});
