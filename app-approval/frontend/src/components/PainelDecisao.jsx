import { useState } from "react";
import { api } from "../cliente.js";
import { capitalizar } from "../dominio.js";

/**
 * Painel de decisao para um papel (gestor/diretoria/financeiro).
 *
 * So aparece quando ESTE papel tem um callback aberto e ainda sem decisao.
 * Repare que a checagem e pelos campos `callbackId<Papel>`/`decisao<Papel>`,
 * nao pelo `status` da solicitacao — quando gestor e financeiro decidem em
 * paralelo (`ctx.parallel`), os dois ramos escrevem no mesmo item e o
 * `status` unico so reflete a escrita mais recente de QUALQUER um dos dois.
 * Os campos por papel sao a fonte da verdade sobre "o que EU ainda posso
 * decidir agora".
 *
 * O clique em Aprovar/Rejeitar/Reportar indisponibilidade E a resolucao do
 * `waitForCallback` suspenso do lado da durable function — nao existe
 * simulacao de webhook externo aqui, o humano decidindo NESTA tela e o
 * proprio evento que a execucao esta esperando.
 */
export default function PainelDecisao({ solicitacao, papel, titulo, permiteFalhaTecnica, aoFalhar }) {
  const [aprovador, setAprovador] = useState("");
  const [comentario, setComentario] = useState("");
  const [ocupado, setOcupado] = useState(false);

  const Papel = capitalizar(papel);
  const callbackId = solicitacao[`callbackId${Papel}`];
  const decisaoTomada = solicitacao[`decisao${Papel}`];

  if (!callbackId || decisaoTomada) return null;

  async function decidir(decisao) {
    setOcupado(true);
    try {
      await api.decidir(solicitacao.id, papel, decisao, {
        aprovador: aprovador.trim() || titulo,
        comentario: comentario.trim() || undefined,
      });
    } catch (erro) {
      aoFalhar(erro.message);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="cartao decisao-pendente">
      <h3>Decisão pendente — {titulo}</h3>
      <p className="decisao-explica">
        A execução está suspensa em <code>waitForCallback</code> aguardando esta decisão. Nenhuma
        Lambda está de pé e nada está sendo cobrado enquanto isso.
      </p>

      <div className="decisao-campos">
        <label>
          Seu nome
          <input value={aprovador} onChange={(e) => setAprovador(e.target.value)} placeholder={titulo} />
        </label>
        <label>
          Comentário (opcional)
          <input value={comentario} onChange={(e) => setComentario(e.target.value)} />
        </label>
      </div>

      <div className="botoes">
        <button type="button" className="primario" disabled={ocupado} onClick={() => decidir("aprovado")}>
          Aprovar
        </button>
        <button type="button" className="perigo" disabled={ocupado} onClick={() => decidir("rejeitado")}>
          Rejeitar
        </button>
        {permiteFalhaTecnica && (
          <button type="button" disabled={ocupado} onClick={() => decidir("falha-tecnica")}>
            Reportar indisponibilidade
          </button>
        )}
      </div>
    </div>
  );
}
