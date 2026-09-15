import { useState } from "react";
import { api } from "../cliente.js";

const SACADOS = ["Padaria do Jonas ME", "Transportes Aurora LTDA", "Clínica Vida Plena", "Oficina Barros"];

export default function EmitirBoleto({ aoEmitir, aoFalhar, aoSelecionar }) {
  const [sacado, setSacado] = useState(SACADOS[0]);
  const [descricao, setDescricao] = useState("Mensalidade de serviço");
  const [valor, setValor] = useState("1.250,00");
  const [enviando, setEnviando] = useState(false);

  async function enviar(evento) {
    evento.preventDefault();
    const centavos = Math.round(Number(valor.replace(/\./g, "").replace(",", ".")) * 100);
    if (!Number.isInteger(centavos) || centavos <= 0) {
      aoFalhar("Informe um valor válido, por exemplo 1.250,00");
      return;
    }

    setEnviando(true);
    try {
      const { boleto } = await api.emitir({ sacado, descricao, valorCentavos: centavos });
      aoEmitir(boleto);
      aoSelecionar(boleto.id);
    } catch (erro) {
      aoFalhar(`Não foi possível emitir: ${erro.message}`);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form className="cartao emitir" onSubmit={enviar}>
      <h2>Emitir cobrança</h2>

      <label>
        Sacado
        <input value={sacado} onChange={(e) => setSacado(e.target.value)} list="sacados" required />
        <datalist id="sacados">
          {SACADOS.map((s) => (
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
        {enviando ? "Emitindo…" : "Emitir e iniciar execução"}
      </button>

      <p className="rodape-cartao">
        O POST cria o boleto e chama <code>Invoke</code> com <code>DurableExecutionName</code> igual
        ao id — o que dá idempotência de graça: reenviar o mesmo pedido não abre uma segunda execução.
      </p>
    </form>
  );
}
