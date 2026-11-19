export default function Home() {
  return (
    <main>
      <h1>Tollway Next.js paid API</h1>
      <p>Every paid route answers 402 with a PAYMENT-REQUIRED challenge until it is paid.</p>
      <ul>
        <li>
          <code>GET /api/quote</code>: 0.001 USDC
        </li>
        <li>
          <code>POST /api/summarize</code> with <code>{'{ "text": "..." }'}</code>: 0.005 USDC
        </li>
        <li>
          <code>GET /api/receipt-key</code>: free, the public key receipts verify against
        </li>
      </ul>
    </main>
  );
}
