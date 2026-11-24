import type { ServiceSummary } from "@/data/services";
import { formatMicros, modelMix, totalMicros } from "@/data/services-summary";

export function ServicesTable({ services }: { services: ServiceSummary[] }) {
  if (services.length === 0) {
    return <p>No services have recorded traffic yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          Per-service revenue per payee, settlement model mix, and average latency per model
        </caption>
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Total revenue</th>
            <th scope="col">Revenue per payee</th>
            <th scope="col">Settlement mix</th>
            <th scope="col">Avg latency per model</th>
          </tr>
        </thead>
        <tbody>
          {services.map((s) => {
            const mix = modelMix(s.models);
            return (
              <tr key={s.serviceId}>
                <th scope="row">{s.serviceName}</th>
                <td>{formatMicros(totalMicros(s))}</td>
                <td>
                  {s.payees.length === 0 ? (
                    "—"
                  ) : (
                    <ul>
                      {s.payees.map((p) => (
                        <li key={p.payeeId}>
                          {p.payeeName}: {formatMicros(p.revenueMicros)}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>
                  {mix.length === 0 ? (
                    "—"
                  ) : (
                    <ul>
                      {mix.map((m) => (
                        <li key={m.model}>
                          {m.model}: {m.percent}%
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>
                  {s.models.length === 0 ? (
                    "—"
                  ) : (
                    <ul>
                      {s.models.map((m) => (
                        <li key={m.model}>
                          {m.model}: {m.avgLatencyMs} ms
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
