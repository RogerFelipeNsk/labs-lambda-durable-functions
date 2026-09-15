import { useEffect, useState } from "react";
import { api } from "../cliente.js";
import { ROTULOS, TOM, dataHora, emReais } from "../dominio.js";
import PainelCaos from "./PainelCaos.jsx";
import Pipeline from "./Pipeline.jsx";
import Timeline from "./Timeline.jsx";

export default function DetalheBoleto({ boleto, eventos, aoFalhar }) {
  const [pagando, setPagando] = useState(false);
  const [execucao, setExecucao] = useState(null);

  // Troca de boleto: descarta o que estava na gaveta da execucao anterior.
  useEffect(() => setExecucao(null), [boleto.id]);

  const podePagar = Boolean(boleto.callbackId) && !boleto.pagoEm;

  async function registrarPagamento() {
    setPagando(true);
    try {
      await api.pagar(boleto.id, { canal: "PIX" });
    } catch (erro) {
      aoFalhar(erro.message);
    } finally {
      setPagando(false);
    }
  }

  async function inspecionarExecucao() {
    try {
      setExecucao(await api.execucao(boleto.id));
    } catch (erro) {
      aoFalhar(erro.message);
    }
  }

  return (
    <div className="detalhe">
      <div className="cartao topo-detalhe">
        <div className="titulo-detalhe">
          <div>
            <h2>{boleto.sacado}</h2>
            <p className="descricao">{boleto.descricao ?? "sem descrição"}</p>
          </div>
          <div className="valor-grande">
            {emReais(boleto.valorCentavos)}
            <span className={`badge ${TOM[boleto.status] ?? "neutro"}`}>
              {ROTULOS[boleto.status] ?? boleto.status}
            </span>
          </div>
        </div>

        <Pipeline status={boleto.status} stage={boleto.stage} />

        <div className="acoes">
          <button
            type="button"
            className="primario"
            disabled={!podePagar || pagando}
            onClick={registrarPagamento}
            title={
              podePagar
                ? "Resolve o callback e acorda a execução suspensa"
                : boleto.pagoEm
                  ? "Este boleto já foi pago"
                  : "A execução ainda não registrou o callback"
            }
          >
            {pagando ? "Enviando…" : "Registrar pagamento (webhook do banco)"}
          </button>
          <button type="button" onClick={inspecionarExecucao}>
            Consultar execução na AWS
          </button>
        </div>

        {boleto.callbackId && !boleto.pagoEm && (
          <p className="dica">
            A execução está suspensa em <code>waitForCallback</code>. Nenhuma Lambda está de pé e
            nada está sendo cobrado. O botão acima chama{" "}
            <code>SendDurableExecutionCallbackSuccess</code> com o id{" "}
            <code>{boleto.callbackId.slice(0, 24)}…</code>, e é isso que faz a AWS reinvocar a
            função, reproduzir os checkpoints e continuar de onde parou.
          </p>
        )}
      </div>

      <div className="painel-duplo">
        <div className="cartao dados">
          <h3>Dados da cobrança</h3>
          <dl>
            <Linha rotulo="Nosso número" valor={boleto.nossoNumero} mono />
            <Linha rotulo="Linha digitável" valor={boleto.linhaDigitavel} mono />
            <Linha rotulo="Emitido em" valor={dataHora(boleto.createdAt)} />
            <Linha rotulo="Pago em" valor={dataHora(boleto.pagoEm)} />
            <Linha rotulo="Comprovante de baixa" valor={boleto.comprovanteBaixa} mono />
            <Linha rotulo="Extrato" valor={boleto.extratoId} mono />
            <Linha rotulo="Tarifa" valor={emReais(boleto.tarifaCentavos)} />
            <Linha rotulo="Líquido creditado" valor={emReais(boleto.valorLiquidoCentavos)} />
            <Linha rotulo="Conciliação" valor={boleto.conciliacaoId} mono />
            {typeof boleto.divergenciaCentavos === "number" && (
              <Linha
                rotulo="Divergência"
                valor={emReais(boleto.divergenciaCentavos)}
                destaque={boleto.divergenciaCentavos !== 0}
              />
            )}
            {boleto.erro && <Linha rotulo="Erro" valor={boleto.erro} destaque />}
          </dl>

          {execucao && (
            <div className="execucao">
              <h4>GetDurableExecution</h4>
              <p className="execucao-nota">
                Esta é a visão da AWS sobre a execução, independente da nossa tabela.
              </p>
              <pre>{JSON.stringify(execucao, null, 2)}</pre>
            </div>
          )}
        </div>

        <PainelCaos boleto={boleto} aoFalhar={aoFalhar} />
      </div>

      <div className="cartao timeline-cartao">
        <h3>
          Linha do tempo <span className="contador">{eventos.length}</span>
        </h3>
        <Timeline eventos={eventos} />
      </div>
    </div>
  );
}

function Linha({ rotulo, valor, mono, destaque }) {
  return (
    <>
      <dt>{rotulo}</dt>
      <dd className={`${mono ? "mono" : ""} ${destaque ? "destaque" : ""}`}>{valor || "—"}</dd>
    </>
  );
}
