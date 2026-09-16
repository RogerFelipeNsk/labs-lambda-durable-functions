import { useEffect, useState } from "react";
import { api } from "../cliente.js";
import { PAPEIS, ROTULOS, TOM, capitalizar, dataHora, emReais } from "../dominio.js";
import PainelCaos from "./PainelCaos.jsx";
import PainelDecisao from "./PainelDecisao.jsx";
import Pipeline from "./Pipeline.jsx";
import Timeline from "./Timeline.jsx";

export default function DetalheSolicitacao({ solicitacao, eventos, aoFalhar }) {
  const [execucao, setExecucao] = useState(null);

  // Troca de solicitacao: descarta o que estava na gaveta da execucao anterior.
  useEffect(() => setExecucao(null), [solicitacao.id]);

  async function inspecionarExecucao() {
    try {
      setExecucao(await api.execucao(solicitacao.id));
    } catch (erro) {
      aoFalhar(erro.message);
    }
  }

  // Ha uma decisao pendente por papel que tenha callback aberto e ainda sem
  // decisao — em regime paralelo (gestor + financeiro), dois paineis podem
  // aparecer ao mesmo tempo. Ver o comentario em PainelDecisao.jsx sobre por
  // que isso e checado pelos campos por papel, nao pelo `status` unico.
  const papeisPendentes = PAPEIS.filter((p) => {
    const Papel = capitalizar(p.valor);
    return solicitacao[`callbackId${Papel}`] && !solicitacao[`decisao${Papel}`];
  });

  return (
    <div className="detalhe">
      <div className="cartao topo-detalhe">
        <div className="titulo-detalhe">
          <div>
            <h2>{solicitacao.solicitante}</h2>
            <p className="descricao">{solicitacao.descricao ?? "sem descrição"}</p>
          </div>
          <div className="valor-grande">
            {emReais(solicitacao.valorCentavos)}
            <span className={`badge ${TOM[solicitacao.status] ?? "neutro"}`}>
              {ROTULOS[solicitacao.status] ?? solicitacao.status}
            </span>
          </div>
        </div>

        <Pipeline status={solicitacao.status} stage={solicitacao.stage} />

        <div className="acoes">
          <button type="button" onClick={inspecionarExecucao}>
            Consultar execução na AWS
          </button>
        </div>
      </div>

      {papeisPendentes.map((p) => (
        <PainelDecisao
          key={p.valor}
          solicitacao={solicitacao}
          papel={p.valor}
          titulo={p.titulo}
          permiteFalhaTecnica={p.valor === "financeiro"}
          aoFalhar={aoFalhar}
        />
      ))}

      <div className="painel-duplo">
        <div className="cartao dados">
          <h3>Dados da solicitação</h3>
          <dl>
            <Linha rotulo="Solicitado em" valor={dataHora(solicitacao.createdAt)} />
            <Linha rotulo="Exige financeiro" valor={solicitacao.precisaFinanceiro ? "Sim" : "Não"} />
            {solicitacao.decisaoGestor && (
              <Linha
                rotulo="Gestor"
                valor={`${solicitacao.decisaoGestor} — ${solicitacao.aprovadorGestor ?? "—"}${solicitacao.comentarioGestor ? ` (${solicitacao.comentarioGestor})` : ""}`}
                destaque={solicitacao.decisaoGestor === "rejeitado"}
              />
            )}
            {solicitacao.decisaoDiretoria && (
              <Linha
                rotulo="Diretoria"
                valor={`${solicitacao.decisaoDiretoria} — ${solicitacao.aprovadorDiretoria ?? "—"}${solicitacao.comentarioDiretoria ? ` (${solicitacao.comentarioDiretoria})` : ""}`}
                destaque={solicitacao.decisaoDiretoria === "rejeitado"}
              />
            )}
            {solicitacao.decisaoFinanceiro && (
              <Linha
                rotulo="Financeiro"
                valor={`${solicitacao.decisaoFinanceiro} — ${solicitacao.aprovadorFinanceiro ?? "—"}${solicitacao.comentarioFinanceiro ? ` (${solicitacao.comentarioFinanceiro})` : ""}`}
                destaque={solicitacao.decisaoFinanceiro === "rejeitado"}
              />
            )}
            <Linha rotulo="Comprovante" valor={solicitacao.comprovante} mono />
            <Linha rotulo="Pago em" valor={dataHora(solicitacao.executadoEm)} />
            {solicitacao.erro && <Linha rotulo="Erro" valor={solicitacao.erro} destaque />}
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

        <PainelCaos solicitacao={solicitacao} aoFalhar={aoFalhar} />
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
