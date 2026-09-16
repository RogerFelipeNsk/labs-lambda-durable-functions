import { hora } from "../dominio.js";

export default function Timeline({ eventos }) {
  if (!eventos.length) {
    return <p className="timeline-vazia">Nenhum evento ainda. Os próximos chegam por subscription.</p>;
  }

  return (
    <ol className="timeline">
      {eventos.map((evento) => {
        const extra = evento.data ? JSON.parse(evento.data) : null;
        return (
          <li key={evento.seq} className={`evento ${evento.level.toLowerCase()}`}>
            <span className="evento-hora">{hora(evento.at)}</span>
            <span className="evento-corpo">
              <span className="evento-cabecalho">
                <span className="etiqueta-etapa">{evento.stage}</span>
                {evento.attempt > 1 && <span className="etiqueta-retry">tentativa {evento.attempt}</span>}
                {typeof evento.durationMs === "number" && (
                  <span className="etiqueta-duracao">{(evento.durationMs / 1000).toFixed(1)}s</span>
                )}
              </span>
              <span className="evento-mensagem">{evento.message}</span>
              {extra && <pre className="evento-dados">{JSON.stringify(extra, null, 2)}</pre>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
