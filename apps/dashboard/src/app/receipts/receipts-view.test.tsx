import { render, screen, within } from "@testing-library/react";
import {
  buildReceipt,
  Ed25519Signer,
  type ReceiptBody,
  type SignedReceipt,
  signReceipt,
} from "@tollway/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const useReceiptsMock = vi.hoisted(() => vi.fn());

vi.mock("@/data/use-receipts", () => ({
  useReceipts: useReceiptsMock,
}));

import { ReceiptsView } from "./receipts-view";

let signer: Ed25519Signer;
let trustedKeys: Record<string, Uint8Array>;

beforeAll(async () => {
  signer = await Ed25519Signer.generate("test-key");
  trustedKeys = { [signer.keyId]: signer.publicKey };
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

afterEach(() => {
  useReceiptsMock.mockReset();
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

  it("renders the empty message when there are no rows", () => {
    useReceiptsMock.mockReturnValue({ status: "ready", rows: [], trustedKeys: {} });

    render(<ReceiptsView />);

    expect(screen.getByText(/no receipts yet/i)).toBeInTheDocument();
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
    useReceiptsMock.mockReturnValue({ status: "ready", rows, trustedKeys });

    render(<ReceiptsView />);

    expect(screen.getByTestId("receipt-row-rcpt-a")).toBeInTheDocument();
    expect(screen.getByTestId("receipt-row-rcpt-b")).toBeInTheDocument();

    const channelRow = screen.getByTestId("receipt-row-rcpt-b");
    expect(within(channelRow).getByText(/MPP channel/i)).toBeInTheDocument();
    expect(within(channelRow).getByText(/ch-anth-02 · seq 7/i)).toBeInTheDocument();
  });

  it("shows a hint inviting the user to select a row when none is selected", async () => {
    useReceiptsMock.mockReturnValue({
      status: "ready",
      rows: [await makeReceipt()],
      trustedKeys,
    });

    render(<ReceiptsView />);

    expect(screen.getByText(/select a row to expand/i)).toBeInTheDocument();
  });

  it("verifies the signature of a selected receipt and marks it valid", async () => {
    const receipt = await makeReceipt({ id: "rcpt-valid" });
    useReceiptsMock.mockReturnValue({ status: "ready", rows: [receipt], trustedKeys });

    render(<ReceiptsView />);
    screen.getByTestId("receipt-row-rcpt-valid").click();

    expect(await screen.findByTestId("receipt-verification-valid")).toBeInTheDocument();
    expect(screen.getByTestId("receipt-detail-rcpt-valid")).toBeInTheDocument();
  });

  it("marks the signature as invalid when the receipt has been tampered with", async () => {
    const receipt = await makeReceipt({ id: "rcpt-tampered" });
    // Mutate the body after signing so the signature no longer covers
    // canonical bytes of the current shape.
    const tampered: SignedReceipt = {
      ...receipt,
      receipt: { ...receipt.receipt, amount: "99999999999" },
    };
    useReceiptsMock.mockReturnValue({ status: "ready", rows: [tampered], trustedKeys });

    render(<ReceiptsView />);
    screen.getByTestId("receipt-row-rcpt-tampered").click();

    expect(await screen.findByTestId("receipt-verification-invalid")).toBeInTheDocument();
  });

  it("links channel receipts to their channel via the channels view row anchor", async () => {
    const receipt = await makeReceipt({
      id: "rcpt-channel",
      model: "mpp-channel",
      settlement: { kind: "channel-commitment", channelId: "ch-openai-03", sequence: 12 },
    });
    useReceiptsMock.mockReturnValue({ status: "ready", rows: [receipt], trustedKeys });

    render(<ReceiptsView />);
    screen.getByTestId("receipt-row-rcpt-channel").click();

    const link = await screen.findByTestId("receipt-channel-link");
    expect(link).toHaveAttribute("href", "/channels#channel-row-ch-openai-03");
    expect(link).toHaveTextContent("ch-openai-03");
  });

  it("does not render a channel link for x402 receipts", async () => {
    const receipt = await makeReceipt({ id: "rcpt-x402", model: "x402" });
    useReceiptsMock.mockReturnValue({ status: "ready", rows: [receipt], trustedKeys });

    render(<ReceiptsView />);
    screen.getByTestId("receipt-row-rcpt-x402").click();

    await screen.findByTestId("receipt-detail-rcpt-x402");
    expect(screen.queryByTestId("receipt-channel-link")).not.toBeInTheDocument();
  });

  it("toggles the detail panel off when the same row is clicked twice", async () => {
    const receipt = await makeReceipt({ id: "rcpt-toggle" });
    useReceiptsMock.mockReturnValue({ status: "ready", rows: [receipt], trustedKeys });

    render(<ReceiptsView />);
    const row = screen.getByTestId("receipt-row-rcpt-toggle");
    row.click();
    expect(await screen.findByTestId("receipt-detail-rcpt-toggle")).toBeInTheDocument();
    row.click();
    // Wait for the unselected hint to reappear so the assertion races neither
    // the pending verification effect from the first selection nor React's
    // batching of the toggle state update.
    expect(await screen.findByText(/select a row to expand/i)).toBeInTheDocument();
    expect(screen.queryByTestId("receipt-detail-rcpt-toggle")).not.toBeInTheDocument();
  });
});
