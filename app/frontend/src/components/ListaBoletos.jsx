import { ROTULOS, TOM, emReais, hora } from "../dominio.js";

export default function ListaBoletos({ boletos, selecionado, aoSelecionar }) {
  if (!boletos.length) {
    return (
      <div className="cartao lista vazia-lista">
        <h2>Cobranças</h2>
        <p>Nada emitido ainda.</p>
      </div>
    );
  }

  return (
    <div className="cartao lista">
      <h2>
        Cobranças <span className="contador">{boletos.length}</span>
      </h2>
      <ul>
        {boletos.map((boleto) => (
          <li key={boleto.id}>
            <button
              type="button"
              className={boleto.id === selecionado ? "item ativo" : "item"}
              onClick={() => aoSelecionar(boleto.id)}
            >
              <span className="item-topo">
                <strong>{boleto.sacado}</strong>
                <span className="valor">{emReais(boleto.valorCentavos)}</span>
              </span>
              <span className="item-baixo">
                <span className={`badge ${TOM[boleto.status] ?? "neutro"}`}>
                  {ROTULOS[boleto.status] ?? boleto.status}
                </span>
                <span className="instante">{hora(boleto.updatedAt ?? boleto.createdAt)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
