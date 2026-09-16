import { ROTULOS, TOM, emReais, hora } from "../dominio.js";

export default function ListaSolicitacoes({ solicitacoes, selecionado, aoSelecionar }) {
  if (!solicitacoes.length) {
    return (
      <div className="cartao lista vazia-lista">
        <h2>Solicitações</h2>
        <p>Nada solicitado ainda.</p>
      </div>
    );
  }

  return (
    <div className="cartao lista">
      <h2>
        Solicitações <span className="contador">{solicitacoes.length}</span>
      </h2>
      <ul>
        {solicitacoes.map((solicitacao) => (
          <li key={solicitacao.id}>
            <button
              type="button"
              className={solicitacao.id === selecionado ? "item ativo" : "item"}
              onClick={() => aoSelecionar(solicitacao.id)}
            >
              <span className="item-topo">
                <strong>{solicitacao.solicitante}</strong>
                <span className="valor">{emReais(solicitacao.valorCentavos)}</span>
              </span>
              <span className="item-baixo">
                <span className={`badge ${TOM[solicitacao.status] ?? "neutro"}`}>
                  {ROTULOS[solicitacao.status] ?? solicitacao.status}
                </span>
                <span className="instante">{hora(solicitacao.updatedAt ?? solicitacao.createdAt)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
