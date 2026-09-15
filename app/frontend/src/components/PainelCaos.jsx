import { useState } from "react";
import { api } from "../cliente.js";
import { MODOS_CAOS } from "../dominio.js";

/**
 * Painel de caos: arma uma falha no proximo step relevante.
 *
 * Nao e enfeite. Cada modo existe para tornar visivel uma garantia especifica
 * do durable execution que so aparece quando algo da errado.
 */
export default function PainelCaos({ boleto, aoFalhar }) {
  const [modo, setModo] = useState(MODOS_CAOS[0].valor);
  const [vezes, setVezes] = useState(2);
  const [ocupado, setOcupado] = useState(false);

  const escolhido = MODOS_CAOS.find((m) => m.valor === modo);
  const armado = boleto.chaos && boleto.chaosRestante > 0;

  async function executar(acao) {
    setOcupado(true);
    try {
      await acao();
    } catch (erro) {
      aoFalhar(erro.message);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="cartao caos">
      <h3>Laboratório de caos</h3>

      {armado && (
        <p className="caos-armado">
          Armado: <code>{boleto.chaos}</code> · {boleto.chaosRestante}× restante
        </p>
      )}

      <label>
        Modo
        <select value={modo} onChange={(e) => setModo(e.target.value)}>
          {MODOS_CAOS.map((m) => (
            <option key={m.valor} value={m.valor}>
              {m.titulo}
            </option>
          ))}
        </select>
      </label>

      <p className="caos-explica">{escolhido.explica}</p>

      <label className="inline">
        Falhar
        <input
          type="number"
          min="1"
          max="5"
          value={vezes}
          onChange={(e) => setVezes(Number(e.target.value))}
        />
        vez(es) antes de passar
      </label>

      <div className="botoes">
        <button
          type="button"
          disabled={ocupado}
          onClick={() => executar(() => api.armarCaos(boleto.id, modo, vezes))}
        >
          Armar
        </button>
        <button
          type="button"
          disabled={ocupado || !armado}
          onClick={() => executar(() => api.armarCaos(boleto.id, "nenhum", 0))}
        >
          Desarmar
        </button>
        <button
          type="button"
          className="perigo"
          disabled={ocupado}
          onClick={() => executar(() => api.parar(boleto.id))}
        >
          StopDurableExecution
        </button>
      </div>
    </div>
  );
}
