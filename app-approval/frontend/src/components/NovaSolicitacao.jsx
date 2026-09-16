import { useState } from "react";
import { api } from "../cliente.js";

const SOLICITANTES = ["Ana Paula Ferreira", "Bruno Cardoso Lima", "Camila Ribeiro Souza", "Diego Martins Alves"];

export default function NovaSolicitacao({ aoSolicitar, aoFalhar, aoSelecionar }) {
  const [solicitante, setSolicitante] = useState(SOLICITANTES[0]);
  const [descricao, setDescricao] = useState("Licenças de software anual");
  const [valor, setValor] = useState("450,00");
  const [enviando, setEnviando] = useState(false);

  async function enviar(evento) {
    evento.preventDefault();
    const centavos = Math.round(Number(valor.replace(/\./g, "").replace(",", ".")) * 100);
    if (!Number.isInteger(centavos) || centavos <= 0) {
      aoFalhar("Informe um valor válido, por exemplo 450,00");
      return;
    }

    setEnviando(true);
    try {
      const { solicitacao } = await api.solicitar({ solicitante, descricao, valorCentavos: centavos });
      aoSolicitar(solicitacao);
      aoSelecionar(solicitacao.id);
    } catch (erro) {
      aoFalhar(`Não foi possível solicitar: ${erro.message}`);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form className="cartao emitir" onSubmit={enviar}>
      <h2>Nova solicitação</h2>

      <label>
        Solicitante
        <input value={solicitante} onChange={(e) => setSolicitante(e.target.value)} list="solicitantes" required />
        <datalist id="solicitantes">
          {SOLICITANTES.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </label>

      <label>
        Descrição
        <input value={descricao} onChange={(e) => setDescricao(e.target.value)} />
      </label>

      <label>
        Valor
        <input value={valor} onChange={(e) => setValor(e.target.value)} inputMode="decimal" required />
      </label>

      <button type="submit" className="primario" disabled={enviando}>
        {enviando ? "Enviando…" : "Solicitar e iniciar execução"}
      </button>

      <p className="rodape-cartao">
        Abaixo de R$ 300 a aprovação é automática. Acima disso, o gestor decide; sem resposta em
        24h, escala para a diretoria. Acima de R$ 5.000, o financeiro decide em paralelo com o
        gestor — os dois precisam aprovar.
      </p>
    </form>
  );
}
